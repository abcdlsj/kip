import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupStaleCefLocks,
  parseSingletonLockPid,
  prepareCefUserDataDir,
} from "../src/bun/system/cef-guard";

let cefDir = "";

function symlinkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  cefDir = mkdtempSync(join(tmpdir(), "kip-cef-guard-"));
});

afterEach(() => {
  rmSync(cefDir, { recursive: true, force: true });
});

describe("CEF singleton lock guard", () => {
  test("parses hostnames with hyphens from SingletonLock targets", () => {
    expect(parseSingletonLockPid("mbp14-m3-12480")).toBe(12480);
    expect(parseSingletonLockPid("my-host.local-999")).toBe(999);
    expect(parseSingletonLockPid("invalid")).toBeNull();
    expect(parseSingletonLockPid("host-0")).toBeNull();
    expect(parseSingletonLockPid("host-notapid")).toBeNull();
  });

  test("returns none when no SingletonLock exists", () => {
    const result = cleanupStaleCefLocks(cefDir);
    expect(result).toEqual({ status: "none", pid: null, removed: [] });
  });

  test("removes stale SingletonLock, SingletonSocket, and SingletonCookie for a dead PID", () => {
    symlinkSync("mbp14-m3-987654", join(cefDir, "SingletonLock"));
    symlinkSync("/tmp/fake/SingletonSocket", join(cefDir, "SingletonSocket"));
    symlinkSync("1234567890", join(cefDir, "SingletonCookie"));
    writeFileSync(join(cefDir, "Local State"), "{}");

    const result = cleanupStaleCefLocks(cefDir, {
      isAlive: () => false,
      currentPid: 1111,
    });

    expect(result.status).toBe("cleaned");
    expect(result.pid).toBe(987654);
    expect(result.removed).toEqual([
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
    ]);
    expect(symlinkExists(join(cefDir, "SingletonLock"))).toBe(false);
    expect(symlinkExists(join(cefDir, "SingletonSocket"))).toBe(false);
    expect(symlinkExists(join(cefDir, "SingletonCookie"))).toBe(false);
    expect(existsSync(join(cefDir, "Local State"))).toBe(true);
  });

  test("never deletes locks held by another live process", () => {
    symlinkSync("mbp14-m3-4242", join(cefDir, "SingletonLock"));
    symlinkSync("/tmp/fake/SingletonSocket", join(cefDir, "SingletonSocket"));

    const result = cleanupStaleCefLocks(cefDir, {
      isAlive: (pid) => pid === 4242,
      currentPid: 1111,
    });

    expect(result).toEqual({ status: "live", pid: 4242, removed: [] });
    expect(symlinkExists(join(cefDir, "SingletonLock"))).toBe(true);
    expect(symlinkExists(join(cefDir, "SingletonSocket"))).toBe(true);
  });

  test("waits briefly during restart and cleans once the previous process exits", async () => {
    symlinkSync("mbp14-m3-5555", join(cefDir, "SingletonLock"));
    let checks = 0;

    const result = await prepareCefUserDataDir(cefDir, {
      waitMs: 500,
      pollMs: 25,
      currentPid: 1111,
      isAlive: () => {
        checks += 1;
        return checks < 3;
      },
    });

    expect(result.status).toBe("cleaned");
    expect(result.pid).toBe(5555);
    expect(checks).toBe(3);
    expect(symlinkExists(join(cefDir, "SingletonLock"))).toBe(false);
  });
});
