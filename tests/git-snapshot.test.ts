import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffTrees, restoreRun, snapshotTree } from "../src/bun/system/git-snapshot";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  return result.stdout.toString();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "kip-snap-"));
  roots.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  // An uncommitted edit from before the run must survive undo.
  writeFileSync(join(root, "b.txt"), "b\nuser\n");
  return root;
}

describe("git snapshots", () => {
  test("returns null outside a Git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "kip-plain-"));
    roots.push(root);
    expect(await snapshotTree(root)).toBeNull();
  });

  test("records and undoes a run without touching HEAD or the index", async () => {
    const root = repo();
    const head = git(root, "rev-parse", "HEAD");
    const status = git(root, "status", "--porcelain");
    const before = (await snapshotTree(root))!;
    writeFileSync(join(root, "a.txt"), "a\nagent\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    rmSync(join(root, "b.txt"));
    const after = (await snapshotTree(root))!;
    const files = await diffTrees(root, before, after);
    expect(files.map((file) => `${file.status}:${file.path}`)).toEqual([
      "modified:a.txt",
      "deleted:b.txt",
      "added:new.txt",
    ]);

    expect(await restoreRun(root, before, after, files)).toEqual({ ok: true });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b\nuser\n");
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe(status);
  });

  test("refuses to undo files changed after the run", async () => {
    const root = repo();
    const before = (await snapshotTree(root))!;
    writeFileSync(join(root, "a.txt"), "agent\n");
    const after = (await snapshotTree(root))!;
    const files = await diffTrees(root, before, after);
    writeFileSync(join(root, "a.txt"), "user again\n");
    const result = await restoreRun(root, before, after, files);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("user again\n");
  });
});
