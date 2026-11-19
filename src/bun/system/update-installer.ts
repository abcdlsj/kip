/**
 * Platform half of the self-update: detect how this copy of Kip was installed,
 * stage a downloaded release, and swap the bundle after the user confirms a
 * restart.
 *
 * Only direct (dmg) installs can replace themselves. Homebrew owns its Caskroom
 * copy, and Windows/Linux builds have no writable bundle to swap, so both fall
 * back to the release page or `brew upgrade`.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ReleaseAsset, UpdateInstaller } from "./update-checker";

const APP_BUNDLE_NAME = "Kip.app";
const CACHE_ROOT = join(homedir(), "Library", "Caches", "ai.kip.desktop", "updates");
const MAX_DOWNLOAD_MS = 10 * 60 * 1000;

export interface BundleInfo {
  appPath: string;
  source: "homebrew" | "direct" | "manual";
}

/**
 * Resolves the enclosing `.app` bundle. A Homebrew cask installs the app under
 * Caskroom and symlinks it into /Applications, so the resolved path is what
 * tells the two install kinds apart.
 */
export function detectInstalledBundle(execPath: string = process.execPath): BundleInfo {
  const manual: BundleInfo = { appPath: "", source: "manual" };
  if (process.platform !== "darwin") return manual;

  const resolved = safeRealpath(execPath);
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
  if (bundleDir.startsWith("/Volumes/") || bundleDir.includes("AppTranslocation")) {
    return manual;
  }

  const appPath = safeRealpath(bundleDir);
  if (appPath.includes("/Caskroom/")) return { appPath, source: "homebrew" };
  return { appPath, source: isWritableDir(dirname(appPath)) ? "direct" : "manual" };
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

/** Release dmgs are named `stable-macos-<arch>-Kip.dmg`. */
function pickDmg(assets: ReleaseAsset[]): ReleaseAsset | null {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return assets.find((asset) => asset.name === `stable-macos-${arch}-Kip.dmg`) ?? null;
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
    const asset = pickDmg(assets);
    if (!asset) throw new Error("the release has no dmg for this architecture");

    const stageDir = join(CACHE_ROOT, version);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const dmgPath = join(stageDir, asset.name);
    const mountPoint = join(stageDir, "mnt");

    await this.download(asset, dmgPath, onProgress);
    mkdirSync(mountPoint, { recursive: true });
    try {
      await run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
      const mountedApp = join(mountPoint, APP_BUNDLE_NAME);
      if (!existsSync(mountedApp)) throw new Error(`the dmg does not contain ${APP_BUNDLE_NAME}`);
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
    writeFileSync(scriptPath, APPLY_SCRIPT, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);

    const helper = Bun.spawn(
      ["/bin/sh", scriptPath, String(process.pid), this.appPath, this.stagedApp, this.stageDir],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    helper.unref();
    // Give the RPC reply a moment to reach the view before quitting.
    setTimeout(this.onQuit, 300);
    return true;
  }

  private async download(
    asset: ReleaseAsset,
    destPath: string,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    const response = await fetch(asset.url, {
      headers: { "User-Agent": "Kip/updater" },
      signal: AbortSignal.timeout(MAX_DOWNLOAD_MS),
    });
    if (!response.ok || !response.body) throw new Error(`download returned ${response.status}`);

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
  if (bundle.source === "direct") return new MacInstaller(bundle.appPath, options.onQuit);
  // Homebrew installs update through the cask; manual ones through the release
  // page. Both keep the checker in "available" and never stage a bundle.
  return { ...manualInstaller, source: bundle.source };
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

/**
 * Waits for Kip to exit, swaps the bundle with two renames on the same volume,
 * deletes the staging directory, and reopens the app.
 */
export const APPLY_SCRIPT = `#!/bin/sh
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
