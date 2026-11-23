/**
 * Platform half of the self-update: detect how this copy of Kip was installed,
 * stage a downloaded release, and swap the app after the user confirms a
 * restart.
 *
 * macOS direct (dmg) installs replace the `.app` bundle. Windows and Linux
 * installs live in Electrobun's `app` directory and are replaced from the
 * released `*-Kip.tar.zst` archive. Homebrew owns its Caskroom copy, so those
 * installs are told to run `brew upgrade --cask kip` instead.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ReleaseAsset, UpdateInstaller } from "./update-checker";

const APP_BUNDLE_NAME = "Kip.app";
const MAX_DOWNLOAD_MS = 10 * 60 * 1000;

/** `Bun.Archive` and `Bun.zstdDecompressSync` are runtime APIs the types miss. */
interface BunExtras {
  Archive: new (bytes: Uint8Array) => {
    extract(directory: string): Promise<void>;
  };
  zstdDecompressSync(data: Uint8Array): Uint8Array;
}
const bunExtras = Bun as unknown as BunExtras;

export interface BundleInfo {
  /** `<Name>.app` on macOS, Electrobun's `app` directory elsewhere. */
  appPath: string;
  source: "homebrew" | "direct" | "manual";
}

function platformTag(): "macos" | "win" | "linux" {
  if (process.platform === "darwin") return "macos";
  return process.platform === "win32" ? "win" : "linux";
}

function archTag(): string {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function cacheRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ai.kip.desktop", "updates");
  }
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "ai.kip.desktop", "updates");
  }
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "ai.kip.desktop", "updates");
}

/**
 * Resolves the installed app. A Homebrew cask installs the app under Caskroom
 * and symlinks it into /Applications, so the resolved path is what tells the
 * two install kinds apart.
 */
export function detectInstalledBundle(
  execPath: string = process.execPath,
): BundleInfo {
  const manual: BundleInfo = { appPath: "", source: "manual" };
  const resolved = safeRealpath(execPath);

  if (process.platform === "darwin") {
    const macosDir = dirname(resolved);
    const contentsDir = dirname(macosDir);
    const bundleDir = dirname(contentsDir);
    if (
      basename(macosDir) !== "MacOS" ||
      basename(contentsDir) !== "Contents" ||
      !bundleDir.endsWith(".app")
    ) {
      return manual;
    }
    if (
      bundleDir.startsWith("/Volumes/") ||
      bundleDir.includes("AppTranslocation")
    ) {
      return manual;
    }

    const appPath = safeRealpath(bundleDir);
    if (appPath.includes("/Caskroom/")) return { appPath, source: "homebrew" };
    return {
      appPath,
      source: isWritableDir(dirname(appPath)) ? "direct" : "manual",
    };
  }

  // Windows and Linux run `<app>/bin/bun.exe` (or `bin/bun`) from
  // `<LOCALAPPDATA|XDG_DATA_HOME>/ai.kip.desktop/<channel>/app/`.
  const binDir = dirname(resolved);
  const appDir = dirname(binDir);
  const launcher = join(
    binDir,
    process.platform === "win32" ? "launcher.exe" : "launcher",
  );
  if (basename(binDir) !== "bin" || !existsSync(launcher)) return manual;
  if (!isWritableDir(appDir)) return manual;
  return { appPath: appDir, source: "direct" };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isWritableDir(dir: string): boolean {
  const probe = join(dir, `.kip-update-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function pickAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const name =
    process.platform === "darwin"
      ? `stable-macos-${archTag()}-Kip.dmg`
      : `stable-${platformTag()}-${archTag()}-Kip.tar.zst`;
  return assets.find((asset) => asset.name === name) ?? null;
}

async function downloadAsset(
  asset: ReleaseAsset,
  destPath: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const response = await fetch(asset.url, {
    headers: { "User-Agent": "Kip/updater" },
    signal: AbortSignal.timeout(MAX_DOWNLOAD_MS),
  });
  if (!response.ok || !response.body)
    throw new Error(`download returned ${response.status}`);

  const total = Number(response.headers.get("content-length")) || asset.size;
  const reader = response.body.getReader();
  const sink = Bun.file(destPath).writer();
  let written = 0;
  let lastPercent = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
      written += value.byteLength;
      if (total > 0) {
        const percent = Math.min(99, Math.floor((written / total) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    }
  } finally {
    await sink.end();
  }

  if (asset.size > 0 && written !== asset.size) {
    rmSync(destPath, { force: true });
    throw new Error(`downloaded ${written} of ${asset.size} bytes`);
  }
}

/**
 * Decompresses a `tar.zst` release archive and returns the staged bundle path.
 * The archive holds one top-level directory (`Kip/`) with `bin/` and
 * `Resources/` inside.
 */
export async function extractBundleArchive(
  archivePath: string,
  destDir: string,
): Promise<string> {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const compressed = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  const tar = bunExtras.zstdDecompressSync(compressed);
  await new bunExtras.Archive(tar).extract(destDir);

  const launcher =
    process.platform === "win32" ? "bin/launcher.exe" : "bin/launcher";
  if (existsSync(join(destDir, launcher))) return destDir;
  const bundleName = readdirSync(destDir, { withFileTypes: true }).find(
    (entry) => entry.isDirectory(),
  );
  if (!bundleName) throw new Error("the archive is empty");
  const candidate = join(destDir, bundleName.name);
  if (!existsSync(join(candidate, launcher))) {
    throw new Error(`the archive has no ${launcher}`);
  }
  return candidate;
}

class MacInstaller implements UpdateInstaller {
  readonly source = "direct";
  private stagedApp: string | null = null;
  private stageDir: string | null = null;

  constructor(
    private readonly appPath: string,
    private readonly onQuit: () => void,
  ) {}

  async prepare(
    assets: ReleaseAsset[],
    version: string,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    const asset = pickAsset(assets);
    if (!asset) throw new Error("the release has no dmg for this architecture");

    const stageDir = join(cacheRoot(), version);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const dmgPath = join(stageDir, asset.name);
    const mountPoint = join(stageDir, "mnt");

    await downloadAsset(asset, dmgPath, onProgress);
    mkdirSync(mountPoint, { recursive: true });
    try {
      await run([
        "hdiutil",
        "attach",
        "-nobrowse",
        "-readonly",
        "-mountpoint",
        mountPoint,
        dmgPath,
      ]);
      const mountedApp = join(mountPoint, APP_BUNDLE_NAME);
      if (!existsSync(mountedApp))
        throw new Error(`the dmg does not contain ${APP_BUNDLE_NAME}`);
      const stagedApp = join(stageDir, APP_BUNDLE_NAME);
      await run(["ditto", mountedApp, stagedApp]);
      await run(["codesign", "--verify", "--deep", "--strict", stagedApp]);
      this.stagedApp = stagedApp;
      this.stageDir = stageDir;
    } finally {
      try {
        await run(["hdiutil", "detach", mountPoint]);
      } catch {
        // Already unmounted, or the volume went away with the dmg.
      }
      rmSync(mountPoint, { recursive: true, force: true });
      rmSync(dmgPath, { force: true });
    }
  }

  async apply(): Promise<boolean> {
    if (!this.stagedApp || !this.stageDir) return false;
    const scriptPath = join(this.stageDir, "apply.sh");
    writeFileSync(scriptPath, MAC_APPLY_SCRIPT, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);

    const helper = Bun.spawn(
      [
        "/bin/sh",
        scriptPath,
        String(process.pid),
        this.appPath,
        this.stagedApp,
        this.stageDir,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    helper.unref();
    // Give the RPC reply a moment to reach the view before quitting.
    setTimeout(this.onQuit, 300);
    return true;
  }
}

/** Windows and Linux: replace Electrobun's `app` directory from `tar.zst`. */
class ArchiveInstaller implements UpdateInstaller {
  readonly source = "direct";
  private stagedApp: string | null = null;
  private stageDir: string | null = null;

  constructor(
    private readonly appPath: string,
    private readonly onQuit: () => void,
  ) {}

  async prepare(
    assets: ReleaseAsset[],
    version: string,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    const asset = pickAsset(assets);
    if (!asset) throw new Error("the release has no archive for this platform");

    const stageDir = join(cacheRoot(), version);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const archivePath = join(stageDir, asset.name);
    await downloadAsset(asset, archivePath, onProgress);
    try {
      this.stagedApp = await extractBundleArchive(
        archivePath,
        join(stageDir, "extracted"),
      );
      this.stageDir = stageDir;
    } finally {
      rmSync(archivePath, { force: true });
    }
  }

  async apply(): Promise<boolean> {
    if (!this.stagedApp || !this.stageDir) return false;
    return process.platform === "win32"
      ? this.applyWindows()
      : this.applyLinux();
  }

  private applyWindows(): boolean {
    const taskName = `KipUpdate_${Date.now()}`;
    const scriptPath = join(dirname(this.appPath), "kip-update.bat");
    writeFileSync(
      scriptPath,
      windowsApplyScript(
        this.stageDir as string,
        this.stagedApp as string,
        this.appPath,
        taskName,
      ),
    );

    // Task Scheduler runs the swap independently of this process, so it can
    // finish after Kip exits and cannot be taken down with the console.
    try {
      runSync([
        "schtasks",
        "/create",
        "/tn",
        taskName,
        "/tr",
        scriptPath,
        "/sc",
        "once",
        "/st",
        "00:00",
        "/f",
      ]);
      runSync(["schtasks", "/run", "/tn", taskName]);
    } catch (error) {
      console.warn(
        `Update helper could not be scheduled: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    setTimeout(this.onQuit, 300);
    return true;
  }

  private applyLinux(): boolean {
    const scriptPath = join(this.stageDir as string, "apply.sh");
    writeFileSync(scriptPath, LINUX_APPLY_SCRIPT, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    const helper = Bun.spawn(
      [
        "/bin/sh",
        scriptPath,
        String(process.pid),
        this.appPath,
        this.stagedApp as string,
        this.stageDir as string,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    helper.unref();
    setTimeout(this.onQuit, 300);
    return true;
  }
}

const manualInstaller: UpdateInstaller = {
  source: "manual",
  prepare: async () => {
    throw new Error("this installation cannot replace itself");
  },
  apply: async () => false,
};

export function createUpdateInstaller(options: {
  onQuit: () => void;
  /** Test seam: pretend the app runs from this executable path. */
  execPath?: string;
}): UpdateInstaller {
  const bundle = detectInstalledBundle(options.execPath);
  if (bundle.source !== "direct")
    return { ...manualInstaller, source: bundle.source };
  if (process.platform === "darwin")
    return new MacInstaller(bundle.appPath, options.onQuit);
  return new ArchiveInstaller(bundle.appPath, options.onQuit);
}

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
    throw new Error(`${command[0]} failed: ${detail}`);
  }
  return stdout;
}

function runSync(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const detail = result.stderr.toString().trim() || `exit ${result.exitCode}`;
    throw new Error(`${command[0]} failed: ${detail}`);
  }
}

function windowsApplyScript(
  stageDir: string,
  stagedApp: string,
  appPath: string,
  taskName: string,
): string {
  // Electrobun's own updater uses the same sequence: the launcher, bun, and
  // the "bun Helper" processes keep the bundle's files locked for a while
  // after the app quits, so retry the delete before moving the new copy in.
  return `@echo off
setlocal

:waitloop
tasklist /FI "IMAGENAME eq launcher.exe" 2>NUL | find /I "launcher.exe">NUL && goto waitsleep
tasklist /FI "IMAGENAME eq bun.exe" 2>NUL | find /I "bun.exe">NUL && goto waitsleep
tasklist 2>NUL | find /I "bun Helper">NUL && goto waitsleep
goto waitdone
:waitsleep
timeout /t 1 /nobreak >nul
goto waitloop
:waitdone

timeout /t 2 /nobreak >nul

set rmRetry=0
:rmloop
if not exist "${appPath}" goto rmdone
rmdir /s /q "${appPath}" 2>nul
if not exist "${appPath}" goto rmdone
set /a rmRetry=rmRetry+1
if %rmRetry% GEQ 10 goto rmfailed
timeout /t 2 /nobreak >nul
goto rmloop
:rmfailed
exit /b 1
:rmdone

move "${stagedApp}" "${appPath}"
if not exist "${appPath}\\bin\\launcher.exe" exit /b 1

start "" "${appPath}\\bin\\launcher.exe"
rmdir /s /q "${stageDir}" 2>nul
schtasks /delete /tn "${taskName}" /f >nul 2>&1
del "%~f0"
`;
}

/**
 * Waits for Kip to exit, swaps the app directory, deletes the staging
 * directory, and reopens the launcher.
 */
const LINUX_APPLY_SCRIPT = `#!/bin/sh
set -eu

OLD_PID="$1"
TARGET_APP="$2"
STAGED_APP="$3"
STAGE_DIR="$4"

i=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    exit 1
  fi
  sleep 0.2
done
sleep 0.5

rm -rf "$TARGET_APP"
mv "$STAGED_APP" "$TARGET_APP"
chmod +x "$TARGET_APP/bin/launcher" 2>/dev/null || true
chmod +x "$TARGET_APP/bin/bun" 2>/dev/null || true
rm -rf "$STAGE_DIR" || true

cd "$TARGET_APP"
nohup ./bin/launcher >/dev/null 2>&1 &
`;

/**
 * Waits for Kip to exit, swaps the bundle with two renames on the same volume,
 * deletes the staging directory, and reopens the app.
 */
export const MAC_APPLY_SCRIPT = `#!/bin/sh
set -eu

OLD_PID="$1"
TARGET_APP="$2"
STAGED_APP="$3"
STAGE_DIR="$4"

i=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    exit 1
  fi
  sleep 0.2
done

PARENT_DIR=$(dirname "$TARGET_APP")
APP_NAME=$(basename "$TARGET_APP")
NEW_TMP="$PARENT_DIR/.$APP_NAME.new.$$"
OLD_TMP="$PARENT_DIR/.$APP_NAME.old.$$"

if ! /usr/bin/ditto "$STAGED_APP" "$NEW_TMP"; then
  rm -rf "$NEW_TMP"
  exit 1
fi
if ! mv "$TARGET_APP" "$OLD_TMP"; then
  rm -rf "$NEW_TMP"
  exit 1
fi
if ! mv "$NEW_TMP" "$TARGET_APP"; then
  mv "$OLD_TMP" "$TARGET_APP" || true
  rm -rf "$NEW_TMP"
  exit 1
fi
rm -rf "$OLD_TMP" "$STAGE_DIR" || true
/usr/bin/open "$TARGET_APP"
`;
