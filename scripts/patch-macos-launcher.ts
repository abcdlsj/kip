/**
 * Patches the self-extracting app bundle that Electrobun wraps around the real
 * app. Runs from the postWrap hook, i.e. after the bundle is assembled and
 * before Electrobun codesigns it.
 *
 * 1. Electrobun's stable launcher is built with a macOS 14.8 deployment target,
 *    which makes the packaged app refuse to launch on macOS 13. The app itself
 *    runs on macOS 12+ (CEF renderer), so lower the launcher's recorded minimum
 *    OS version.
 * 2. Electrobun names the bundled executable "launcher", so `ps`, Activity
 *    Monitor and crash reports show "launcher" instead of the app name. Rename
 *    it to CFBundleName (and keep CFBundleExecutable in sync).
 */
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const LAUNCHER_NAME = "launcher";

if (process.platform !== "darwin") {
  console.log("Launcher patch skipped on this platform.");
  process.exit(0);
}

const explicit = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
const candidates: string[] = [];
if (explicit) {
  candidates.push(explicit);
} else {
  const buildRoot = join(import.meta.dir, "..", "build");
  if (existsSync(buildRoot)) {
    for (const folder of readdirSync(buildRoot)) {
      const appRoot = join(buildRoot, folder);
      try {
        for (const entry of readdirSync(appRoot)) {
          if (entry.endsWith(".app")) candidates.push(join(appRoot, entry));
        }
      } catch {
        // Ignore non-directory build entries.
      }
    }
  }
}

let patched = 0;
for (const bundle of new Set(candidates)) {
  const launcher = join(bundle, "Contents", "MacOS", LAUNCHER_NAME);
  if (!existsSync(launcher)) continue;
  const temp = `${launcher}.patched`;
  const result = Bun.spawnSync(
    ["vtool", "-set-build-version", "macos", "11.0", "14.8.5", "-replace", "-output", temp, launcher],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    console.warn(`Could not patch launcher at ${launcher}; vtool is required for macOS 13 support.`);
    continue;
  }
  renameSync(temp, launcher);
  renameExecutableToAppName(bundle);
  patchPlist(bundle);
  reSign(bundle);
  patched += 1;
}

if (patched === 0) {
  console.warn("No launcher was patched.");
} else {
  console.log(`Patched ${patched} macOS launcher(s) for macOS 12+.`);
}

/**
 * Electrobun hardcodes the wrapper's executable as Contents/MacOS/launcher and
 * sets CFBundleExecutable to match. Rename both to CFBundleName so the process
 * is reported as "Kip". The self-extractor derives its own paths from
 * __NSGetExecutablePath, so the file name carries no meaning to it; changing
 * only the Info.plist would make LaunchServices fail to find the executable.
 */
function renameExecutableToAppName(bundle: string): void {
  const plist = join(bundle, "Contents", "Info.plist");
  const macos = join(bundle, "Contents", "MacOS");
  const launcher = join(macos, LAUNCHER_NAME);
  if (!existsSync(launcher) || !existsSync(plist)) return;

  const appName = plistValue(plist, ":CFBundleName");
  if (!appName) {
    console.warn(`No CFBundleName in ${plist}; keeping executable "${LAUNCHER_NAME}".`);
    return;
  }
  if (appName === LAUNCHER_NAME) return;

  const renamed = join(macos, appName);
  renameSync(launcher, renamed);

  const set = Bun.spawnSync(
    ["/usr/libexec/PlistBuddy", "-c", `Set :CFBundleExecutable "${appName}"`, plist],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (set.exitCode !== 0) {
    renameSync(renamed, launcher);
    console.warn(
      `Could not set CFBundleExecutable=${appName} in ${plist}: ${set.stderr.toString().trim()}`,
    );
    return;
  }
  console.log(`Renamed macOS executable ${LAUNCHER_NAME} -> ${appName}.`);
}

function plistValue(plist: string, key: string): string | undefined {
  const read = Bun.spawnSync(
    ["/usr/libexec/PlistBuddy", "-c", `Print ${key}`, plist],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (read.exitCode !== 0) return undefined;
  const value = read.stdout.toString().trim();
  return value.length > 0 ? value : undefined;
}

function patchPlist(bundle: string): void {
  const plist = join(bundle, "Contents", "Info.plist");
  if (!existsSync(plist)) return;
  const check = Bun.spawnSync(
    ["/usr/libexec/PlistBuddy", "-c", "Print :LSMinimumSystemVersion", plist],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (check.exitCode === 0) return;
  Bun.spawnSync(
    [
      "/usr/libexec/PlistBuddy",
      "-c",
      "Add :LSMinimumSystemVersion string 12.0",
      plist,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}

/**
 * vtool rewrites the launcher's Mach-O, which leaves the bundle with a linker
 * signature that no longer seals the resources. Gatekeeper then reports the app
 * as damaged instead of merely unidentified. Re-sign the whole bundle ad hoc so
 * the signature verifies; a real Developer ID configured in electrobun's build
 * config still replaces this signature afterwards, since postWrap runs before
 * its codesign step.
 */
function reSign(bundle: string): void {
  const sign = Bun.spawnSync(
    ["codesign", "--force", "--deep", "--sign", "-", bundle],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (sign.exitCode !== 0) {
    console.warn(
      `Ad-hoc signing failed for ${bundle}: ${sign.stderr.toString().trim()}`,
    );
    return;
  }
  const verify = Bun.spawnSync(
    ["codesign", "--verify", "--deep", "--strict", bundle],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (verify.exitCode !== 0) {
    console.warn(
      `Signature still invalid for ${bundle}: ${verify.stderr.toString().trim()}`,
    );
  }
}
