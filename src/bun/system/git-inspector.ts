/**
 * Non-blocking Git metadata reads for the workspace switcher and top bar.
 * Uses a single `git status --porcelain=v2 --branch` spawn to keep latency low
 * across all platforms (especially Windows where process spawning is costlier).
 */
import { splitLines } from "./platform";

export async function inspectGit(rootPath: string): Promise<{
  branch: string | null;
  dirtyFiles: number;
}> {
  try {
    const output = await run([
      "git",
      "-C",
      rootPath,
      "status",
      "--porcelain=v2",
      "--branch",
    ]);
    let branch: string | null = null;
    let oid: string | null = null;
    let dirtyFiles = 0;
    for (const line of splitLines(output)) {
      if (!line) continue;
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        branch = value === "(detached)" ? null : value || null;
      } else if (line.startsWith("# branch.oid ")) {
        const value = line.slice("# branch.oid ".length).trim();
        oid = value === "(initial)" ? null : value.slice(0, 7);
      } else if (!line.startsWith("# ")) {
        dirtyFiles += 1;
      }
    }
    return {
      branch: branch ?? (oid ? `detached@${oid}` : null),
      dirtyFiles,
    };
  } catch {
    return { branch: null, dirtyFiles: 0 };
  }
}

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error("git command failed");
  return stdout;
}
