import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteApiKey, getApiKey, hasApiKey, setApiKey } from "../src/bun/storage/keychain";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-keys-"));
  process.env.KIP_DATA_DIR = dir;
  process.env.KIP_KEYCHAIN = "file";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KIP_KEYCHAIN;
});

describe("secure credentials", () => {
  test("round-trips a key through the encrypted vault", async () => {
    await setApiKey("demo", "sk-test-value");
    expect(await hasApiKey("demo")).toBe(true);
    expect(await getApiKey("demo")).toBe("sk-test-value");
  });

  test("never writes the plaintext secret", async () => {
    await setApiKey("demo", "sk-should-not-appear");
    const vault = readFileSync(join(dir, "credentials.enc"), "utf8");
    expect(vault).not.toContain("sk-should-not-appear");
    expect(vault).toContain("data");
  });

  test("deletes keys", async () => {
    await setApiKey("demo", "value");
    await deleteApiKey("demo");
    expect(await getApiKey("demo")).toBeNull();
  });
});
