/**
 * Installs and manages the `kip` command-line shim on the user's PATH.
 *
 * The shim invokes Kip's own bundled Bun executable with the bundled CLI
 * entrypoint (`cli/kip-cli.js` inside packaged builds, or the local repo build
 * in development), so the CLI needs no external runtime and stays in sync with
 * the installed app automatically.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { CliInstallStatus } from "../../shared/types";
import { safeChmod, userHome } from "./platform";

const POSIX_MARKER = "# Installed by Kip";
const WINDOWS_MARKER = "REM Installed by Kip";
const COMMAND_NAME_POSIX = "kip";
const COMMAND_NAME_WIN = "kip.cmd";

export interface CliRuntimePaths {
  bunPath: string;
  entryPath: string;
}

export interface CliInstallerOptions {
  /** Test seam: platform override. */
  platform?: NodeJS.Platform;
  /** Test seam: Bun executable path override. */
  execPath?: string;
  /** Test seam: working directory override. */
  cwd?: string;
  /** Test seam: home directory override. */
  homeDir?: string;
  /** Test seam: environment override. */
  env?: Record<string, string | undefined>;
  /** Test seam: explicit candidate bin directories in priority order. */
  candidateDirs?: string[];
  /** Test seam: explicit PATH entries instead of querying process/login shell. */
  pathEntries?: string[];
  /** Test seam: skip mutating Windows user PATH via PowerShell. */
  skipSystemPathMutation?: boolean;
}

let cachedLoginPath: string[] | null = null;

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function shellQuotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderShimContent(
  runtime: CliRuntimePaths,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "@echo off",
      WINDOWS_MARKER,
      `"${runtime.bunPath}" "${runtime.entryPath}" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    POSIX_MARKER,
    `exec ${shellQuotePosix(runtime.bunPath)} ${shellQuotePosix(runtime.entryPath)} "$@"`,
    "",
  ].join("\n");
}

export function isKipShim(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    const head = readFileSync(filePath, "utf8").slice(0, 512);
    return head.includes(POSIX_MARKER) || head.includes(WINDOWS_MARKER);
  } catch {
    return false;
  }
}

function isWritableDirectory(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const probe = join(dir, `.kip-cli-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function commandNameFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? COMMAND_NAME_WIN : COMMAND_NAME_POSIX;
}

/**
 * Resolves Kip's bundled Bun executable and CLI entrypoint. Checks packaged
 * Electrobun app bundles first (macOS `.app`, Linux/Windows `bin/`), then
 * local repo outputs for development.
 */
export function resolveCliRuntime(
  options: Pick<CliInstallerOptions, "execPath" | "cwd" | "platform"> = {},
): CliRuntimePaths | null {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const resolvedExec = safeRealpath(execPath);
  const execDir = dirname(resolvedExec);

  // 1. Packaged macOS app: <App>.app/Contents/MacOS/bun -> Contents/Resources/app/cli/kip-cli.js
  if (platform === "darwin" && basename(execDir) === "MacOS") {
    const contentsDir = dirname(execDir);
    const bundledEntry = join(
      contentsDir,
      "Resources",
      "app",
      "cli",
      "kip-cli.js",
    );
    if (existsSync(bundledEntry)) {
      // Preserve the non-realpath symlink path when present (e.g. /Applications/Kip.app)
      // so Homebrew or direct updates keep the shim pointing at the stable app path.
      const stableContents = dirname(dirname(execPath));
      const stableEntry = join(
        stableContents,
        "Resources",
        "app",
        "cli",
        "kip-cli.js",
      );
      if (existsSync(stableEntry)) {
        return { bunPath: execPath, entryPath: stableEntry };
      }
      return { bunPath: resolvedExec, entryPath: bundledEntry };
    }
  }

  // 2. Packaged Linux / Windows app: <app>/bin/bun(.exe) -> <app>/Resources/app/cli/kip-cli.js
  if (basename(execDir) === "bin") {
    const appDir = dirname(execDir);
    const bundledEntry = join(appDir, "Resources", "app", "cli", "kip-cli.js");
    if (existsSync(bundledEntry)) {
      const stableEntry = join(
        dirname(dirname(execPath)),
        "Resources",
        "app",
        "cli",
        "kip-cli.js",
      );
      if (existsSync(stableEntry)) {
        return { bunPath: execPath, entryPath: stableEntry };
      }
      return { bunPath: resolvedExec, entryPath: bundledEntry };
    }
  }

  // 3. Development repo fallbacks.
  const roots = [
    options.cwd ?? process.cwd(),
    resolve(import.meta.dir, "..", "..", ".."),
  ];
  for (const root of roots) {
    const built = join(root, "dist-cli", "kip-cli.js");
    if (existsSync(built)) return { bunPath: execPath, entryPath: built };
    const source = join(root, "src", "cli", "index.ts");
    if (existsSync(source)) return { bunPath: execPath, entryPath: source };
  }

  return null;
}

export function defaultCandidateDirs(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(base, "Programs", "Kip", "bin")];
  }
  if (platform === "darwin") {
    return ["/usr/local/bin", "/opt/homebrew/bin", join(home, ".local", "bin")];
  }
  return ["/usr/local/bin", join(home, ".local", "bin")];
}

function readEffectivePath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  override?: string[],
): string[] {
  if (override) return override;
  const raw = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  const entries = raw
    .split(sep)
    .map((entry) => entry.trim())
    .filter(Boolean);

  // macOS GUI apps launched from Finder inherit a minimal PATH without Homebrew
  // or user shell directories. Query the user's login shell once so status stays
  // accurate without claiming `/opt/homebrew/bin` or `~/.local/bin` is missing.
  if (platform === "darwin") {
    if (cachedLoginPath === null) {
      cachedLoginPath = probeLoginShellPath(env);
    }
    for (const dir of cachedLoginPath) {
      if (!entries.includes(dir)) entries.push(dir);
    }
  }
  return entries;
}

function probeLoginShellPath(
  env: Record<string, string | undefined>,
): string[] {
  const shell = env.SHELL || "/bin/zsh";
  try {
    const result = Bun.spawnSync([shell, "-lc", 'printf "%s" "$PATH"'], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 1500,
    });
    if (!result.success) return [];
    return result.stdout
      .toString("utf8")
      .split(":")
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isDirInPath(
  dir: string,
  pathEntries: string[],
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string) => {
    const cleaned = value.replace(/[\\/]+$/, "");
    return platform === "win32" ? cleaned.toLowerCase() : cleaned;
  };
  const target = normalize(dir);
  const realTarget = normalize(safeRealpath(dir));
  return pathEntries.some((entry) => {
    const norm = normalize(entry);
    return norm === target || norm === realTarget;
  });
}

function buildPathHint(
  dir: string,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "win32") {
    return `Add ${dir} to your User PATH environment variable.`;
  }
  const display = dir.startsWith(home) ? `$HOME${dir.slice(home.length)}` : dir;
  return `export PATH="${display}:$PATH"`;
}

function chooseTargetDir(
  dirs: string[],
  pathEntries: string[],
  platform: NodeJS.Platform,
  cmdName: string,
): { dir: string; conflict?: string } {
  // Prefer a directory that is already on PATH, writable, and not occupied by an unrelated `kip`.
  const ordered = [
    ...dirs.filter((dir) => isDirInPath(dir, pathEntries, platform)),
    ...dirs.filter((dir) => !isDirInPath(dir, pathEntries, platform)),
  ];

  let conflictPath: string | undefined;
  for (const dir of ordered) {
    const candidate = join(dir, cmdName);
    if (existsSync(candidate) && !isKipShim(candidate)) {
      conflictPath ??= candidate;
      continue;
    }
    if (isWritableDirectory(dir)) {
      return { dir };
    }
  }

  // Last resort: the final directory (typically `~/.local/bin` or `%LOCALAPPDATA%\Programs\Kip\bin`),
  // which we can create on install.
  const fallback = dirs[dirs.length - 1] ?? ordered[0] ?? ".";
  return { dir: fallback, conflict: conflictPath };
}

export function getCliStatus(
  options: CliInstallerOptions = {},
): CliInstallStatus {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? userHome();
  const env = options.env ?? process.env;
  const cmdName = commandNameFor(platform);
  const dirs =
    options.candidateDirs ?? defaultCandidateDirs(platform, home, env);
  const pathEntries = readEffectivePath(platform, env, options.pathEntries);
  const runtime = resolveCliRuntime(options);
  const expectedContent = runtime
    ? renderShimContent(runtime, platform).trim()
    : null;

  // Locate an existing Kip-owned shim across all candidate directories.
  let installedPath: string | null = null;
  for (const dir of dirs) {
    const candidate = join(dir, cmdName);
    if (isKipShim(candidate)) {
      installedPath = candidate;
      break;
    }
  }

  const chosen = chooseTargetDir(dirs, pathEntries, platform, cmdName);
  const targetPath = installedPath ?? join(chosen.dir, cmdName);
  const activeDir = dirname(targetPath);
  const inPath = isDirInPath(activeDir, pathEntries, platform);

  let outdated = false;
  if (installedPath && expectedContent) {
    try {
      const current = readFileSync(installedPath, "utf8").trim();
      outdated = current !== expectedContent;
    } catch {
      outdated = true;
    }
  }

  let reason: string | undefined;
  if (!runtime) {
    reason =
      "CLI bundle was not found in this build. Run `bun run build:cli` or reinstall Kip.";
  } else if (!installedPath && chosen.conflict) {
    reason = `An existing \`kip\` command at ${chosen.conflict} was not installed by Kip; installing to ${targetPath} instead.`;
  }

  return {
    installed: installedPath !== null,
    installPath: installedPath,
    targetPath,
    inPath,
    outdated,
    available: runtime !== null,
    reason,
    pathHint: inPath ? undefined : buildPathHint(activeDir, home, platform),
  };
}

export function installCli(
  options: CliInstallerOptions = {},
): CliInstallStatus {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? userHome();
  const env = options.env ?? process.env;
  const cmdName = commandNameFor(platform);
  const dirs =
    options.candidateDirs ?? defaultCandidateDirs(platform, home, env);
  const pathEntries = readEffectivePath(platform, env, options.pathEntries);
  const runtime = resolveCliRuntime(options);

  if (!runtime) {
    return getCliStatus(options);
  }

  // Reuse an existing Kip shim location if writable; otherwise pick the best target.
  let targetPath: string | null = null;
  for (const dir of dirs) {
    const candidate = join(dir, cmdName);
    if (isKipShim(candidate) && isWritableDirectory(dir)) {
      targetPath = candidate;
      break;
    }
  }

  if (!targetPath) {
    const chosen = chooseTargetDir(dirs, pathEntries, platform, cmdName);
    targetPath = join(chosen.dir, cmdName);
  }

  const targetDir = dirname(targetPath);
  if (existsSync(targetPath) && !isKipShim(targetPath)) {
    throw new Error(
      `Refusing to overwrite ${targetPath}: it was not installed by Kip.`,
    );
  }

  mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  const content = renderShimContent(runtime, platform);
  writeFileSync(targetPath, content, { encoding: "utf8", mode: 0o755 });
  if (platform !== "win32") {
    try {
      chmodSync(targetPath, 0o755);
    } catch {
      safeChmod(targetPath, 0o755);
    }
  } else if (!options.skipSystemPathMutation) {
    ensureWindowsUserPath(targetDir);
  }

  // Refresh login PATH cache after install so status reflects any change.
  cachedLoginPath = null;
  return getCliStatus(options);
}

export function uninstallCli(
  options: CliInstallerOptions = {},
): CliInstallStatus {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? userHome();
  const env = options.env ?? process.env;
  const cmdName = commandNameFor(platform);
  const dirs =
    options.candidateDirs ?? defaultCandidateDirs(platform, home, env);

  for (const dir of dirs) {
    const candidate = join(dir, cmdName);
    if (isKipShim(candidate)) {
      rmSync(candidate, { force: true });
    }
  }

  return getCliStatus(options);
}

function ensureWindowsUserPath(binDir: string): void {
  const escaped = binDir.replaceAll("'", "''");
  const script = [
    `$dir = '${escaped}'`,
    `$current = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `$parts = @()`,
    `if ($current) { $parts = $current.Split(';') | Where-Object { $_ -ne '' } }`,
    `if (-not ($parts | Where-Object { $_.TrimEnd('\\').ToLowerInvariant() -eq $dir.TrimEnd('\\').ToLowerInvariant() })) {`,
    `  $next = ($parts + $dir) -join ';'`,
    `  [Environment]::SetEnvironmentVariable('Path', $next, 'User')`,
    `}`,
  ].join("; ");
  Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdout: "pipe", stderr: "pipe" },
  );
}
