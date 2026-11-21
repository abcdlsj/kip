/**
 * Working-tree snapshots for per-run undo. A snapshot is a Git tree object
 * written through a temporary index, so HEAD, the real index, branches, and
 * refs are never touched. Unreferenced trees survive until Git prunes them
 * (two weeks by default), which is long enough for undo.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FileChange } from "../../shared/types";
import { splitLines } from "./platform";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function isGitWorkspace(root: string): Promise<boolean> {
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

/** Writes the current working tree (respecting .gitignore) as a tree object. */
export async function snapshotTree(root: string): Promise<string | null> {
  if (!(await isGitWorkspace(root))) return null;
  const indexPath = await git(root, ["rev-parse", "--git-path", "index"]);
  if (indexPath.code !== 0) return null;
  const realIndex = indexPath.stdout.trim();
  const source = isAbsolute(realIndex) ? realIndex : resolve(root, realIndex);
  const tempIndex = join(tmpdir(), `kip-index-${crypto.randomUUID()}`);
  try {
    // Starting from the real index keeps Git's stat cache, so this stays fast.
    if (existsSync(source)) copyFileSync(source, tempIndex);
    const env = { GIT_INDEX_FILE: tempIndex };
    const add = await git(root, ["add", "-A", "--", "."], env);
    if (add.code !== 0) return null;
    const tree = await git(root, ["write-tree"], env);
    if (tree.code !== 0) return null;
    return tree.stdout.trim() || null;
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

/** Files that differ between two snapshots, relative to the workspace root. */
export async function diffTrees(root: string, before: string, after: string): Promise<FileChange[]> {
  if (before === after) return [];
  const [status, numstat] = await Promise.all([
    git(root, ["diff", "--name-status", "--no-renames", "--relative", "-z", before, after, "--", "."]),
    git(root, ["diff", "--numstat", "--no-renames", "--relative", "-z", before, after, "--", "."]),
  ]);
  if (status.code !== 0 || numstat.code !== 0) return [];

  const counts = new Map<string, { added: number; removed: number }>();
  for (const record of numstat.stdout.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(record);
    if (!match) continue;
    counts.set(match[3] ?? "", {
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
    });
  }

  const parts = status.stdout.split("\0");
  const files: FileChange[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const code = parts[index] ?? "";
    const path = parts[index + 1] ?? "";
    if (!path) continue;
    const kind: FileChange["status"] =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    files.push({ path, status: kind, ...(counts.get(path) ?? { added: 0, removed: 0 }) });
  }
  return files;
}

export async function treeExists(root: string, tree: string): Promise<boolean> {
  const result = await git(root, ["cat-file", "-e", `${tree}^{tree}`]);
  return result.code === 0;
}

/**
 * Puts the files a run changed back to their state before the run. Refuses
 * when any of those files changed again after the run, so later work by the
 * user or another thread is never overwritten.
 */
export async function restoreRun(
  root: string,
  before: string,
  after: string,
  files: FileChange[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (files.length === 0) return { ok: true };
  if (!(await treeExists(root, before))) {
    return { ok: false, error: "The snapshot for this turn is no longer available." };
  }
  const current = await snapshotTree(root);
  if (!current) return { ok: false, error: "Could not read the working tree." };

  const paths = files.map((file) => file.path);
  const drift = await git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--relative",
    after,
    current,
    "--",
    ...paths,
  ]);
  if (drift.code !== 0) return { ok: false, error: "Could not compare the working tree." };
  const changedSince = splitLines(drift.stdout).filter(Boolean);
  if (changedSince.length > 0) {
    const sample = changedSince.slice(0, 3).join(", ");
    return {
      ok: false,
      error: `Changed after this turn: ${sample}${changedSince.length > 3 ? "…" : ""}. Undo would overwrite that work.`,
    };
  }

  const toRestore = files.filter((file) => file.status !== "added").map((file) => file.path);
  if (toRestore.length) {
    const restore = await git(root, ["restore", `--source=${before}`, "--worktree", "--", ...toRestore]);
    if (restore.code !== 0) {
      return { ok: false, error: restore.stderr.trim() || "git restore failed." };
    }
  }
  for (const file of files) {
    if (file.status !== "added") continue;
    const target = resolve(root, file.path);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    rmSync(target, { force: true });
  }
  return { ok: true };
}
