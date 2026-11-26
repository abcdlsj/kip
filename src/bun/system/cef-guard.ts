/**
 * Guards Chromium/CEF profile startup against stale singleton locks left behind
 * by crashes, force-quits, or an earlier instance still finishing shutdown.
 *
 * On macOS and Linux, Chromium writes `SingletonLock` as a symlink pointing to
 * `<hostname>-<pid>` alongside `SingletonSocket` and `SingletonCookie`. Only
 * locks whose recorded PID is no longer alive are removed; locks owned by a
 * running process are never deleted.
 */
import { lstatSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

const SINGLETON_FILES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;

export type CefLockStatus = "none" | "cleaned" | "live";

export interface CefLockCleanupResult {
  status: CefLockStatus;
  pid: number | null;
  removed: string[];
}

export interface CefLockOptions {
  isAlive?: (pid: number) => boolean;
  currentPid?: number;
}

export interface PrepareCefOptions extends CefLockOptions {
  /** Max time to wait when another instance still holds the lock (e.g. restarting). */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Extracts the trailing PID from Chromium's `<hostname>-<pid>` symlink target.
 * Hostnames may contain hyphens, so only the final segment is parsed.
 */
export function parseSingletonLockPid(target: string): number | null {
  const trimmed = target.trim();
  const sep = trimmed.lastIndexOf("-");
  if (sep < 0 || sep === trimmed.length - 1) return null;
  const rawPid = trimmed.slice(sep + 1);
  if (!/^\d+$/.test(rawPid)) return null;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return pid;
}

/** Returns true when `pid` exists on this host (even if owned by another user). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readSingletonLockPid(lockPath: string): {
  exists: boolean;
  pid: number | null;
} {
  try {
    const stat = lstatSync(lockPath);
    if (!stat.isSymbolicLink()) return { exists: true, pid: null };
    return { exists: true, pid: parseSingletonLockPid(readlinkSync(lockPath)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false, pid: null };
    return { exists: false, pid: null };
  }
}

/**
 * Removes stale CEF singleton lock artifacts when the owning PID is dead.
 * Never removes locks held by another live process.
 */
export function cleanupStaleCefLocks(
  cefDir: string,
  options: CefLockOptions = {},
): CefLockCleanupResult {
  const isAlive = options.isAlive ?? isProcessAlive;
  const currentPid = options.currentPid ?? process.pid;
  const lockPath = join(cefDir, "SingletonLock");
  const { exists, pid } = readSingletonLockPid(lockPath);

  if (!exists) return { status: "none", pid: null, removed: [] };
  if (pid !== null && pid !== currentPid && isAlive(pid)) {
    return { status: "live", pid, removed: [] };
  }

  const removed: string[] = [];
  for (const name of SINGLETON_FILES) {
    const filePath = join(cefDir, name);
    try {
      lstatSync(filePath);
    } catch {
      continue;
    }
    try {
      rmSync(filePath, { force: true });
      removed.push(name);
    } catch {
      // Best-effort: CEF will still attempt to initialize.
    }
  }
  return { status: "cleaned", pid, removed };
}

/**
 * Prepares the CEF user-data directory before the first BrowserWindow opens.
 * If another process holds `SingletonLock`, waits briefly in case it is still
 * finishing shutdown (for example right after a restart or update) and cleans
 * up any leftover lock once that process exits.
 */
export async function prepareCefUserDataDir(
  cefDir: string,
  options: PrepareCefOptions = {},
): Promise<CefLockCleanupResult> {
  const waitMs = options.waitMs ?? 2_500;
  const pollMs = Math.max(25, options.pollMs ?? 150);

  let result = cleanupStaleCefLocks(cefDir, options);
  if (result.status !== "live" || waitMs <= 0) return result;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    result = cleanupStaleCefLocks(cefDir, options);
    if (result.status !== "live") return result;
  }
  return result;
}
