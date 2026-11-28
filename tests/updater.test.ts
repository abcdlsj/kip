import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  generateKeyPairSync,
  type KeyObject,
  sign as cryptoSign,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_SLUG,
  canonicalAssetPayload,
  compareSemver,
  consumeHandoffFile,
  decodeVerifyingKey,
  EXPECTED_BUNDLE_ID,
  EXPECTED_BUNDLE_NAME,
  formatSemver,
  HANDOFF_TTL_MS,
  inspectAppBundlePath,
  isNewerSemver,
  parseSemver,
  resolvePlatformAsset,
  UPDATE_PUBKEY_B64,
  UpdateManager,
  validateDownloadUrl,
  verifyEd25519B64,
  writeHandoffFile,
} from "../src/bun/updater";

let root = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kip-updater-test-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createTestEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPub = spki.subarray(spki.length - 32);
  const pubB64 = Buffer.from(rawPub).toString("base64");
  return { publicKey, privateKey, pubB64 };
}

function signB64(privateKey: KeyObject, data: Uint8Array): string {
  return cryptoSign(null, Buffer.from(data), privateKey).toString("base64");
}

describe("SemVer parsing and ordering", () => {
  test("parses plain, v-prefixed, 2-part, prerelease, and build metadata versions", () => {
    expect(parseSemver("0.2.18")).toEqual({ major: 0, minor: 2, patch: 18 });
    expect(parseSemver("v0.2.18")).toEqual({ major: 0, minor: 2, patch: 18 });
    expect(parseSemver("0.2.19-rc.1")).toEqual({ major: 0, minor: 2, patch: 19 });
    expect(parseSemver("1.10.0+build.42")).toEqual({ major: 1, minor: 10, patch: 0 });
    expect(parseSemver("1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(formatSemver({ major: 0, minor: 2, patch: 18 })).toBe("0.2.18");
  });

  test("rejects invalid version strings", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("dev")).toBeNull();
    expect(parseSemver("v0.2.x")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("abc1.2.3")).toBeNull();
  });

  test("compares versions numerically", () => {
    const v029 = parseSemver("0.2.9")!;
    const v0210 = parseSemver("0.2.10")!;
    const v099 = parseSemver("0.99.99")!;
    const v100 = parseSemver("1.0.0")!;

    expect(compareSemver(v0210, v029)).toBeGreaterThan(0);
    expect(isNewerSemver(v0210, v029)).toBe(true);
    expect(isNewerSemver(v100, v099)).toBe(true);
    expect(isNewerSemver(v029, v029)).toBe(false);
    expect(isNewerSemver(v029, v0210)).toBe(false);
  });
});

describe("Ed25519 verification via node:crypto", () => {
  test("real embedded public key decodes cleanly as Ed25519", () => {
    const key = decodeVerifyingKey(UPDATE_PUBKEY_B64);
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  test("accepts valid signature over canonical payload and rejects tampering", () => {
    const { privateKey, pubB64 } = createTestEd25519Keypair();
    const verifyingKey = decodeVerifyingKey(pubB64);

    const payload = canonicalAssetPayload(
      APP_SLUG,
      "0.3.0",
      "darwin-aarch64",
      "a".repeat(64),
      123456,
    );
    expect(payload).toBe(`v1:kip:0.3.0:darwin-aarch64:${"a".repeat(64)}:123456`);

    const msgBytes = new TextEncoder().encode(payload);
    const sigB64 = signB64(privateKey, msgBytes);

    expect(() => verifyEd25519B64(verifyingKey, msgBytes, sigB64)).not.toThrow();
    expect(() =>
      verifyEd25519B64(
        verifyingKey,
        new TextEncoder().encode(payload.replace("0.3.0", "0.3.1")),
        sigB64,
      ),
    ).toThrow(/signature mismatch/);

    const otherKey = decodeVerifyingKey(createTestEd25519Keypair().pubB64);
    expect(() => verifyEd25519B64(otherKey, msgBytes, sigB64)).toThrow(
      /signature mismatch/,
    );
  });

  test("rejects malformed keys and signatures", () => {
    expect(() => decodeVerifyingKey("not-base64!!!")).toThrow();
    expect(() =>
      decodeVerifyingKey(Buffer.from("short").toString("base64")),
    ).toThrow(/32 bytes/);

    const verifyingKey = decodeVerifyingKey(UPDATE_PUBKEY_B64);
    expect(() =>
      verifyEd25519B64(
        verifyingKey,
        new Uint8Array([1, 2, 3]),
        Buffer.from("short").toString("base64"),
      ),
    ).toThrow(/64 bytes/);
  });
});

describe("URL allowlist", () => {
  test("allows GitHub release hosts and rejects untrusted origins", () => {
    expect(() =>
      validateDownloadUrl(
        "https://github.com/abcdlsj/kip/releases/latest/download/latest.json",
        false,
      ),
    ).not.toThrow();
    expect(() =>
      validateDownloadUrl(
        "https://objects.githubusercontent.com/github-production-release-asset-2e65be/kip.zip",
        false,
      ),
    ).not.toThrow();
    expect(() =>
      validateDownloadUrl(
        "https://release-assets.githubusercontent.com/kip.zip",
        false,
      ),
    ).not.toThrow();

    expect(() =>
      validateDownloadUrl("https://evil.example.com/latest.json", false),
    ).toThrow(/untrusted/);
    expect(() =>
      validateDownloadUrl("https://github.com/other/kip/releases/latest.json", false),
    ).toThrow(/untrusted/);
    expect(() =>
      validateDownloadUrl("http://127.0.0.1:8080/latest.json", false),
    ).toThrow(/untrusted/);
    expect(() =>
      validateDownloadUrl("http://127.0.0.1:8080/latest.json", true),
    ).not.toThrow();
    expect(() =>
      validateDownloadUrl("http://localhost:9999/latest.json", true),
    ).not.toThrow();
  });
});

describe("Atomic handoff file", () => {
  test("roundtrips state once and deletes file immediately on consume", () => {
    const handoffPath = join(root, "update-handoff.json");
    const now = Date.now();
    writeHandoffFile(handoffPath, {
      schema_version: 1,
      from_version: "0.2.18",
      to_version: "0.2.19",
      created_at_ms: now,
      ttl_ms: HANDOFF_TTL_MS,
      app_state: {
        activeWorkspaceId: "ws_1",
        activeThreadId: "th_42",
        drafts: { th_42: "unsaved prompt draft" },
        scrollTop: 512,
        scrollPinned: false,
      },
    });

    expect(existsSync(handoffPath)).toBe(true);
    const consumed = consumeHandoffFile(handoffPath, now + 5_000);
    expect(consumed).not.toBeNull();
    expect(consumed?.to_version).toBe("0.2.19");
    expect(consumed?.app_state.activeThreadId).toBe("th_42");
    expect(consumed?.app_state.drafts?.th_42).toBe("unsaved prompt draft");
    expect(consumed?.app_state.scrollTop).toBe(512);
    expect(consumed?.app_state.scrollPinned).toBe(false);

    // One-shot: file is gone and second consume returns null.
    expect(existsSync(handoffPath)).toBe(false);
    expect(consumeHandoffFile(handoffPath, now + 5_000)).toBeNull();
  });

  test("discards expired handoff payloads beyond TTL", () => {
    const handoffPath = join(root, "expired-handoff.json");
    const createdAt = 1_000_000;
    writeHandoffFile(handoffPath, {
      schema_version: 1,
      from_version: "0.2.18",
      to_version: "0.2.19",
      created_at_ms: createdAt,
      ttl_ms: HANDOFF_TTL_MS,
      app_state: { activeThreadId: "th_old" },
    });

    const consumed = consumeHandoffFile(
      handoffPath,
      createdAt + HANDOFF_TTL_MS + 1,
    );
    expect(consumed).toBeNull();
    expect(existsSync(handoffPath)).toBe(false);
  });
});

describe("macOS bundle detection & platform resolution", () => {
  test("rejects /Volumes/ and AppTranslocation and accepts writable .app", () => {
    expect(
      inspectAppBundlePath("/Volumes/Kip/Kip.app/Contents/MacOS/bun"),
    ).toEqual({ appPath: null, selfUpdatable: false });

    expect(
      inspectAppBundlePath(
        "/private/var/folders/xx/AppTranslocation/abc/d/Kip.app/Contents/MacOS/bun",
      ),
    ).toEqual({ appPath: null, selfUpdatable: false });

    const exe = join(root, "Kip.app", "Contents", "MacOS", "bun");
    mkdirSync(join(root, "Kip.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(exe, "");
    const detected = inspectAppBundlePath(exe);
    expect(detected.selfUpdatable).toBe(true);
    expect(detected.appPath).toBe(join(root, "Kip.app"));

    if (process.platform !== "win32") {
      const roParent = join(root, "readonly");
      const roExe = join(roParent, "Kip.app", "Contents", "MacOS", "bun");
      mkdirSync(join(roParent, "Kip.app", "Contents", "MacOS"), {
        recursive: true,
      });
      writeFileSync(roExe, "");
      chmodSync(roParent, 0o555);
      try {
        expect(inspectAppBundlePath(roExe).selfUpdatable).toBe(false);
      } finally {
        chmodSync(roParent, 0o755);
      }
    }
  });

  test("resolves macOS arch assets with universal fallback", () => {
    const armAsset = {
      url: "https://github.com/abcdlsj/kip/releases/download/v0.3.0/stable-macos-arm64-Kip.app.zip",
      signature: "sig",
      sha256: "0".repeat(64),
      size: 100,
      format: "app-zip",
      bundle_name: EXPECTED_BUNDLE_NAME,
      bundle_id: EXPECTED_BUNDLE_ID,
    };
    const universalAsset = { ...armAsset, url: "https://github.com/abcdlsj/kip/releases/download/v0.3.0/universal.zip" };
    expect(
      resolvePlatformAsset({ "darwin-aarch64": armAsset }, "darwin", "arm64")
        ?.platformKey,
    ).toBe("darwin-aarch64");
    expect(
      resolvePlatformAsset(
        { "darwin-universal": universalAsset },
        "darwin",
        "x64",
      )?.platformKey,
    ).toBe("darwin-universal");
  });
});

describe("UpdateManager signed manifest check", () => {
  const savedEnv = {
    url: process.env.KIP_UPDATE_MANIFEST_URL,
    ver: process.env.KIP_UPDATE_TEST_VERSION,
    pub: process.env.KIP_UPDATE_TEST_PUBKEY,
  };

  afterEach(() => {
    if (savedEnv.url === undefined) delete process.env.KIP_UPDATE_MANIFEST_URL;
    else process.env.KIP_UPDATE_MANIFEST_URL = savedEnv.url;
    if (savedEnv.ver === undefined) delete process.env.KIP_UPDATE_TEST_VERSION;
    else process.env.KIP_UPDATE_TEST_VERSION = savedEnv.ver;
    if (savedEnv.pub === undefined) delete process.env.KIP_UPDATE_TEST_PUBKEY;
    else process.env.KIP_UPDATE_TEST_PUBKEY = savedEnv.pub;
  });

  test("verifies signed latest.json + .sig, supports ETag 304, and rejects tampering", async () => {
    const { privateKey, pubB64 } = createTestEd25519Keypair();
    process.env.KIP_UPDATE_MANIFEST_URL = "http://127.0.0.1:43210/latest.json";
    process.env.KIP_UPDATE_TEST_VERSION = "0.2.18";
    process.env.KIP_UPDATE_TEST_PUBKEY = pubB64;

    const manifestObj = {
      schema_version: 1,
      app: APP_SLUG,
      version: "0.3.0",
      release_url: "https://github.com/abcdlsj/kip/releases/tag/v0.3.0",
      notes: "Seamless updates",
      platforms: {
        "darwin-aarch64": {
          url: "http://127.0.0.1:43210/stable-macos-arm64-Kip.app.zip",
          signature: "placeholder",
          sha256: "b".repeat(64),
          size: 1024,
          format: "app-zip",
          bundle_name: EXPECTED_BUNDLE_NAME,
          bundle_id: EXPECTED_BUNDLE_ID,
        },
      },
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestObj));
    const manifestSig = signB64(privateKey, manifestBytes);

    let call = 0;
    const seenIfNoneMatch: Array<string | null> = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(".sig")) {
        return new Response(manifestSig + "\n", { status: 200 });
      }
      seenIfNoneMatch.push(new Headers(init?.headers).get("if-none-match"));
      call += 1;
      if (call === 2) {
        return new Response(null, { status: 304 });
      }
      return new Response(manifestBytes, {
        status: 200,
        headers: { etag: '"v0.3.0"' },
      });
    }) as unknown as typeof fetch;

    const mgr = new UpdateManager({
      appVersion: "0.2.18",
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      fetchImpl: fetchMock,
    });

    const first = await mgr.check(false);
    expect(first.available).toBe(true);
    expect(first.latest).toBe("0.3.0");
    expect(first.state).toBe("available");
    expect(first.notes).toBe("Seamless updates");

    const second = await mgr.check(false);
    expect(seenIfNoneMatch).toEqual([null, '"v0.3.0"']);
    expect(second.available).toBe(true);
    expect(second.state).toBe("available");

    // Tampered manifest must be rejected by Ed25519 verification.
    const tamperedFetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith(".sig")) {
        return new Response(manifestSig, { status: 200 });
      }
      return new Response(
        JSON.stringify({ ...manifestObj, version: "9.9.9" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const mgrTampered = new UpdateManager({
      appVersion: "0.2.18",
      dataDir: join(root, "data2"),
      cacheDir: join(root, "cache2"),
      fetchImpl: tamperedFetch,
    });
    const failed = await mgrTampered.check(true);
    expect(failed.available).toBe(false);
    expect(failed.error).toContain("signature mismatch");
  });
});
