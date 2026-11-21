/**
 * Chat threads exist for providers where the conversation is the product: no
 * tools, no system prompt, no workspace context. This asserts the provider
 * request itself, since that is where injection would show up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KipOrchestrator } from "../src/bun/agent/pi-orchestrator";
import { ModelRegistry } from "../src/bun/agent/model-registry";
import { KIP_SYSTEM_PROMPT } from "../src/shared/constants";
import { KipDatabase } from "../src/bun/storage/db";
import { setApiKey } from "../src/bun/storage/keychain";
import type { ThreadMode } from "../src/shared/types";

interface Captured {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  stream?: boolean;
}

let dir = "";
let db: KipDatabase;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-chat-"));
  process.env.KIP_DATA_DIR = dir;
  process.env.KIP_KEYCHAIN = "file";
  db = new KipDatabase();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  db.close();
  delete process.env.KIP_KEYCHAIN;
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal OpenAI-compatible endpoint that records each request body. */
function fakeModelServer(): { url: string; captured: Captured[] } {
  const captured: Captured[] = [];
  const instance = Bun.serve({
    port: 0,
    async fetch(request) {
      captured.push((await request.json()) as Captured);
      const base = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "demo-model",
      };
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      return new Response(
        [
          chunk({ role: "assistant", content: "Hi." }, null),
          chunk({}, "stop"),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  server = instance;
  return { url: `http://127.0.0.1:${instance.port}/v1`, captured };
}

async function sendToNewThread(
  orchestrator: KipOrchestrator,
  mode: ThreadMode,
  text: string,
): Promise<void> {
  const workspace = db.listWorkspaces()[0]!;
  const suffix = mode === "chat" ? "chat" : "agent";
  const thread = db.createThread({
    id: `th_${suffix}`,
    workspaceId: workspace.id,
    title: "New Thread",
    sessionFilePath: join(dir, `${suffix}.jsonl`),
    modelProvider: "demo",
    modelId: "demo-model",
    thinkingLevel: "off",
    mode,
  });
  await orchestrator.sendPrompt({ threadId: thread.id, text });
}

async function orchestratorFor(baseUrl: string): Promise<KipOrchestrator> {
  await setApiKey("demo", "sk-test");
  db.saveProvider({
    id: "demo",
    displayName: "Demo",
    protocol: "openai-completions",
    baseUrl,
    models: [
      {
        id: "demo-model",
        displayName: "Demo model",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        supportsVision: false,
        supportsReasoning: false,
      },
    ],
  });
  const registry = await ModelRegistry.create(db);
  const orchestrator = new KipOrchestrator(db, registry, () => {});
  return orchestrator;
}

describe("Thread modes", () => {
  test("a chat thread sends neither a system prompt nor tools", async () => {
    const { url, captured } = fakeModelServer();
    const orchestrator = await orchestratorFor(url);
    try {
      await sendToNewThread(orchestrator, "chat", "Explain what a monad is.");
    } finally {
      await orchestrator.shutdown();
    }

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.messages.map((message) => message.role)).toEqual(["user"]);
    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: "Explain what a monad is." },
    ]);
    expect(request.tools ?? []).toHaveLength(0);

    // Once a message lands, the transcript decides the shape; the mode is fixed.
    await expect(orchestrator.setThreadMode("th_chat", "agent")).rejects.toThrow(
      "Start a new thread",
    );
  });

  test("an agent thread still carries Kip's prompt and tools", async () => {
    const { url, captured } = fakeModelServer();
    const orchestrator = await orchestratorFor(url);
    try {
      await sendToNewThread(orchestrator, "agent", "List this workspace.");
    } finally {
      await orchestrator.shutdown();
    }

    const request = captured[0]!;
    const system = request.messages.find((message) => message.role === "system");
    expect(typeof system?.content).toBe("string");
    expect((system?.content as string).startsWith(KIP_SYSTEM_PROMPT)).toBe(true);
    expect((request.tools ?? []).length).toBeGreaterThan(0);
  });
});
