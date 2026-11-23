/**
 * Cross-platform OS utilities for the Bun main process. Centralizes home
 * directory lookup, path normalization, file permission guards, line splitting,
 * and subprocess environment defaults across macOS, Windows, and Linux.
 */
import { chmodSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { sep } from "node:path";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/** Always resolves the user's home directory on macOS, Windows, and Linux. */
export function userHome(): string {
  return homedir() || process.env.HOME || process.env.USERPROFILE || "/";
}

/** Converts platform path separators to POSIX `/` for portable display and keys. */
export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Splits text across both LF and CRLF line endings. */
export function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

/** Normalizes paths for prefix/equality comparisons (case-insensitive on Windows). */
export function normalizeForCompare(value: string): string {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

/** Returns true when `target` equals `prefix` or is nested inside `prefix`. */
export function pathStartsWith(target: string, prefix: string): boolean {
  const normalizedTarget = normalizeForCompare(target);
  const normalizedPrefix = normalizeForCompare(prefix);
  if (normalizedTarget === normalizedPrefix) return true;
  const withSep = normalizedPrefix.endsWith(sep)
    ? normalizedPrefix
    : `${normalizedPrefix}${sep}`;
  return normalizedTarget.startsWith(withSep);
}

/** Applies POSIX file permissions safely; no-op on Windows. */
export function safeChmod(path: string, mode: number): void {
  if (IS_WINDOWS) return;
  try {
    chmodSync(path, mode);
  } catch {
    // Some mounted or sandboxed filesystems disallow chmod; ignore gracefully.
  }
}

/** Environment overrides that keep agent subprocesses non-interactive and clean. */
export function nonInteractiveEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) clean[key] = value;
  }
  return {
    ...clean,
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    TERM: clean.TERM === "dumb" ? "dumb" : "dumb",
  };
}

/** Short human-readable runtime description for agent system context. */
export function describeRuntimeEnv(): string {
  const osName = IS_MAC
    ? "macOS"
    : IS_WINDOWS
      ? "Windows"
      : IS_LINUX
        ? "Linux"
        : platform();
  const shellHint = IS_WINDOWS
    ? "Windows shell (prefer cross-platform commands; avoid assuming POSIX-only utilities)"
    : "POSIX shell";
  return `${osName} (${arch()}), ${shellHint}`;
}
