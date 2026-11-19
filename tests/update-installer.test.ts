import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUpdateInstaller,
  detectInstalledBundle,
  extractBundleArchive,
} from "../src/bun/system/update-installer";

const onDarwin = process.platform === "darwin";

let root = "";

beforeEach(() => {
  // macOS reports the canonical /private/var path, so keep the root canonical.
  root = realpathSync(mkdtempSync(join(tmpdir(), "kip-install-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Builds `<parent>/Kip.app/Contents/MacOS/Kip` and returns the executable path. */
function fakeApp(parent: string): string {
  const exe = join(parent, "Kip.app", "Contents", "MacOS", "Kip");
  mkdirSync(join(parent, "Kip.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(exe, "");
  return exe;
}

describe("update install source", () => {
  test("a plain .app is a direct install that can replace itself", () => {
    if (!onDarwin) return;
    const exe = fakeApp(join(root, "Applications"));
    const info = detectInstalledBundle(exe);
    expect(info.source).toBe("direct");
    expect(info.appPath).toBe(join(root, "Applications", "Kip.app"));
  });

  test("a Caskroom bundle is owned by Homebrew", () => {
    if (!onDarwin) return;
    const caskroom = join(root, "Caskroom", "kip", "0.2.2");
    const info = detectInstalledBundle(fakeApp(caskroom));
    expect(info.source).toBe("homebrew");
    expect(info.appPath).toBe(join(caskroom, "Kip.app"));
  });

  test("the /Applications symlink resolves to the Homebrew bundle", () => {
    if (!onDarwin) return;
    const caskroom = join(root, "Caskroom", "kip", "0.2.2");
    fakeApp(caskroom);
    const installed = join(root, "Applications");
    mkdirSync(installed, { recursive: true });
    const link = join(installed, "Kip.app");
    Bun.spawnSync(["ln", "-s", join(caskroom, "Kip.app"), link]);
    const info = detectInstalledBundle(join(link, "Contents", "MacOS", "Kip"));
    expect(info.source).toBe("homebrew");
  });

  test("a read-only location cannot be replaced", () => {
    if (!onDarwin) return;
    const bundle = join(root, "readonly", "Kip.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "MacOS", "Kip"), "");
    Bun.spawnSync(["chmod", "0555", join(root, "readonly")]);
    try {
      expect(detectInstalledBundle(join(bundle, "Contents", "MacOS", "Kip")).source).toBe("manual");
    } finally {
      Bun.spawnSync(["chmod", "0755", join(root, "readonly")]);
    }
  });

  test("anything outside a bundle falls back to the release page", () => {
    expect(detectInstalledBundle(join(root, "bun")).source).toBe("manual");
    expect(createUpdateInstaller({ onQuit: () => {}, execPath: join(root, "bun") }).source).toBe(
      "manual",
    );
  });
});

describe("release archive", () => {
  const zstd = Bun as unknown as { zstdCompressSync(data: Uint8Array): Uint8Array };

  async function makeArchive(archivePath: string, bundleName: string): Promise<void> {
    const source = join(root, "source");
    mkdirSync(join(source, bundleName, "bin"), { recursive: true });
    writeFileSync(join(source, bundleName, "bin", "launcher"), "#!/bin/sh\n");
    const tarPath = join(root, "bundle.tar");
    const tar = Bun.spawnSync(["tar", "-cf", tarPath, "-C", source, bundleName]);
    expect(tar.success).toBe(true);
    const bytes = new Uint8Array(await Bun.file(tarPath).arrayBuffer());
    await Bun.write(archivePath, zstd.zstdCompressSync(bytes));
  }

  test("extracts the tar.zst and returns the bundle inside it", async () => {
    const archivePath = join(root, "stable-linux-x64-Kip.tar.zst");
    await makeArchive(archivePath, "Kip");
    const bundle = await extractBundleArchive(archivePath, join(root, "extracted"));
    expect(bundle).toBe(join(root, "extracted", "Kip"));
    expect(existsSync(join(bundle, "bin", "launcher"))).toBe(true);
  });

  test("rejects an archive without a launcher", async () => {
    const archivePath = join(root, "broken.tar.zst");
    const tarPath = join(root, "broken.tar");
    mkdirSync(join(root, "empty"), { recursive: true });
    Bun.spawnSync(["tar", "-cf", tarPath, "-C", join(root, "empty"), "."]);
    const bytes = new Uint8Array(await Bun.file(tarPath).arrayBuffer());
    await Bun.write(archivePath, zstd.zstdCompressSync(bytes));
    await expect(extractBundleArchive(archivePath, join(root, "extracted"))).rejects.toThrow();
  });
});

describe("Electrobun app directory", () => {
  test.skipIf(process.platform === "darwin")("is replaceable when bin/ is writable", () => {
    const appDir = join(root, "ai.kip.desktop", "stable", "app");
    mkdirSync(join(appDir, "bin"), { recursive: true });
    const launcher = process.platform === "win32" ? "launcher.exe" : "launcher";
    writeFileSync(join(appDir, "bin", launcher), "");
    writeFileSync(join(appDir, "bin", "bun"), "");
    const info = detectInstalledBundle(join(appDir, "bin", "bun"));
    expect(info.source).toBe("direct");
    expect(info.appPath).toBe(appDir);
  });
});
