import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../src/bun/agent/model-registry";
import { KipDatabase } from "../src/bun/storage/db";
import { setApiKey } from "../src/bun/storage/keychain";

let dir = "";
let db: KipDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-registry-"));
  process.env.KIP_DATA_DIR = dir;
  process.env.KIP_KEYCHAIN = "file";
  db = new KipDatabase();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KIP_KEYCHAIN;
});

function saveProvider(database: KipDatabase, id: string) {
  database.saveProvider({
    id,
    displayName: id,
    protocol: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    models: [
      {
        id: "model-a",
        displayName: "Model A",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        supportsVision: false,
        supportsReasoning: false,
      },
    ],
  });
}

describe("model registry", () => {
  test("picks up a provider written by another process after startup", async () => {
    const registry = await ModelRegistry.create(db);
    expect(registry.listAvailable()).toHaveLength(0);

    // Simulates `bun run seed` writing to the database while the app runs.
    const other = new KipDatabase();
    saveProvider(other, "seeded");
    other.close();
    await setApiKey("seeded", "sk-test");

    const fallback = await registry.ensureDefault();
    expect(fallback).toEqual({ provider: "seeded", modelId: "model-a" });
    expect(registry.getModel("seeded", "model-a")).toBeDefined();
  });

  test("skips providers without a key and drops deleted ones", async () => {
    saveProvider(db, "keyless");
    saveProvider(db, "keyed");
    await setApiKey("keyed", "sk-test");
    const registry = await ModelRegistry.create(db);
    expect(registry.listAvailable().map((option) => option.provider)).toEqual(["keyed"]);

    db.deleteProvider("keyed");
    await registry.syncWithDatabase();
    expect(registry.listAvailable()).toHaveLength(0);
    expect(registry.getModel("keyed", "model-a")).toBeUndefined();
  });
});
