/**
 * The gemini2api sidecar: downloading it, pointing it at Firefox's session
 * cookies, running it on loopback, and stopping it.
 *
 * This is gemini2api's own business logic. Kip hands the plugin a writable
 * directory and an action channel; it does not know what a sidecar is.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getApiKey } from "../../storage/keychain";
import { readFirefoxCookies, type CookieJar } from "./vendor/cookies";

export const PROVIDER_ID = "gemini2api";
const DEFAULT_PORT = 8790;
const MANIFEST_URL =
  "https://github.com/abcdlsj/gemini2api/releases/latest/download/manifest.json";
// Google may take tens of seconds to hand out a session on a cold start.
const START_TIMEOUT_MS = 90_000;
const LOG_LIMIT = 200;
/** Two seconds of retries: a process that was just asked to stop needs a moment. */
const PORT_ATTEMPTS = 8;
const PORT_RETRY_MS = 250;

export interface SidecarArtifact {
  file: string;
  url: string;
  sha256: string;
  size?: number;
}

export interface SidecarManifest {
  version: string;
  artifacts: Record<string, SidecarArtifact>;
}

export interface SidecarStatus {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  running: boolean;
  port: number | null;
  pid: number | null;
  health: HealthBody | null;
  lastError: string | null;
}

export interface HealthBody {
  server?: string;
  version?: string;
  key_required?: boolean;
  accounts?: Record<string, { signed_in?: boolean; status?: string }>;
  api?: { context_window?: number; supports_reasoning?: boolean };
  chats?: number;
}

interface Running {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  key: string;
  dataDir: string;
}

interface AdoptedPid {
  pid: number;
  port: number;
}

/** Healthy sidecar process spawned by this process. */
let running: Running | null = null;
/** Process currently booting (before `/health` answers). */
let spawning: Running | null = null;
let starting: Promise<{ baseUrl: string; port: number; key: string }> | null =
  null;
let lastError: string | null = null;
let logListener: (() => void) | null = null;
let exitListener: ((code: number | null) => void) | null = null;
const logs: string[] = [];

/** Notified only when a running Kip-owned sidecar exits unexpectedly (not via `stop()`). */
export function setExitListener(
  listener: ((code: number | null) => void) | null,
): void {
  exitListener = listener;
}

export function isStarting(): boolean {
  return starting !== null;
}

function pidFile(dataDir: string): string {
  return join(dataDir, "sidecar.pid");
}

function writePidFile(
  dataDir: string,
  pid: number,
  port: number,
  binary: string,
): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(pidFile(dataDir), JSON.stringify({ pid, port, binary }), {
      mode: 0o600,
    });
  } catch {
    // Best-effort metadata for adopting an orphaned sidecar after a crash.
  }
}

function removePidFile(dataDir: string): void {
  try {
    if (existsSync(pidFile(dataDir))) unlinkSync(pidFile(dataDir));
  } catch {
    // Best-effort cleanup.
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isGeminiProcess(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (res.exitCode !== 0) return false;
    return res.stdout.toString("utf8").toLowerCase().includes("gemini2api");
  } catch {
    return false;
  }
}

/**
 * Recognizes a Kip-owned sidecar that survived a previous app exit/crash, either
 * via `sidecar.pid` or by matching Kip's own installed binary path on POSIX.
 * Never claims a server the user started from a different binary/terminal.
 */
export function adoptedSidecar(
  dataDir: string,
  values: Record<string, string> = {},
): AdoptedPid | null {
  const file = pidFile(dataDir);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        pid?: number;
        port?: number;
      };
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.port === "number" &&
        isPidAlive(parsed.pid) &&
        isGeminiProcess(parsed.pid)
      ) {
        return { pid: parsed.pid, port: parsed.port };
      }
    } catch {
      // Corrupt pid file; clean it up below.
    }
    removePidFile(dataDir);
  }

  // Fallback for orphans spawned before `sidecar.pid` existed: match only the
  // exact binary inside Kip's own plugin data directory.
  if (process.platform !== "win32") {
    const ownBinary = installedBinary(dataDir);
    if (existsSync(ownBinary)) {
      try {
        const res = Bun.spawnSync(["pgrep", "-f", ownBinary], {
          stdout: "pipe",
          stderr: "ignore",
        });
        if (res.exitCode === 0) {
          const pids = res.stdout
            .toString("utf8")
            .split(/\s+/)
            .map((raw) => Number(raw))
            .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
          if (pids.length > 0) {
            // PyInstaller spawns a parent bootloader + child; pick the lowest PID
            // (the process group leader) so killing its group stops both.
            const leader = Math.min(...pids);
            return { pid: leader, port: preferredPort(values) };
          }
        }
      } catch {
        // pgrep unavailable; skip fallback.
      }
    }
  }
  return null;
}

/** The open page subscribes so new lines appear without pressing Refresh. */
export function setLogListener(listener: (() => void) | null): void {
  logListener = listener;
}

/** Also the channel the plugin uses to explain an idle pause in the same place. */
export function log(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  logs.push(stamped);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  try {
    logListener?.();
  } catch {
    // A broken listener must never break the process it is watching.
  }
}

export function readLogs(): string[] {
  return [...logs];
}

export function platformKey(): string {
  const os =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "win"
        : "linux";
  return `${os}-${process.arch}`;
}

export function binaryName(): string {
  return process.platform === "win32" ? "gemini2api.exe" : "gemini2api";
}

function binDir(dataDir: string): string {
  return join(dataDir, "bin");
}

export function installedBinary(dataDir: string): string {
  return join(binDir(dataDir), binaryName());
}

function versionFile(dataDir: string): string {
  return join(binDir(dataDir), "version");
}

function readInstalledVersion(dataDir: string): string | null {
  if (!existsSync(installedBinary(dataDir))) return null;
  try {
    return readFileSync(versionFile(dataDir), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function status(
  dataDir: string,
  values: Record<string, string> = {},
): SidecarStatus {
  const binary = resolveBinary(dataDir, values);
  const adopted = running ? null : adoptedSidecar(dataDir, values);
  const activePort = running?.port ?? adopted?.port ?? null;
  const activePid = running?.process.pid ?? adopted?.pid ?? null;
  return {
    installed: binary !== null,
    version: readInstalledVersion(dataDir),
    binaryPath: binary,
    running: running !== null || adopted !== null,
    port: activePort,
    pid: activePid,
    health: null,
    lastError,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "kip-gemini2api-plugin",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Downloads the artifact for this platform and verifies the published digest. */
export async function install(
  dataDir: string,
  values: Record<string, string>,
): Promise<{ path: string; version: string }> {
  lastError = null;
  const pinned = (values.sidecarVersion ?? "").trim();
  const manifest = await fetchJson<SidecarManifest>(MANIFEST_URL);
  if (pinned && manifest.version !== pinned) {
    log(
      `manifest is ${manifest.version}, pinned ${pinned}; using the manifest version`,
    );
  }
  const artifact = manifest.artifacts[platformKey()];
  if (!artifact) {
    throw new Error(
      `gemini2api ${manifest.version} has no build for ${platformKey()}`,
    );
  }
  if (!artifact.url.startsWith("https://")) {
    throw new Error(`Refusing non-HTTPS download URL: ${artifact.url}`);
  }
  log(`downloading ${artifact.file} (${manifest.version})`);
  const response = await fetch(artifact.url, {
    headers: { "user-agent": "kip-gemini2api-plugin" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok)
    throw new Error(`download answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== artifact.sha256.trim().toLowerCase()) {
    throw new Error(
      `checksum mismatch: expected ${artifact.sha256}, got ${digest}`,
    );
  }
  // Stop a running sidecar before swapping the binary: on Windows a running
  // executable cannot be overwritten, and elsewhere the version file would drift.
  if (running || adoptedSidecar(dataDir, values)) {
    await stop({ dataDir, includeAdopted: true });
  }
  mkdirSync(binDir(dataDir), { recursive: true, mode: 0o700 });
  const target = installedBinary(dataDir);
  const staging = `${target}.new`;
  try {
    writeFileSync(staging, bytes, { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(staging, 0o755);
    renameSync(staging, target);
  } catch (error) {
    try {
      if (existsSync(staging)) unlinkSync(staging);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
  writeFileSync(versionFile(dataDir), manifest.version, { mode: 0o600 });
  log(`installed ${manifest.version}`);
  return { path: target, version: manifest.version };
}

/** A binary the user points at (a local build) wins over a downloaded one. */
export function resolveBinary(
  dataDir: string,
  values: Record<string, string>,
): string | null {
  const manual = (values.binaryPath ?? "").trim();
  if (manual && existsSync(manual)) return manual;
  const installed = installedBinary(dataDir);
  return existsSync(installed) ? installed : null;
}

/**
 * The port the managed gateway should try first. The saved provider points at
 * it, so it has to stay stable. An empty field is not "port 0": `Number("")`
 * is 0, which used to hand out a random port on every run.
 */
export function preferredPort(values: Record<string, string>): number {
  const configured = Number((values.port ?? "").trim());
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_PORT;
}

function bindPort(port: number): number | null {
  try {
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response(""),
    });
    const bound = probe.port;
    probe.stop(true);
    return typeof bound === "number" ? bound : null;
  } catch {
    return null;
  }
}

/**
 * A free loopback port. The configured one is preferred so that a provider Kip
 * already saved keeps pointing at the same URL after a restart, and it is the
 * only port this function will hand out when one is configured: a random port
 * would leave the saved provider pointing at nothing.
 */
export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred) return await reservePreferred(preferred);
  const bound = bindPort(0);
  if (bound === null) throw new Error("Could not reserve a loopback port");
  return bound;
}

/**
 * Waits for a port a previous instance has just let go of, then reports who is
 * in the way rather than silently moving the gateway somewhere else.
 */
async function reservePreferred(port: number): Promise<number> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const bound = bindPort(port);
    if (bound !== null) return bound;
    if (attempt === 0)
      log(`port ${port} is in use; waiting for it to be released`);
    await Bun.sleep(PORT_RETRY_MS);
  }
  throw new Error(
    `Could not open port ${port}: it is in use, or this machine does not allow it. ` +
      "Free it, or pick another port in the plugin settings.",
  );
}

function stateFile(dataDir: string): string {
  return join(dataDir, "state");
}

function configFile(dataDir: string): string {
  return join(dataDir, "config.yaml");
}

/** Reuses the key Kip already holds for this provider, so saved records keep working. */
export function adoptStoredKey(dataDir: string, key: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "api_key");
  const current = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (current !== key) writeFileSync(file, key, { mode: 0o600 });
}

export function apiKey(dataDir: string): string {
  const file = join(dataDir, "api_key");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  const created = `kip-${crypto.randomUUID().replaceAll("-", "")}`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, created, { mode: 0o600 });
  return created;
}

// The Firefox cookie reader is owned by the gemini2api repository and synced
// into ./vendor by `bun run sync:cookies`. Do not edit the copy.
export { firefoxRoots, readFirefoxCookies } from "./vendor/cookies";
export type { CookieJar } from "./vendor/cookies";

function cookiesFile(dataDir: string): string {
  return join(dataDir, "cookies.json");
}

/** Cookies live in one 0600 file; the generated config is rebuilt from it. */
export function savedCookies(dataDir: string): CookieJar | null {
  if (!existsSync(cookiesFile(dataDir))) return null;
  try {
    return JSON.parse(readFileSync(cookiesFile(dataDir), "utf8")) as CookieJar;
  } catch {
    return null;
  }
}

export function saveCookies(dataDir: string, jar: CookieJar): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(cookiesFile(dataDir), JSON.stringify(jar), { mode: 0o600 });
}

/**
 * gemini-webapi rotates `__Secure-1PSIDTS` while it runs and caches the result
 * in the state directory. Without reading that cache back, the next start would
 * reuse the stale value from Firefox and be signed out.
 */
export function refreshSavedCookiesFromCache(dataDir: string): boolean {
  const jar = savedCookies(dataDir);
  const psid = jar?.cookies["__Secure-1PSID"];
  if (!jar || !psid) return false;
  const cache = join(stateFile(dataDir), `.cached_cookies_${psid}.json`);
  if (!existsSync(cache)) return false;
  let rows: Array<{ name?: string; value?: string }>;
  try {
    rows = JSON.parse(readFileSync(cache, "utf8")) as typeof rows;
  } catch {
    return false;
  }
  let changed = false;
  for (const row of rows) {
    if (!row?.name || !row.value) continue;
    if (row.name !== "__Secure-1PSIDTS" && row.name !== "__Secure-3PSIDTS")
      continue;
    if (jar.cookies[row.name] === row.value) continue;
    jar.cookies[row.name] = row.value;
    changed = true;
  }
  if (changed) {
    saveCookies(dataDir, jar);
    log("reused the rotated session cookie gemini2api cached last run");
  }
  return changed;
}

export function importFirefoxCookies(dataDir: string): CookieJar {
  const jar = readFirefoxCookies();
  saveCookies(dataDir, jar);
  log(
    `imported ${Object.keys(jar.cookies).length} cookies from ${jar.profile}`,
  );
  return jar;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

/** Writes the config Kip's own instance runs from; the key never leaves this machine. */
export function writeConfig(dataDir: string, port: number): void {
  const jar = savedCookies(dataDir);
  const psid = jar?.cookies["__Secure-1PSID"] ?? "";
  const psidts = jar?.cookies["__Secure-1PSIDTS"] ?? "";
  const extra = Object.entries(jar?.cookies ?? {})
    .filter(
      ([name]) => name !== "__Secure-1PSID" && name !== "__Secure-1PSIDTS",
    )
    .map(([name, value]) => `      ${yamlQuote(name)}: ${yamlQuote(value)}`)
    .join("\n");

  const lines = [
    "# Managed by Kip. Edits are overwritten when Kip starts the gateway.",
    "accounts:",
    "  - id: firefox",
    `    secure_1psid: ${yamlQuote(psid)}`,
    `    secure_1psidts: ${yamlQuote(psidts)}`,
    ...(extra ? ["    cookies:", extra] : []),
    `api_key: ${yamlQuote(apiKey(dataDir))}`,
    "host: 127.0.0.1",
    `port: ${port}`,
    'chat_mode: "auto_delete"',
    "auto_delete_ttl: 86400",
    'tools_repeat: "on_change"',
    "default_thinking: false",
    "max_prompt_chars: 900000",
    "timeout: 450",
    "refresh_interval: 600",
    `state_dir: ${yamlQuote(stateFile(dataDir))}`,
    "",
  ];
  mkdirSync(stateFile(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(configFile(dataDir), lines.join("\n"), { mode: 0o600 });
}

export async function health(
  port: number,
  key: string,
): Promise<HealthBody | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthBody;
    return body.server === PROVIDER_ID ? body : null;
  } catch {
    return null;
  }
}

/** Starts the gateway if it is not already answering. Returns its base URL. */
export async function ensureRunning(
  dataDir: string,
  values: Record<string, string>,
): Promise<{ baseUrl: string; port: number; key: string }> {
  if (starting) return starting;
  if (running) {
    return {
      baseUrl: `http://127.0.0.1:${running.port}/v1`,
      port: running.port,
      key: running.key,
    };
  }

  const run = startProcess(dataDir, values);
  starting = run;
  try {
    return await run;
  } finally {
    if (starting === run) starting = null;
  }
}

async function startProcess(
  dataDir: string,
  values: Record<string, string>,
): Promise<{ baseUrl: string; port: number; key: string }> {
  // The provider record already carries a key; make the managed instance use it
  // instead of a fresh one, so no Detect is needed after switching to a managed
  // gateway. A first install has no key yet and generates one.
  const storedKey = await getApiKey(PROVIDER_ID);
  if (storedKey) adoptStoredKey(dataDir, storedKey);
  const key = apiKey(dataDir);
  const binary = resolveBinary(dataDir, values);
  if (!binary)
    throw new Error(
      "gemini2api is not installed. Open its window and install it.",
    );

  if (!savedCookies(dataDir)?.cookies["__Secure-1PSID"])
    importFirefoxCookies(dataDir);
  refreshSavedCookiesFromCache(dataDir);
  const port = await findFreePort(preferredPort(values));
  writeConfig(dataDir, port);

  const env: Record<string, string | undefined> = {
    ...process.env,
    // G2A_* is the config path; the rest are the server's own variable names.
    G2A_CONFIG: configFile(dataDir),
    STATE_DIR: stateFile(dataDir),
    HOST: "127.0.0.1",
    PORT: String(port),
    API_KEY: key,
    PYTHONUNBUFFERED: "1",
  };
  delete env.G2A_SECURE_1PSID;
  delete env.G2A_SECURE_1PSIDTS;
  delete env.G2A_COOKIES;

  log(`starting ${binary} on 127.0.0.1:${port}`);
  const child = Bun.spawn([binary], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // A PyInstaller onefile binary is a bootloader plus a child process. Own a
    // process group so Stop kills both instead of leaving the server running.
    detached: process.platform !== "win32",
  });
  let exitedCode: number | null = null;
  const handle: Running = { process: child, port, key, dataDir };
  spawning = handle;
  child.exited.then((code) => {
    exitedCode = code;
    log(`gemini2api exited with code ${code}`);
    if (spawning?.process === child) spawning = null;
    if (running?.process === child) {
      running = null;
      removePidFile(dataDir);
      try {
        exitListener?.(code);
      } catch {
        // An exit listener failure must never break child cleanup.
      }
    }
  });
  const stdoutDone = pump(child.stdout);
  const stderrDone = pump(child.stderr);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitedCode !== null || spawning?.process !== child) break;
    const body = await health(port, key);
    if (body) {
      if (spawning?.process === child) spawning = null;
      running = handle;
      lastError = null;
      writePidFile(dataDir, child.pid, port, binary);
      log(`gemini2api ${body.version ?? ""} is up`);
      return { baseUrl: `http://127.0.0.1:${port}/v1`, port, key };
    }
    if (exitedCode !== null || spawning?.process !== child) break;
    await Bun.sleep(250);
  }
  if (spawning?.process === child || running?.process === child) {
    await stop();
  }
  if (exitedCode !== null) {
    await Promise.race([Promise.all([stdoutDone, stderrDone]), Bun.sleep(200)]);
  }
  const detail = logs.slice(-3).join(" · ");
  const reason =
    exitedCode !== null
      ? `gemini2api exited during startup (code ${exitedCode}).`
      : `gemini2api did not answer on 127.0.0.1:${port}.`;
  const message = `${reason} ${detail}`.trim();
  lastError = message;
  throw new Error(message);
}

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        log(line.replace(/\s+$/, ""));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) log(buffer.replace(/\s+$/, ""));
  } catch {
    // Stream closed while shutting down.
  } finally {
    reader.releaseLock();
  }
}

export interface StopOptions {
  /** Required when `includeAdopted` is true so `sidecar.pid` can be checked. */
  dataDir?: string;
  /** Also stop a Kip-owned sidecar adopted from an earlier app session. */
  includeAdopted?: boolean;
  /** Plugin settings used to resolve the configured port when adopting orphans. */
  values?: Record<string, string>;
}

export async function stop(options: StopOptions = {}): Promise<void> {
  const current = running ?? spawning;
  running = null;
  spawning = null;
  if (current) {
    log("stopping gemini2api");
    await killManagedProcess(current.process);
    removePidFile(current.dataDir);
    return;
  }
  if (options.includeAdopted && options.dataDir) {
    const adopted = adoptedSidecar(options.dataDir, options.values);
    if (adopted) {
      log(`stopping adopted gemini2api (pid ${adopted.pid})`);
      await killAdoptedPid(adopted.pid);
      removePidFile(options.dataDir);
    }
  }
}

async function killManagedProcess(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
): Promise<void> {
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  if (process.platform === "win32") {
    // PyInstaller onefile spawns a child Python process; kill the whole tree.
    const killed = Bun.spawnSync(
      ["taskkill", "/PID", String(child.pid), "/T", "/F"],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (killed.exitCode !== 0) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    await Promise.race([child.exited, Bun.sleep(3_000)]);
    return;
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
    if (exited) return;
    await Promise.race([
      child.exited,
      Bun.sleep(signal === "SIGTERM" ? 3_000 : 1_000),
    ]);
  }
}

async function killAdoptedPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + (signal === "SIGTERM" ? 3_000 : 1_000);
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return;
      await Bun.sleep(100);
    }
  }
}

/** Restarts the managed instance so it picks up new cookies. */
export async function restart(
  dataDir: string,
  values: Record<string, string>,
): Promise<{ baseUrl: string; port: number; key: string }> {
  await stop({ dataDir, includeAdopted: true });
  return ensureRunning(dataDir, values);
}

/** Removes a downloaded binary so the next install fetches a fresh one. */
export function uninstall(dataDir: string): void {
  const binary = installedBinary(dataDir);
  for (const file of [binary, `${binary}.new`, versionFile(dataDir)]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // Best effort.
    }
  }
}
