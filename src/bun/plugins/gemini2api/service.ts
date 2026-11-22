/**
 * The gemini2api sidecar: downloading it, pointing it at Firefox's session
 * cookies, running it on loopback, and stopping it.
 *
 * This is gemini2api's own business logic. Kip hands the plugin a writable
 * directory and an action channel; it does not know what a sidecar is.
 */
import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "gemini2api";
const MANIFEST_URL = "https://github.com/abcdlsj/gemini2api/releases/latest/download/manifest.json";
const START_TIMEOUT_MS = 20_000;
const LOG_LIMIT = 200;
const GOOGLE_HOSTS = [".google.com", "accounts.google.com", "gemini.google.com"];
const DROPPED_COOKIES = new Set(["_ga", "_gcl_au", "_ga_WC57KJ50ZZ"]);

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
}

export interface CookieJar {
  profile: string;
  cookies: Record<string, string>;
}

interface Running {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  key: string;
}

let running: Running | null = null;
let lastError: string | null = null;
const logs: string[] = [];

function log(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  logs.push(stamped);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
}

export function readLogs(): string[] {
  return [...logs];
}

export function platformKey(): string {
  const os =
    process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
  return `${os}-${process.arch === "arm64" ? "arm64" : "x64"}`;
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

export function status(dataDir: string, values: Record<string, string> = {}): SidecarStatus {
  const binary = resolveBinary(dataDir, values);
  return {
    installed: binary !== null,
    version: readInstalledVersion(dataDir),
    binaryPath: binary,
    running: running !== null,
    port: running?.port ?? null,
    pid: running?.process.pid ?? null,
    health: null,
    lastError,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "kip-gemini2api-plugin" },
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
    log(`manifest is ${manifest.version}, pinned ${pinned}; using the manifest version`);
  }
  const artifact = manifest.artifacts[platformKey()];
  if (!artifact) {
    throw new Error(`gemini2api ${manifest.version} has no build for ${platformKey()}`);
  }
  log(`downloading ${artifact.file} (${manifest.version})`);
  const response = await fetch(artifact.url, {
    headers: { "user-agent": "kip-gemini2api-plugin" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) throw new Error(`download answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== artifact.sha256) {
    throw new Error(`checksum mismatch: expected ${artifact.sha256}, got ${digest}`);
  }
  mkdirSync(binDir(dataDir), { recursive: true, mode: 0o700 });
  const target = installedBinary(dataDir);
  const staging = `${target}.new`;
  writeFileSync(staging, bytes, { mode: 0o755 });
  chmodSync(staging, 0o755);
  renameSync(staging, target);
  writeFileSync(versionFile(dataDir), manifest.version, { mode: 0o600 });
  log(`installed ${manifest.version}`);
  return { path: target, version: manifest.version };
}

/** A binary the user points at (a local build) wins over a downloaded one. */
export function resolveBinary(dataDir: string, values: Record<string, string>): string | null {
  const manual = (values.binaryPath ?? "").trim();
  if (manual && existsSync(manual)) return manual;
  const installed = installedBinary(dataDir);
  return existsSync(installed) ? installed : null;
}

export async function findFreePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== "number") throw new Error("Could not reserve a loopback port");
  return port;
}

function stateFile(dataDir: string): string {
  return join(dataDir, "state");
}

function configFile(dataDir: string): string {
  return join(dataDir, "config.yaml");
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

/** The default Firefox profile roots on this platform. */
export function firefoxRoots(): string[] {
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Application Support", "Firefox")];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return [join(appData, "Mozilla", "Firefox")];
  }
  return [
    join(homedir(), ".mozilla", "firefox"),
    join(homedir(), "snap", "firefox", "common", ".mozilla", "firefox"),
  ];
}

/** Which Firefox profile holds the Gemini session a turn should use. */
export function firefoxProfiles(roots: string[] = firefoxRoots()): string[] {

  const profiles: string[] = [];
  for (const root of roots) {
    const profilesDir = join(root, "Profiles");
    for (const [base, candidates] of [
      [profilesDir, safeReaddir(profilesDir)],
      [root, safeReaddir(root)],
    ] as const) {
      for (const name of candidates) {
        const dir = join(base, name);
        if (existsSync(join(dir, "cookies.sqlite"))) profiles.push(dir);
      }
    }
  }
  return profiles;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Firefox keeps cookie values in clear; copy the database before reading it. */
function cookiesFromProfile(profile: string): Record<string, string> {
  const temp = mkdtempSync(join(tmpdir(), "kip-cookies-"));
  try {
    const source = join(profile, "cookies.sqlite");
    if (!existsSync(source)) return {};
    const target = join(temp, "cookies.sqlite");
    copyFileSync(source, target);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${source}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${target}${suffix}`);
    }
    const database = new Database(target, { readonly: true });
    try {
      const rows = database
        .query<{ name: string; value: string }, string[]>(
          `select name, value from moz_cookies where host in (${GOOGLE_HOSTS.map(() => "?").join(",")})`,
        )
        .all(...GOOGLE_HOSTS);
      const cookies: Record<string, string> = {};
      for (const row of rows) {
        if (!row.value || DROPPED_COOKIES.has(row.name)) continue;
        cookies[row.name] = row.value;
      }
      return cookies;
    } finally {
      database.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The profile with the most Google cookies, provided it has a Gemini session. */
export function readFirefoxCookies(roots: string[] = firefoxRoots()): CookieJar {
  let best: CookieJar | null = null;
  for (const profile of firefoxProfiles(roots)) {
    let cookies: Record<string, string> = {};
    try {
      cookies = cookiesFromProfile(profile);
    } catch {
      // A profile whose database cannot be read is simply not a candidate.
      continue;
    }
    if (!cookies["__Secure-1PSID"]) continue;
    if (!best || Object.keys(cookies).length > Object.keys(best.cookies).length) {
      best = { profile, cookies };
    }
  }
  if (!best) {
    throw new Error(
      "No Firefox profile has a Gemini session. Sign in to gemini.google.com in Firefox, then try again.",
    );
  }
  return best;
}

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

export function importFirefoxCookies(dataDir: string): CookieJar {
  const jar = readFirefoxCookies();
  saveCookies(dataDir, jar);
  log(`imported ${Object.keys(jar.cookies).length} cookies from ${jar.profile}`);
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
    .filter(([name]) => name !== "__Secure-1PSID" && name !== "__Secure-1PSIDTS")
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

export async function health(port: number, key: string): Promise<HealthBody | null> {
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
  const key = apiKey(dataDir);
  if (running) {
    return { baseUrl: `http://127.0.0.1:${running.port}/v1`, port: running.port, key: running.key };
  }

  const binary = resolveBinary(dataDir, values);
  if (!binary) throw new Error("gemini2api is not installed. Open its window and install it.");

  if (!savedCookies(dataDir)) importFirefoxCookies(dataDir);
  const port = await findFreePort();
  writeConfig(dataDir, port);

  log(`starting ${binary} on 127.0.0.1:${port}`);
  const child = Bun.spawn([binary], {
    env: {
      ...process.env,
      G2A_CONFIG: configFile(dataDir),
      STATE_DIR: stateFile(dataDir),
      HOST: "127.0.0.1",
      PORT: String(port),
      API_KEY: key,
      PYTHONUNBUFFERED: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  running = { process: child, port, key };
  child.exited.then((code) => {
    log(`gemini2api exited with code ${code}`);
    running = null;
  });
  void pump(child.stdout, child);
  void pump(child.stderr, child);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const body = await health(port, key);
    if (body) {
      log(`gemini2api ${body.version ?? ""} is up`);
      return { baseUrl: `http://127.0.0.1:${port}/v1`, port, key };
    }
    await Bun.sleep(250);
  }
  await stop();
  const detail = logs.slice(-3).join(" · ");
  throw new Error(`gemini2api did not answer on 127.0.0.1:${port}. ${detail}`.trim());
}

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
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
        if (!running || running.process !== child) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function stop(): Promise<void> {
  const current = running;
  running = null;
  if (!current) return;
  log("stopping gemini2api");
  try {
    current.process.kill();
  } catch {
    // Already gone.
  }
  await Promise.race([current.process.exited, Bun.sleep(3_000)]);
}

/** Restarts the managed instance so it picks up new cookies. */
export async function restart(
  dataDir: string,
  values: Record<string, string>,
): Promise<{ baseUrl: string; port: number; key: string }> {
  await stop();
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

