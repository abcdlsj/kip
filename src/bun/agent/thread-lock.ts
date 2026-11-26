/**
 * Cross-process exclusion for thread runs. The desktop app and the CLI share a
 * data directory, so without this lock two processes can drive the same thread,
 * interleave writes into its transcript, and each answer from a stale copy of
 * the context.
 *
 * The lock is a file per thread. Its owner refreshes the mtime while the run is
 * alive; a lock whose owner is gone, or whose heartbeat stopped, is taken over.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getDataDir } from "../storage/db";

/** How often a live owner refreshes its lock. */
const HEARTBEAT_MS = 15_000;
/** A lock older than this has lost its owner, even if the pid is still alive. */
const STALE_MS = 90_000;
/** Abandoned files are swept at most this often, per process. */
const SWEEP_MS = 300_000;

interface LockRecord {
  pid: number;
  host: string;
  client: string;
  token: string;
  startedAt: number;
}

/** The thread is being driven by another live Kip process. */
export class ThreadInUseError extends Error {
  constructor(readonly owner: LockRecord) {
    super(
      `This thread is already running in ${owner.client} (pid ${owner.pid}). Stop that run before sending here.`,
    );
    this.name = "ThreadInUseError";
  }
}

export interface ThreadLock {
  release(): void;
}

const NOOP_LOCK: ThreadLock = { release() {} };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ThreadLocks {
  private readonly host = hostname();
  private sweptAt = 0;

  private get dir(): string {
    return join(getDataDir(), "locks");
  }

  private pathFor(threadId: string): string {
    return join(this.dir, `${threadId}.lock`);
  }

  /**
   * Claims the thread for this process. A second claim from the same process is
   * inert so a run can queue a follow-up prompt without releasing its own lock.
   */
  acquire(threadId: string, client: string): ThreadLock {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.sweep();
    const path = this.pathFor(threadId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const owner = this.create(path, client);
      if (owner) return this.hold(path, owner);
      const existing = this.read(path);
      if (!existing) continue;
      if (existing.host === this.host && existing.pid === process.pid)
        return NOOP_LOCK;
      if (this.isLive(path, existing)) throw new ThreadInUseError(existing);
      this.drop(path, existing);
    }
    throw new Error("Could not lock this thread for the run");
  }

  /** Whether a different live process is driving this thread right now. */
  heldByOther(threadId: string): boolean {
    const path = this.pathFor(threadId);
    const existing = this.read(path);
    if (!existing) return false;
    if (existing.host === this.host && existing.pid === process.pid)
      return false;
    return this.isLive(path, existing);
  }

  private create(path: string, client: string): LockRecord | null {
    const token = crypto.randomUUID();
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    const owner: LockRecord = {
      pid: process.pid,
      host: this.host,
      client,
      token,
      startedAt: Date.now(),
    };
    try {
      writeSync(fd, JSON.stringify(owner));
    } finally {
      closeSync(fd);
    }
    return owner;
  }

  private read(path: string): LockRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
      if (typeof parsed?.pid !== "number" || typeof parsed?.token !== "string")
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private isLive(path: string, owner: LockRecord): boolean {
    let age = 0;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      return false;
    }
    if (age > STALE_MS) return false;
    // A shared directory can outlive a machine; there the heartbeat is the only
    // evidence that the owner is still working.
    if (owner.host !== this.host) return true;
    return pidAlive(owner.pid);
  }

  private drop(path: string, owner: LockRecord): void {
    const current = this.read(path);
    if (current && current.token !== owner.token) return;
    try {
      unlinkSync(path);
    } catch {
      // Another process took it first.
    }
  }

  private hold(path: string, owner: LockRecord): ThreadLock {
    const timer = setInterval(() => {
      const current = this.read(path);
      if (!current || current.token !== owner.token) {
        clearInterval(timer);
        return;
      }
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {
        clearInterval(timer);
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
    return {
      release: () => {
        clearInterval(timer);
        this.drop(path, owner);
      },
    };
  }

  /** Removes lock files whose owner is gone, so crashes do not pile up. */
  private sweep(): void {
    const now = Date.now();
    if (now - this.sweptAt < SWEEP_MS) return;
    this.sweptAt = now;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      const path = join(this.dir, name);
      const owner = this.read(path);
      if (owner && owner.host === this.host && owner.pid === process.pid)
        continue;
      if (owner && this.isLive(path, owner)) continue;
      try {
        unlinkSync(path);
      } catch {
        // Best effort.
      }
    }
  }
}
