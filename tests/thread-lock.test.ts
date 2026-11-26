import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../src/bun/agent/model-registry";
import { KipOrchestrator } from "../src/bun/agent/pi-orchestrator";
import { ThreadInUseError, ThreadLocks } from "../src/bun/agent/thread-lock";
import { KipDatabase } from "../src/bun/storage/db";

let dir = "";
let locks: ThreadLocks;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-lock-"));
  process.env.KIP_DATA_DIR = dir;
  locks = new ThreadLocks();
  mkdirSync(join(dir, "locks"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KIP_DATA_DIR;
});

function lockPath(threadId: string): string {
  return join(dir, "locks", `${threadId}.lock`);
}

/** Writes a lock as if another process owned it; returns that record. */
function plantLock(
  threadId: string,
  overrides: Partial<{ pid: number; host: string; token: string }> = {},
  ageMs = 0,
): string {
  const record = {
    pid: process.pid,
    host: hostname(),
    client: "the kip CLI",
    token: "planted",
    startedAt: Date.now(),
    ...overrides,
  };
  const path = lockPath(threadId);
  writeFileSync(path, JSON.stringify(record));
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    utimesSync(path, stamp, stamp);
  }
  return path;
}

describe("thread locks", () => {
  test("lets the owner run, then frees the thread", () => {
    const lock = locks.acquire("th_a", "the Kip app");
    expect(locks.heldByOther("th_a")).toBe(false);
    expect(readdirSync(join(dir, "locks"))).toContain("th_a.lock");
    lock.release();
    expect(readdirSync(join(dir, "locks"))).not.toContain("th_a.lock");
  });

  test("is reentrant inside one process so queued prompts keep the lock", () => {
    const outer = locks.acquire("th_a", "the Kip app");
    const inner = locks.acquire("th_a", "the Kip app");
    inner.release();
    // The inner claim must not release the run that owns the thread.
    expect(readdirSync(join(dir, "locks"))).toContain("th_a.lock");
    expect(() => locks.acquire("th_a", "the kip CLI")).not.toThrow();
    outer.release();
    expect(readdirSync(join(dir, "locks"))).not.toContain("th_a.lock");
  });

  test("refuses a thread held by another live process", () => {
    // pid 1 is always alive, so it stands in for the other Kip process.
    plantLock("th_a", { pid: 1 });
    expect(() => locks.acquire("th_a", "the Kip app")).toThrow(ThreadInUseError);
    expect(() => locks.acquire("th_a", "the Kip app")).toThrow(
      /already running in the kip CLI \(pid 1\)/,
    );
    expect(locks.heldByOther("th_a")).toBe(true);
  });

  test("takes over a lock whose process is gone", () => {
    plantLock("th_a", { pid: 999_999 });
    const lock = locks.acquire("th_a", "the Kip app");
    expect(locks.heldByOther("th_a")).toBe(false);
    lock.release();
  });

  test("takes over a lock whose owner stopped heartbeating", () => {
    // Alive pid, but the mtime is older than the staleness window: the other
    // process is wedged and must not block this one forever.
    plantLock("th_a", { pid: 1 }, 120_000);
    const lock = locks.acquire("th_a", "the Kip app");
    lock.release();
    expect(readdirSync(join(dir, "locks"))).not.toContain("th_a.lock");
  });

  test("trusts the heartbeat for a lock written on another machine", () => {
    plantLock("th_b", { host: "another-host" });
    expect(() => locks.acquire("th_b", "the Kip app")).toThrow(ThreadInUseError);
    plantLock("th_b", { host: "another-host" }, 120_000);
    locks.acquire("th_b", "the Kip app").release();
  });

  test("ignores an unreadable lock instead of failing the run", () => {
    writeFileSync(lockPath("th_a"), "");
    locks.acquire("th_a", "the Kip app").release();
  });

  test("refuses to send a prompt into a thread another process drives", async () => {
    const db = new KipDatabase();
    try {
      const workspace = db.createWorkspace("lock", dir);
      const sessionFile = join(dir, "th_busy.jsonl");
      db.createThread({
        id: "th_busy",
        workspaceId: workspace.id,
        title: "New Thread",
        sessionFilePath: sessionFile,
        modelProvider: "demo",
        modelId: "demo-model",
        thinkingLevel: "off",
        mode: "chat",
      });
      const orchestrator = new KipOrchestrator(
        db,
        await ModelRegistry.create(db),
        () => {},
      );
      plantLock("th_busy", { pid: 1 });
      try {
        await expect(
          orchestrator.sendPrompt({ threadId: "th_busy", text: "hello" }),
        ).rejects.toThrow(/already running in the kip CLI/);
        // The guard runs before the session opens: no request, no transcript.
        expect(existsSync(sessionFile)).toBe(false);
      } finally {
        await orchestrator.shutdown();
      }
    } finally {
      db.close();
    }
  });
});
