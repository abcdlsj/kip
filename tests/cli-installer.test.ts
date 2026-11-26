import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCliStatus,
  installCli,
  isKipShim,
  renderShimContent,
  resolveCliRuntime,
  uninstallCli,
} from "../src/bun/system/cli-installer";

const temps: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli-installer", () => {
  test("resolves CLI runtime from a packaged macOS .app bundle", () => {
    const root = makeTempDir("kip-mac-app-");
    const macosDir = join(root, "Kip.app", "Contents", "MacOS");
    const cliDir = join(root, "Kip.app", "Contents", "Resources", "app", "cli");
    mkdirSync(macosDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    const bunPath = join(macosDir, "bun");
    const entryPath = join(cliDir, "kip-cli.js");
    writeFileSync(bunPath, "");
    writeFileSync(entryPath, "// cli");

    const runtime = resolveCliRuntime({
      platform: "darwin",
      execPath: bunPath,
      cwd: root,
    });
    expect(runtime).toEqual({ bunPath, entryPath });
  });

  test("resolves CLI runtime from a packaged Linux/Windows app directory", () => {
    const root = makeTempDir("kip-linux-app-");
    const binDir = join(root, "app", "bin");
    const cliDir = join(root, "app", "Resources", "app", "cli");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    const bunPath = join(binDir, "bun");
    const entryPath = join(cliDir, "kip-cli.js");
    writeFileSync(bunPath, "");
    writeFileSync(entryPath, "// cli");

    const runtime = resolveCliRuntime({
      platform: "linux",
      execPath: bunPath,
      cwd: root,
    });
    expect(runtime).toEqual({ bunPath, entryPath });
  });

  test("renders safely quoted POSIX and Windows shims", () => {
    const posix = renderShimContent(
      {
        bunPath: "/Applications/Kip's App.app/Contents/MacOS/bun",
        entryPath:
          "/Applications/Kip's App.app/Contents/Resources/app/cli/kip-cli.js",
      },
      "darwin",
    );
    expect(posix).toContain("#!/usr/bin/env bash");
    expect(posix).toContain("# Installed by Kip");
    expect(posix).toContain("exec -a kip ");
    expect(posix).toContain("Kip'\\''s App.app");
    expect(posix).toContain('"$@"');

    const win = renderShimContent(
      {
        bunPath: "C:\\Program Files\\Kip\\bin\\bun.exe",
        entryPath: "C:\\Program Files\\Kip\\Resources\\app\\cli\\kip-cli.js",
      },
      "win32",
    );
    expect(win).toContain("@echo off");
    expect(win).toContain("REM Installed by Kip");
    expect(win).toContain("%*");
  });

  test("installs, detects outdated shim, updates, and uninstalls cleanly", () => {
    const root = makeTempDir("kip-install-");
    const binDir = join(root, "bin");
    const homeDir = join(root, "home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    const appV1 = join(root, "v1", "Kip.app");
    const bunV1 = join(appV1, "Contents", "MacOS", "bun");
    const cliV1 = join(
      appV1,
      "Contents",
      "Resources",
      "app",
      "cli",
      "kip-cli.js",
    );
    mkdirSync(join(appV1, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appV1, "Contents", "Resources", "app", "cli"), {
      recursive: true,
    });
    writeFileSync(bunV1, "");
    writeFileSync(cliV1, "// v1");

    const opts = {
      platform: "darwin" as const,
      execPath: bunV1,
      cwd: root,
      homeDir,
      candidateDirs: [binDir],
      pathEntries: [binDir],
    };

    const before = getCliStatus(opts);
    expect(before.installed).toBe(false);
    expect(before.available).toBe(true);
    expect(before.inPath).toBe(true);
    expect(before.targetPath).toBe(join(binDir, "kip"));

    const after = installCli(opts);
    expect(after.installed).toBe(true);
    expect(after.outdated).toBe(false);
    expect(after.installPath).toBe(join(binDir, "kip"));
    expect(isKipShim(join(binDir, "kip"))).toBe(true);
    expect(statSync(join(binDir, "kip")).mode & 0o111).toBeGreaterThan(0);

    // Move app to v2; existing shim should report outdated.
    const appV2 = join(root, "v2", "Kip.app");
    const bunV2 = join(appV2, "Contents", "MacOS", "bun");
    const cliV2 = join(
      appV2,
      "Contents",
      "Resources",
      "app",
      "cli",
      "kip-cli.js",
    );
    mkdirSync(join(appV2, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appV2, "Contents", "Resources", "app", "cli"), {
      recursive: true,
    });
    writeFileSync(bunV2, "");
    writeFileSync(cliV2, "// v2");

    const optsV2 = { ...opts, execPath: bunV2 };
    expect(getCliStatus(optsV2).outdated).toBe(true);

    const updated = installCli(optsV2);
    expect(updated.installed).toBe(true);
    expect(updated.outdated).toBe(false);
    expect(readFileSync(join(binDir, "kip"), "utf8")).toContain(cliV2);

    const removed = uninstallCli(optsV2);
    expect(removed.installed).toBe(false);
    expect(existsSync(join(binDir, "kip"))).toBe(false);
  });

  test("refuses to overwrite or uninstall a non-Kip binary and falls back to next candidate dir", () => {
    const root = makeTempDir("kip-conflict-");
    const primaryDir = join(root, "primary");
    const fallbackDir = join(root, "fallback");
    const appDir = join(root, "Kip.app");
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(fallbackDir, { recursive: true });
    mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appDir, "Contents", "Resources", "app", "cli"), {
      recursive: true,
    });

    const foreign = join(primaryDir, "kip");
    writeFileSync(foreign, "#!/bin/sh\necho unrelated\n");
    const bunPath = join(appDir, "Contents", "MacOS", "bun");
    const cliPath = join(
      appDir,
      "Contents",
      "Resources",
      "app",
      "cli",
      "kip-cli.js",
    );
    writeFileSync(bunPath, "");
    writeFileSync(cliPath, "// cli");

    const opts = {
      platform: "darwin" as const,
      execPath: bunPath,
      cwd: root,
      homeDir: root,
      candidateDirs: [primaryDir, fallbackDir],
      pathEntries: [primaryDir],
    };

    const status = installCli(opts);
    expect(status.installed).toBe(true);
    expect(status.installPath).toBe(join(fallbackDir, "kip"));
    expect(status.inPath).toBe(false);
    expect(status.pathHint).toContain("export PATH=");
    expect(readFileSync(foreign, "utf8")).toContain("unrelated");

    // Uninstalling must leave the unrelated binary untouched.
    uninstallCli(opts);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(fallbackDir, "kip"))).toBe(false);
  });
});
