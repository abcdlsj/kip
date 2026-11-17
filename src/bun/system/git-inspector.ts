/** Non-blocking Git metadata reads for the workspace switcher and top bar. */
export async function inspectGit(rootPath: string): Promise<{
  branch: string | null;
  dirtyFiles: number;
}> {
  try {
    const branch = await run(["git", "-C", rootPath, "branch", "--show-current"]);
    const status = await run(["git", "-C", rootPath, "status", "--porcelain"]);
    const dirty = status.split("\n").filter((line) => line.trim().length > 0).length;
    return {
      branch: branch.trim() || null,
      dirtyFiles: dirty,
    };
  } catch {
    return { branch: null, dirtyFiles: 0 };
  }
}

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error("git command failed");
  return stdout;
}
