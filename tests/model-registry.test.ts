import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchRemoteModels,
  mapProviderModels,
  ModelRegistry,
} from "../src/bun/agent/model-registry";
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

  test("registers keyless providers and drops deleted ones", async () => {
    saveProvider(db, "keyless");
    saveProvider(db, "keyed");
    await setApiKey("keyed", "sk-test");
    const registry = await ModelRegistry.create(db);
    // A local gateway (Ollama, gemini2api) may legitimately run without a key.
    expect(registry.listAvailable().map((option) => option.provider).sort()).toEqual([
      "keyed",
      "keyless",
    ]);

    db.deleteProvider("keyed");
    await registry.syncWithDatabase();
    expect(registry.listAvailable().map((option) => option.provider)).toEqual(["keyless"]);
    expect(registry.getModel("keyed", "model-a")).toBeUndefined();
  });

  test("maps supportsVision to model input modalities", () => {
    const mapped = mapProviderModels(
      [
        {
          id: "vision-model",
          displayName: "Vision Model",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          supportsVision: true,
          supportsReasoning: false,
        },
        {
          id: "text-only-model",
          displayName: "Text Only",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          supportsVision: false,
          supportsReasoning: false,
        },
      ],
      "openai-completions",
      "https://example.invalid/v1",
    );
    expect(mapped[0]?.input).toEqual(["text", "image"]);
    expect(mapped[1]?.input).toEqual(["text"]);
  });

  test("fetchRemoteModels parses capability metadata and defaults vision to true", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "deepseek/deepseek-v4.1-flash" },
            {
              id: "openrouter/text-only",
              context_length: 64_000,
              architecture: { input_modalities: ["text"] },
              supported_parameters: ["reasoning"],
            },
            {
              id: "openrouter/multimodal",
              architecture: { modality: "text+image->text" },
            },
            {
              id: "custom/explicit-false",
              capabilities: { vision: false, reasoning: true },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await fetchRemoteModels("https://example.invalid/v1", "sk-test", mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(4);
    expect(result.models[0]).toMatchObject({
      id: "deepseek/deepseek-v4.1-flash",
      supportsVision: true,
      supportsReasoning: false,
    });
    expect(result.models[1]).toMatchObject({
      id: "openrouter/text-only",
      contextWindow: 64_000,
      supportsVision: false,
      supportsReasoning: true,
    });
    expect(result.models[2]).toMatchObject({
      id: "openrouter/multimodal",
      supportsVision: true,
      supportsReasoning: false,
    });
    expect(result.models[3]).toMatchObject({
      id: "custom/explicit-false",
      supportsVision: false,
      supportsReasoning: true,
    });
  });
});
