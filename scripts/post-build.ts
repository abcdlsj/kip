/**
 * Electrobun's `postBuild` hook.
 *
 * Electrobun allows a single script per hook, and we need two passes here: the
 * Windows icon embed and the macOS launcher patch for the real app bundle (the
 * one that ends up inside the self-extracting tarball). Both scripts are
 * already platform-gated, so running them unconditionally keeps this simple.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const steps = [
  "scripts/patch-macos-launcher.ts",
  "scripts/patch-windows-icons.ts",
];

for (const step of steps) {
  const result = Bun.spawnSync([process.execPath, step], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    console.error(`${step} failed with exit code ${result.exitCode}.`);
    process.exit(result.exitCode ?? 1);
  }
}
