/**
 * Seamless auto-update manager for Kip desktop.
 *
 * Fetches signed `latest.json` + `latest.json.sig` directly from GitHub
 * Releases CDN (no API rate limit), verifies RFC 8032 Ed25519 signatures via
 * `node:crypto` and streamed SHA-256 digests via `Bun.CryptoHasher`, persists
 * an atomic one-shot `update-handoff.json` before exit, and hands off
 * post-exit atomic `.app` replacement (preserving local macOS signing
 * identities such as `abcdlsj Local Dev`) to a detached helper script.
 */
import { spawn } from "node:child_process";
import { createPublicKey, type KeyObject, verify as cryptoVerify } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  UpdateHandoffAppState,
  UpdateHandoffPayload,
  UpdatePhase,
  UpdateStatus,
} from "../shared/types";

export const APP_SLUG = "kip";
export const REPO_SLUG = "abcdlsj/kip";
export const EXPECTED_BUNDLE_ID = "ai.kip.desktop";
export const EXPECTED_BUNDLE_NAME = "Kip.app";
export const UPDATE_PUBKEY_B64 = "xdgYDRv31ErEseN4jODPrTKqDZ9d3g7uWWycF4sUjHw=";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const INITIAL_CHECK_DELAY_MS = 18_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANUAL_CHECK_COOLDOWN_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_MANIFEST_BYTES = 1 << 20; // 1 MiB
const MAX_ASSET_BYTES = 512 << 20; // 512 MiB
export const HANDOFF_TTL_MS = 120_000; // 2 minutes

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export interface PlatformAsset {
  url: string;
  signature: string;
  sha256: string;
  size: number;
  format?: string;
  bundle_name?: string;
  bundle_id?: string;
  min_os?: string;
}

interface ReleaseManifest {
  schema_version: number;
  app: string;
  version: string;
  release_url?: string;
  notes?: string;
  platforms: Record<string, PlatformAsset>;
}

interface SelectedRelease {
  version: string;
  platformKey: string;
  asset: PlatformAsset;
}

interface StagedUpdate {
  version: string;
  stageDir: string;
  stagedApp: string;
}

export interface UpdateManagerOptions {
  appVersion: string;
  dataDir: string;
  cacheDir: string;
  isDev?: boolean;
  onStatus?: (status: UpdateStatus) => void;
  onQuit?: () => void;
  fetchImpl?: typeof fetch;
  /** Test seam: inspect a specific executable path instead of `process.execPath`. */
  execPath?: string;
}

export function defaultUpdateCacheDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", EXPECTED_BUNDLE_ID);
  }
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, EXPECTED_BUNDLE_ID);
  }
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, EXPECTED_BUNDLE_ID);
}

/** Parses "0.2.18", "v0.2.18", "0.2.18-rc.1", "0.2.18+build", or "0.2". */
export function parseSemver(raw: string): Semver | null {
  let s = raw.trim();
  if (s.startsWith("v")) s = s.slice(1);
  const cut = s.search(/[-+]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (!s) return null;
  const parts = s.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  return {
    major: nums[0] as number,
    minor: nums[1] as number,
    patch: nums[2] ?? 0,
  };
}

export function formatSemver(ver: Semver): string {
  return `${ver.major}.${ver.minor}.${ver.patch}`;
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function isNewerSemver(latest: Semver, current: Semver): boolean {
  return compareSemver(latest, current) > 0;
}

export function canonicalAssetPayload(
  app: string,
  version: string,
  platform: string,
  sha256Hex: string,
  size: number,
): string {
  return `v1:${app}:${version}:${platform}:${sha256Hex}:${size}`;
}

/** Wraps a 32-byte raw Ed25519 public key (base64) in RFC 8410 SPKI DER. */
export function decodeVerifyingKey(pubkeyB64: string): KeyObject {
  const trimmed = pubkeyB64.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    throw new Error("decode public key base64: invalid base64");
  }
  const raw = Buffer.from(trimmed, "base64");
  if (raw.length !== 32) {
    throw new Error("public key must be 32 bytes");
  }
  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: spkiDer, format: "der", type: "spki" });
}

export function verifyEd25519B64(
  publicKey: KeyObject,
  message: Uint8Array,
  sigB64: string,
): void {
  const trimmed = sigB64.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    throw new Error("decode signature base64: invalid base64");
  }
  const sigBuf = Buffer.from(trimmed, "base64");
  if (sigBuf.length !== 64) {
    throw new Error("signature must be 64 bytes");
  }
  const ok = cryptoVerify(null, Buffer.from(message), publicKey, sigBuf);
  if (!ok) {
    throw new Error("signature mismatch");
  }
}

export function validateDownloadUrl(
  url: string,
  allowLocalhost: boolean,
): void {
  if (
    allowLocalhost &&
    (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:"))
  ) {
    return;
  }
  const allowedPrefixes = [
    `https://github.com/${REPO_SLUG}/`,
    "https://objects.githubusercontent.com/",
    "https://release-assets.githubusercontent.com/",
  ];
  if (allowedPrefixes.some((prefix) => url.startsWith(prefix))) {
    return;
  }
  throw new Error(`refusing untrusted update URL: ${url}`);
}

export function resolvePlatformAsset(
  platforms: Record<string, PlatformAsset>,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { platformKey: string; asset: PlatformAsset } | null {
  let candidates: string[] = [];
  if (platform === "darwin" && arch === "arm64") {
    candidates = ["darwin-aarch64", "darwin-universal"];
  } else if (platform === "darwin" && arch === "x64") {
    candidates = ["darwin-x86_64", "darwin-universal"];
  } else if (platform === "win32" && arch === "x64") {
    candidates = ["windows-x86_64"];
  } else if (platform === "win32" && arch === "arm64") {
    candidates = ["windows-aarch64", "windows-x86_64"];
  }
  for (const key of candidates) {
    const asset = platforms[key];
    if (asset) return { platformKey: key, asset };
  }
  return null;
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Checks whether `execPath` lives inside a writable macOS `.app` bundle
 * (`<parent>/<Name>.app/Contents/MacOS/<binary>`). Rejects mounted DMGs
 * (`/Volumes/`), App Translocation paths, and read-only parent directories.
 */
export function inspectAppBundlePath(execPath: string): {
  appPath: string | null;
  selfUpdatable: boolean;
} {
  const resolved = safeRealpath(execPath);
  const macosDir = dirname(resolved);
  const contentsDir = dirname(macosDir);
  const appDir = dirname(contentsDir);
  const isLayout =
    basename(macosDir) === "MacOS" &&
    basename(contentsDir) === "Contents" &&
    basename(appDir).endsWith(".app");
  if (!isLayout) {
    return { appPath: null, selfUpdatable: false };
  }
  if (
    appDir.startsWith("/Volumes/") ||
    appDir.includes("AppTranslocation")
  ) {
    return { appPath: null, selfUpdatable: false };
  }
  const parent = dirname(appDir);
  const probe = join(
    parent,
    `.kip-update-probe-${process.pid}-${Date.now()}`,
  );
  try {
    const fd = openSync(probe, "wx", 0o600);
    closeSync(fd);
    unlinkSync(probe);
    return { appPath: appDir, selfUpdatable: true };
  } catch {
    return { appPath: appDir, selfUpdatable: false };
  }
}

function detectSelfAppBundle(execPath: string = process.execPath): {
  appPath: string | null;
  selfUpdatable: boolean;
} {
  if (process.platform !== "darwin") {
    return { appPath: null, selfUpdatable: false };
  }
  return inspectAppBundlePath(execPath);
}

/** Atomically writes `update-handoff.json` with mode 0600 + fsync + rename. */
export function writeHandoffFile(
  handoffPath: string,
  payload: UpdateHandoffPayload,
): void {
  mkdirSync(dirname(handoffPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  const tmpPath = `${handoffPath}.tmp`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Best-effort on non-POSIX filesystems.
    }
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, handoffPath);
}

/**
 * Atomically consumes `update-handoff.json` once on startup.
 * Renames and deletes before returning so a restore bug can never crash-loop.
 */
export function consumeHandoffFile(
  handoffPath: string,
  nowMs: number = Date.now(),
): UpdateHandoffPayload | null {
  if (!existsSync(handoffPath)) return null;
  const consuming = `${handoffPath}.consuming`;
  try {
    renameSync(handoffPath, consuming);
  } catch {
    rmSync(handoffPath, { force: true });
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(consuming, "utf8");
  } catch {
    rmSync(consuming, { force: true });
    return null;
  }
  rmSync(consuming, { force: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as UpdateHandoffPayload;
  if (
    payload.schema_version !== 1 ||
    typeof payload.created_at_ms !== "number" ||
    typeof payload.ttl_ms !== "number" ||
    Math.max(0, nowMs - payload.created_at_ms) > payload.ttl_ms
  ) {
    return null;
  }
  return payload;
}

function cleanupStaleStaging(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;
  const cutoff = Date.now() - 3600 * 1000;
  try {
    for (const entry of readdirSync(cacheDir)) {
      const fullPath = join(cacheDir, entry);
      try {
        const st = statSync(fullPath);
        if (st.mtimeMs < cutoff) {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore racing cleanup errors.
      }
    }
  } catch {
    // Ignore unreadable cache directory.
  }
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error("response exceeds maximum allowed size");
    }
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response exceeds maximum allowed size");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function runExec(command: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`${command[0]} failed: ${detail}`);
  }
  return { stdout, stderr };
}

async function extractAndVerifyBundle(
  archivePath: string,
  stageDir: string,
  format: string,
  bundleName: string,
  expectedBundleId: string,
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic in-place self-update is currently supported on macOS");
  }
  const extractDir = join(stageDir, "extracted");
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });

  if (format === "app-tar-gz") {
    await runExec(["/usr/bin/tar", "-xzf", archivePath, "-C", extractDir]);
  } else {
    await runExec(["/usr/bin/ditto", "-x", "-k", archivePath, extractDir]);
  }

  const stagedApp = join(extractDir, bundleName);
  if (!existsSync(stagedApp) || !statSync(stagedApp).isDirectory()) {
    throw new Error(`extracted archive missing ${bundleName}`);
  }

  const plistPath = join(stagedApp, "Contents", "Info.plist");
  const { stdout: plistOut } = await runExec([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleIdentifier",
    plistPath,
  ]);
  const actualId = plistOut.trim();
  if (actualId !== expectedBundleId) {
    throw new Error(
      `staged bundle ID mismatch (got '${actualId}', expected '${expectedBundleId}')`,
    );
  }

  await runExec(["/usr/bin/codesign", "--verify", "--deep", "--strict", stagedApp]);
  return stagedApp;
}

/**
 * Detached post-exit macOS updater helper.
 * Preserves local signing identities (e.g. `abcdlsj Local Dev`) when replacing
 * with an ad-hoc release, swaps `.app` atomically via dual-`mv` with rollback,
 * cleans up staging, and relaunches via `/usr/bin/open`.
 */
export const MACOS_APPLY_SCRIPT = `#!/bin/sh
set -eu

OLD_PID="$1"
TARGET_APP="$2"
STAGED_APP="$3"
STAGE_DIR="$4"
EXPECTED_BUNDLE_ID="$5"
LOG_FILE="$STAGE_DIR/apply.log"
exec >>"$LOG_FILE" 2>&1

echo "[updater] start pid=$OLD_PID target=$TARGET_APP"

KEYCHAIN="\${HOME}/Library/Keychains/login.keychain-db"
PRESERVE_ID=""
CUR_AUTH=$(/usr/bin/codesign -dvv "$TARGET_APP" 2>&1 | /usr/bin/sed -n 's/^Authority=//p' | /usr/bin/head -n 1 || true)
NEW_SIG_INFO=$(/usr/bin/codesign -dvv "$STAGED_APP" 2>&1 || true)
if [ -n "$CUR_AUTH" ] && printf '%s\\n' "$NEW_SIG_INFO" | /usr/bin/grep -q '^Signature=adhoc'; then
  if /usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | /usr/bin/grep -Fq "\\"\${CUR_AUTH}\\""; then
    PRESERVE_ID="$CUR_AUTH"
  fi
fi

STAGED_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$STAGED_APP/Contents/Info.plist" 2>/dev/null || true)
if [ "$STAGED_ID" != "$EXPECTED_BUNDLE_ID" ]; then
  echo "[updater] bundle id mismatch: got=$STAGED_ID want=$EXPECTED_BUNDLE_ID"
  exit 1
fi

i=0
while /bin/kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    echo "[updater] timed out waiting for old pid $OLD_PID"
    exit 1
  fi
  /bin/sleep 0.1
done

/usr/bin/xattr -dr com.apple.quarantine "$STAGED_APP" 2>/dev/null || true
if [ -n "$PRESERVE_ID" ]; then
  echo "[updater] preserving local signing identity: $PRESERVE_ID"
  if [ -d "$STAGED_APP/Contents/Frameworks" ]; then
    /usr/bin/find "$STAGED_APP/Contents/Frameworks" -maxdepth 1 -name '*.dylib' -print0 \\
      | /usr/bin/xargs -0 -I{} /usr/bin/codesign --force --keychain "$KEYCHAIN" --sign "$PRESERVE_ID" "{}"
  fi
  /usr/bin/codesign --force --deep --keychain "$KEYCHAIN" --sign "$PRESERVE_ID" "$STAGED_APP"
fi
/usr/bin/codesign --verify --deep --strict "$STAGED_APP"

PARENT_DIR=$(/usr/bin/dirname "$TARGET_APP")
APP_NAME=$(/usr/bin/basename "$TARGET_APP")
NEW_TMP="$PARENT_DIR/.\${APP_NAME}.new.$$"
OLD_TMP="$PARENT_DIR/.\${APP_NAME}.old.$$"

/usr/bin/ditto "$STAGED_APP" "$NEW_TMP"

if ! /bin/mv "$TARGET_APP" "$OLD_TMP"; then
  /bin/rm -rf "$NEW_TMP"
  exit 1
fi

if ! /bin/mv "$NEW_TMP" "$TARGET_APP"; then
  /bin/mv "$OLD_TMP" "$TARGET_APP" || true
  /bin/rm -rf "$NEW_TMP"
  exit 1
fi

/bin/rm -rf "$OLD_TMP" "$STAGE_DIR" || true
/usr/bin/open "$TARGET_APP"
`;

function spawnDetachedApplyHelper(
  oldPid: number,
  targetApp: string,
  stagedApp: string,
  stageDir: string,
  expectedBundleId: string,
): void {
  if (process.platform !== "darwin") {
    throw new Error("Automatic in-place self-update is currently supported on macOS");
  }
  const scriptPath = join(stageDir, "apply.sh");
  writeFileSync(scriptPath, MACOS_APPLY_SCRIPT, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);

  const helper = spawn(
    "/bin/sh",
    [
      scriptPath,
      String(oldPid),
      targetApp,
      stagedApp,
      stageDir,
      expectedBundleId,
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  helper.unref();
}

export class UpdateManager {
  private readonly currentRaw: string;
  private readonly currentVer: Semver | null;
  private readonly manifestUrl: string;
  private readonly allowLocalhost: boolean;
  private readonly pubkey: KeyObject;
  private readonly cacheDir: string;
  private readonly handoffPath: string;
  private readonly targetApp: string | null;
  private readonly selfUpdatable: boolean;
  private readonly isDev: boolean;
  private readonly onStatus: ((status: UpdateStatus) => void) | undefined;
  private readonly onQuit: (() => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  private currentStatus: UpdateStatus;
  private etag: string | null = null;
  private lastCheckAt: number | null = null;
  private selected: SelectedRelease | null = null;
  private staged: StagedUpdate | null = null;
  private startupHandoff: UpdateHandoffPayload | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: UpdateManagerOptions) {
    const envVersion = process.env.KIP_UPDATE_TEST_VERSION?.trim();
    this.currentRaw = envVersion || options.appVersion.trim();
    this.currentVer = parseSemver(this.currentRaw);
    const displayVer = this.currentVer
      ? formatSemver(this.currentVer)
      : this.currentRaw;

    const customUrl = process.env.KIP_UPDATE_MANIFEST_URL?.trim();
    if (customUrl) {
      this.manifestUrl = customUrl;
      this.allowLocalhost = true;
    } else {
      this.manifestUrl = `https://github.com/${REPO_SLUG}/releases/latest/download/latest.json`;
      this.allowLocalhost = false;
    }

    const pubkeyB64 =
      process.env.KIP_UPDATE_TEST_PUBKEY?.trim() || UPDATE_PUBKEY_B64;
    this.pubkey = decodeVerifyingKey(pubkeyB64);

    const detected = detectSelfAppBundle(options.execPath);
    this.targetApp = detected.appPath;
    this.selfUpdatable = detected.selfUpdatable;
    this.isDev = options.isDev ?? false;
    this.onStatus = options.onStatus;
    this.onQuit = options.onQuit;
    this.fetchImpl = options.fetchImpl ?? fetch;

    this.handoffPath = join(options.dataDir, "update-handoff.json");
    this.cacheDir = join(options.cacheDir, "updates");

    // One-shot startup consume prevents restore bugs from causing crash loops.
    this.startupHandoff = consumeHandoffFile(this.handoffPath);
    cleanupStaleStaging(this.cacheDir);

    this.currentStatus = {
      current: displayVer,
      latest: null,
      available: false,
      state: "idle",
      progress: 0,
      can_apply: false,
      release_url: null,
      notes: null,
      error: null,
    };
  }

  status(): UpdateStatus {
    return { ...this.currentStatus };
  }

  takeStartupHandoff(): UpdateHandoffPayload | null {
    const payload = this.startupHandoff;
    this.startupHandoff = null;
    return payload;
  }

  startBackground(): void {
    if (this.started || !this.currentVer) return;
    if (
      this.isDev &&
      !process.env.KIP_UPDATE_MANIFEST_URL &&
      !process.env.KIP_UPDATE_TEST_VERSION
    ) {
      return;
    }
    this.started = true;
    const schedule = (delayMs: number): void => {
      this.timer = setTimeout(() => {
        void this.check(false).finally(() => {
          if (this.started) schedule(CHECK_INTERVAL_MS);
        });
      }, delayMs);
    };
    schedule(INITIAL_CHECK_DELAY_MS);
  }

  stopBackground(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async checkManual(): Promise<UpdateStatus> {
    if (
      this.lastCheckAt !== null &&
      Date.now() - this.lastCheckAt < MANUAL_CHECK_COOLDOWN_MS
    ) {
      return this.status();
    }
    return this.check(true);
  }

  async check(manual: boolean): Promise<UpdateStatus> {
    if (!this.currentVer) return this.status();

    const busyStates: UpdatePhase[] = [
      "checking",
      "downloading",
      "verifying",
      "ready_to_restart",
      "flushing",
      "installing",
    ];
    if (busyStates.includes(this.currentStatus.state)) {
      return this.status();
    }

    const prevState = this.currentStatus.state;
    const etag = manual ? null : this.etag;
    this.publish({
      state: "checking",
      ...(manual ? { error: null } : {}),
    });

    try {
      const fetched = await this.fetchVerifiedManifest(etag);
      if (this.currentStatus.state !== "checking") {
        return this.status();
      }
      if (fetched === null) {
        // 304 Not Modified
        this.lastCheckAt = Date.now();
        this.publish({ state: prevState });
        return this.status();
      }

      const { manifest, etag: nextEtag } = fetched;
      this.lastCheckAt = Date.now();
      if (nextEtag) this.etag = nextEtag;

      const latestVer = parseSemver(manifest.version);
      if (latestVer && isNewerSemver(latestVer, this.currentVer)) {
        const versionStr = formatSemver(latestVer);
        const releaseUrl =
          manifest.release_url ??
          `https://github.com/${REPO_SLUG}/releases/tag/v${versionStr}`;
        const resolved = resolvePlatformAsset(manifest.platforms);

        if (resolved) {
          this.selected = {
            version: versionStr,
            platformKey: resolved.platformKey,
            asset: resolved.asset,
          };
          this.publish({
            latest: versionStr,
            available: true,
            state: "available",
            progress: 0,
            can_apply: this.selfUpdatable,
            release_url: releaseUrl,
            notes: manifest.notes ?? null,
            error: null,
          });
        } else {
          this.selected = null;
          this.publish({
            latest: versionStr,
            available: true,
            state: "available",
            progress: 0,
            can_apply: false,
            release_url: releaseUrl,
            notes: manifest.notes ?? null,
            error: null,
          });
        }
      } else {
        this.selected = null;
        this.staged = null;
        this.publish({
          latest: manifest.version,
          available: false,
          state: "idle",
          progress: 0,
          can_apply: false,
          error: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.currentStatus.state === "checking") {
        // Background checks stay completely silent; manual checks surface the error.
        this.publish({
          state: prevState,
          ...(manual ? { error: message } : {}),
        });
      }
    }
    return this.status();
  }

  async startDownload(): Promise<UpdateStatus> {
    const inProgress: UpdatePhase[] = [
      "downloading",
      "verifying",
      "ready_to_restart",
      "flushing",
      "installing",
    ];
    if (inProgress.includes(this.currentStatus.state)) {
      return this.status();
    }
    if (!this.currentStatus.available) {
      throw new Error("No update available");
    }
    if (!this.currentStatus.can_apply) {
      throw new Error("Automatic install is unavailable for this installation");
    }
    const selected = this.selected;
    if (!selected) {
      throw new Error("No matching platform asset found");
    }

    this.publish({
      state: "downloading",
      progress: 0,
      error: null,
    });

    void this.runDownloadAndStage(selected).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({
        state: "error",
        progress: 0,
        error: message,
      });
    });

    return this.status();
  }

  async commitRestart(
    appState: UpdateHandoffAppState,
  ): Promise<{ started: boolean }> {
    if (!this.staged) {
      throw new Error("No verified staged update ready to install");
    }
    if (!this.targetApp) {
      throw new Error("Target app bundle path unavailable");
    }

    const staged = this.staged;
    const targetApp = this.targetApp;
    const fromVersion = this.currentStatus.current;

    this.publish({
      state: "installing",
      progress: 100,
      error: null,
    });

    const handoff: UpdateHandoffPayload = {
      schema_version: 1,
      from_version: fromVersion,
      to_version: staged.version,
      created_at_ms: Date.now(),
      ttl_ms: HANDOFF_TTL_MS,
      app_state: appState ?? {},
    };
    writeHandoffFile(this.handoffPath, handoff);

    spawnDetachedApplyHelper(
      process.pid,
      targetApp,
      staged.stagedApp,
      staged.stageDir,
      EXPECTED_BUNDLE_ID,
    );

    // Let the RPC reply flush to the webview before clean shutdown + exit.
    if (this.onQuit) {
      setTimeout(this.onQuit, 150);
    }
    return { started: true };
  }

  private async runDownloadAndStage(selected: SelectedRelease): Promise<void> {
    validateDownloadUrl(selected.asset.url, this.allowLocalhost);
    if (selected.asset.size <= 0 || selected.asset.size > MAX_ASSET_BYTES) {
      throw new Error("Release asset size out of allowed bounds");
    }

    const stageDir = join(this.cacheDir, selected.version);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });

    const archivePath = join(stageDir, "update.archive");
    try {
      const { sha256: gotSha256, size: gotSize } = await this.downloadFile(
        selected.asset.url,
        archivePath,
        selected.asset.size,
      );

      this.publish({ state: "verifying", progress: 100 });

      if (gotSize !== selected.asset.size) {
        throw new Error(
          `Archive size mismatch (got ${gotSize}, expected ${selected.asset.size})`,
        );
      }
      if (gotSha256.toLowerCase() !== selected.asset.sha256.toLowerCase()) {
        throw new Error("Archive SHA-256 checksum mismatch");
      }

      const canonical = canonicalAssetPayload(
        APP_SLUG,
        selected.version,
        selected.platformKey,
        gotSha256,
        gotSize,
      );
      verifyEd25519B64(
        this.pubkey,
        new TextEncoder().encode(canonical),
        selected.asset.signature,
      );

      const bundleName = selected.asset.bundle_name || EXPECTED_BUNDLE_NAME;
      const bundleId = selected.asset.bundle_id || EXPECTED_BUNDLE_ID;
      if (bundleId !== EXPECTED_BUNDLE_ID) {
        throw new Error("Manifest bundle ID does not match Kip");
      }

      const stagedApp = await extractAndVerifyBundle(
        archivePath,
        stageDir,
        selected.asset.format || "app-zip",
        bundleName,
        bundleId,
      );

      this.staged = {
        version: selected.version,
        stageDir,
        stagedApp,
      };
      this.publish({
        state: "ready_to_restart",
        progress: 100,
        error: null,
      });
    } catch (error) {
      rmSync(stageDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async fetchVerifiedManifest(
    etag: string | null,
  ): Promise<{ manifest: ReleaseManifest; etag: string | null } | null> {
    validateDownloadUrl(this.manifestUrl, this.allowLocalhost);

    const headers: Record<string, string> = {
      "User-Agent": `Kip/${this.currentRaw}`,
      Accept: "application/json",
    };
    if (etag) headers["If-None-Match"] = etag;

    const resp = await this.fetchImpl(this.manifestUrl, {
      headers,
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (resp.status === 304) return null;
    if (!resp.ok) {
      throw new Error(`manifest returned HTTP ${resp.status}`);
    }

    const newEtag = resp.headers.get("etag");
    const manifestBytes = await readBoundedBytes(resp, MAX_MANIFEST_BYTES);

    const sigUrl = `${this.manifestUrl}.sig`;
    validateDownloadUrl(sigUrl, this.allowLocalhost);
    const sigResp = await this.fetchImpl(sigUrl, {
      headers: { "User-Agent": `Kip/${this.currentRaw}` },
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!sigResp.ok) {
      throw new Error(`manifest signature returned HTTP ${sigResp.status}`);
    }
    const sigBytes = await readBoundedBytes(sigResp, 4096);
    const sigText = new TextDecoder().decode(sigBytes).trim();

    verifyEd25519B64(this.pubkey, manifestBytes, sigText);

    const parsed = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as ReleaseManifest;
    if (parsed.schema_version !== 1) {
      throw new Error(`unsupported manifest schema_version ${parsed.schema_version}`);
    }
    if (parsed.app !== APP_SLUG) {
      throw new Error(`manifest app mismatch: ${parsed.app}`);
    }
    if (!parsed.platforms || typeof parsed.platforms !== "object") {
      throw new Error("manifest missing platforms map");
    }
    return { manifest: parsed, etag: newEtag };
  }

  private async downloadFile(
    url: string,
    destPath: string,
    expectedSize: number,
  ): Promise<{ sha256: string; size: number }> {
    const resp = await this.fetchImpl(url, {
      headers: { "User-Agent": `Kip/${this.currentRaw}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`download returned HTTP ${resp.status}`);
    }

    const contentLength = Number(resp.headers.get("content-length")) || 0;
    const total = contentLength > 0 ? contentLength : expectedSize;

    const partPath = `${destPath}.part`;
    const fd = openSync(partPath, "w", 0o600);
    const hasher = new Bun.CryptoHasher("sha256");
    const reader = resp.body.getReader();
    let written = 0;
    let lastPct = -1;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > MAX_ASSET_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error("download exceeds maximum allowed size");
        }
        writeSync(fd, value);
        hasher.update(value);

        if (total > 0) {
          const pct = Math.min(99, Math.floor((written * 100) / total));
          if (pct !== lastPct) {
            lastPct = pct;
            if (this.currentStatus.state === "downloading") {
              this.publish({ progress: pct });
            }
          }
        }
      }
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      rmSync(partPath, { force: true });
      throw error;
    }
    closeSync(fd);
    renameSync(partPath, destPath);

    return {
      sha256: hasher.digest("hex"),
      size: written,
    };
  }

  private publish(patch: Partial<UpdateStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...patch };
    this.onStatus?.(this.status());
  }
}
