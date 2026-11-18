/**
 * Windows icon embedding, run as the Electrobun `postBuild` hook.
 *
 * Electrobun does try to embed `build.win.icon`, but the shipped CLI resolves
 * `rcedit/package.json` against its own compile-time path, so on every Windows
 * build all three embeds fail with `Cannot find module .../rcedit/package.json`.
 * The exes then keep Electrobun's default icon, which is why the installed
 * desktop shortcut shows the wrong one. We run rcedit ourselves instead.
 *
 * Targets:
 *   bin/launcher.exe            — what the desktop/start-menu shortcut runs.
 *                                 It ships with no resources at all, so the
 *                                 install fell back to Electrobun's default.
 *   <dist>/extractor.exe        — copied into Kip-Setup.exe right after this
 *                                 hook, so the installer gets the icon too.
 *
 * bun.exe is deliberately left alone: rcedit can only add a second icon group
 * next to bun's own (Explorer keeps showing the first), so patching it would
 * rewrite a 116 MB runtime for nothing. The taskbar therefore still shows the
 * Bun icon until Electrobun exposes its native setWindowIcon.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
const targetOS = process.env.ELECTROBUN_OS;
const targetArch = process.env.ELECTROBUN_ARCH ?? "x64";
const iconPath = join(root, "assets", "icon.ico");

function rceditBinary(): string {
  const bin = join(root, "node_modules", "rcedit", "bin");
  const x64 = join(bin, "rcedit-x64.exe");
  return existsSync(x64) ? x64 : join(bin, "rcedit.exe");
}

function embedIcon(exePath: string): void {
  if (!existsSync(exePath)) {
    console.warn(`Windows icon: ${basename(exePath)} not found, skipping.`);
    return;
  }
  const before = statSync(exePath).size;
  const result = spawnSync(rceditBinary(), [exePath, "--set-icon", iconPath], {
    encoding: "utf8",
  });
  const after = statSync(exePath).size;
  const detail = [result.stdout, result.stderr].map((part) => part?.trim()).filter(Boolean).join(" ");
  if (result.status !== 0 || after === before) {
    throw new Error(
      `rcedit did not embed the icon into ${basename(exePath)} ` +
        `(status ${result.status}, ${before} -> ${after} bytes)${detail ? `: ${detail}` : ""}`,
    );
  }
  console.log(`Windows icon: embedded into ${basename(exePath)} (${before} -> ${after} bytes).`);
}

// Electrobun's own embed only runs on Windows hosts, and rcedit.exe is a Windows
// binary, so there is nothing to do for other targets or other build machines.
if (targetOS !== "win" || process.platform !== "win32") {
  console.log("Windows icon: skipped (not a Windows build on Windows).");
} else if (!existsSync(iconPath)) {
  console.warn(`Windows icon: ${iconPath} is missing, skipping.`);
} else if (!buildDir || !appName) {
  console.warn("Windows icon: ELECTROBUN_BUILD_DIR/APP_NAME not set, skipping.");
} else {
  embedIcon(join(buildDir, appName, "bin", "launcher.exe"));
  embedIcon(
    join(root, "node_modules", "electrobun", `dist-win-${targetArch}`, "extractor.exe"),
  );
}
