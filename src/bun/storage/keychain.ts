/**
 * Cross-platform credential storage.
 *
 * - macOS: uses the login Keychain (`security`), falling back to the encrypted vault.
 * - Linux: uses libsecret (`secret-tool`) when available, falling back to the encrypted vault.
 * - Windows & fallback (and `KIP_KEYCHAIN=file` in tests): AES-256-GCM vault with atomic writes.
 *
 * Plaintext secrets never touch SQLite, logs, or sync payloads.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { IS_LINUX, IS_MAC, safeChmod } from "../system/platform";
import { ensureDataDir, getDataDir } from "./db";

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

const SERVICE = "kip.provider";
const ACCOUNT = "kip";
/** Upper bound for OS keychain commands so a locked/stalled keychain cannot freeze startup. */
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000;
/** Backoff after a keychain timeout so subsequent provider lookups fall back immediately. */
const KEYCHAIN_TIMEOUT_BACKOFF_MS = 60_000;

let linuxSecretToolAvailable: boolean | null = null;
let keychainBackoffUntil = 0;

function isKeychainBackedOff(): boolean {
  return Date.now() < keychainBackoffUntil;
}

function recordKeychainTimeout(): void {
  keychainBackoffUntil = Date.now() + KEYCHAIN_TIMEOUT_BACKOFF_MS;
}

export function resetKeychainTimeoutState(): void {
  keychainBackoffUntil = 0;
}

export interface CredentialCommandResult {
  code: number;
  stdout: string;
  timedOut: boolean;
}

/**
 * Runs an OS credential helper with a hard timeout, killing the subprocess if
 * it stalls (e.g. a hidden macOS Keychain access dialog on an unsigned bundle).
 */
export async function runCredentialCommand(
  cmd: string[],
  options: { stdin?: Blob; timeoutMs?: number } = {},
): Promise<CredentialCommandResult> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_COMMAND_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: options.stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { code: -1, stdout: "", timedOut: false };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<CredentialCommandResult>((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
      resolve({ code: -1, stdout: "", timedOut: true });
    }, timeoutMs);
  });

  const stdoutPipe = proc.stdout as ReadableStream<Uint8Array> | undefined;
  const completionPromise = Promise.all([
    stdoutPipe
      ? new Response(stdoutPipe).text().catch(() => "")
      : Promise.resolve(""),
    proc.exited.catch(() => -1),
  ]).then(([stdout, code]) => ({
    code,
    stdout,
    timedOut: false,
  }));

  try {
    return await Promise.race([completionPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function useMacKeychain(): boolean {
  if (process.env.KIP_KEYCHAIN === "file") return false;
  if (isKeychainBackedOff()) return false;
  return IS_MAC;
}

function useLinuxSecretService(): boolean {
  if (process.env.KIP_KEYCHAIN === "file") return false;
  if (isKeychainBackedOff()) return false;
  if (!IS_LINUX) return false;
  if (linuxSecretToolAvailable === null) {
    linuxSecretToolAvailable = Bun.which("secret-tool") !== null;
  }
  return linuxSecretToolAvailable;
}

function machineKeyPath(): string {
  return join(ensureDataDir(), ".machine");
}

function atomicWrite(
  path: string,
  content: Buffer | string,
  mode = 0o600,
): void {
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, content, { mode });
    safeChmod(tempPath, mode);
    renameSync(tempPath, path);
    safeChmod(path, mode);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function loadMachineKey(): Buffer {
  const path = machineKeyPath();
  if (!existsSync(path)) {
    const key = randomBytes(32);
    atomicWrite(path, key, 0o600);
    return key;
  }
  return readFileSync(path);
}

function credentialsPath(): string {
  return join(getDataDir(), "credentials.enc");
}

function readVault(): Record<string, EncryptedEntry> {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      EncryptedEntry
    >;
  } catch {
    return {};
  }
}

function writeVault(vault: Record<string, EncryptedEntry>): void {
  const path = credentialsPath();
  mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });
  atomicWrite(path, JSON.stringify(vault), 0o600);
}

async function keychainGet(provider: string): Promise<string | null> {
  const result = await runCredentialCommand([
    "security",
    "find-generic-password",
    "-a",
    ACCOUNT,
    "-s",
    `${SERVICE}.${provider}`,
    "-w",
  ]);
  if (result.timedOut) {
    recordKeychainTimeout();
    return null;
  }
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function keychainSet(provider: string, apiKey: string): Promise<void> {
  const result = await runCredentialCommand([
    "security",
    "add-generic-password",
    "-U",
    "-a",
    ACCOUNT,
    "-s",
    `${SERVICE}.${provider}`,
    "-w",
    apiKey,
  ]);
  if (result.timedOut) {
    recordKeychainTimeout();
    throw new Error("Keychain write timed out");
  }
  if (result.code !== 0) throw new Error("Keychain write failed");
}

async function keychainDelete(provider: string): Promise<void> {
  const result = await runCredentialCommand([
    "security",
    "delete-generic-password",
    "-a",
    ACCOUNT,
    "-s",
    `${SERVICE}.${provider}`,
  ]);
  if (result.timedOut) recordKeychainTimeout();
}

async function secretToolGet(provider: string): Promise<string | null> {
  const result = await runCredentialCommand([
    "secret-tool",
    "lookup",
    "service",
    `${SERVICE}.${provider}`,
    "account",
    ACCOUNT,
  ]);
  if (result.timedOut) {
    recordKeychainTimeout();
    return null;
  }
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function secretToolSet(provider: string, apiKey: string): Promise<void> {
  const result = await runCredentialCommand(
    [
      "secret-tool",
      "store",
      `--label=Kip (${provider})`,
      "service",
      `${SERVICE}.${provider}`,
      "account",
      ACCOUNT,
    ],
    { stdin: new Blob([apiKey]) },
  );
  if (result.timedOut) {
    recordKeychainTimeout();
    throw new Error("Secret Service write timed out");
  }
  if (result.code !== 0) throw new Error("Secret Service write failed");
}

async function secretToolDelete(provider: string): Promise<void> {
  const result = await runCredentialCommand([
    "secret-tool",
    "clear",
    "service",
    `${SERVICE}.${provider}`,
    "account",
    ACCOUNT,
  ]);
  if (result.timedOut) recordKeychainTimeout();
}

export async function setApiKey(
  provider: string,
  apiKey: string,
): Promise<void> {
  if (useMacKeychain()) {
    try {
      await keychainSet(provider, apiKey);
      return;
    } catch {
      // Fall through to the encrypted vault when the login keychain is locked.
    }
  } else if (useLinuxSecretService()) {
    try {
      await secretToolSet(provider, apiKey);
      return;
    } catch {
      // Fall through to the encrypted vault when Secret Service is unavailable.
    }
  }
  const key = loadMachineKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  const vault = readVault();
  vault[provider] = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  writeVault(vault);
}

export async function getApiKey(provider: string): Promise<string | null> {
  if (useMacKeychain()) {
    try {
      const value = await keychainGet(provider);
      if (value) return value;
    } catch {
      // Fall through to the encrypted vault when the keychain is unavailable.
    }
  } else if (useLinuxSecretService()) {
    try {
      const value = await secretToolGet(provider);
      if (value) return value;
    } catch {
      // Fall through to the encrypted vault when Secret Service is unavailable.
    }
  }
  const entry = readVault()[provider];
  if (!entry) return null;
  try {
    const key = loadMachineKey();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(entry.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export async function deleteApiKey(provider: string): Promise<void> {
  try {
    if (useMacKeychain()) await keychainDelete(provider);
    else if (useLinuxSecretService()) await secretToolDelete(provider);
  } catch {
    // Best-effort OS keychain cleanup; still remove the vault entry below.
  }
  const vault = readVault();
  if (provider in vault) {
    delete vault[provider];
    writeVault(vault);
  }
}

export async function hasApiKey(provider: string): Promise<boolean> {
  return (await getApiKey(provider)) !== null;
}
