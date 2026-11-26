import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliRuntime } from "../src/cli/runtime";
import { KipDatabase } from "../src/bun/storage/db";
import { setApiKey } from "../src/bun/storage/keychain";
import type { AgentStreamEvent } from "../src/shared/types";

/**
 * A failed request must not look like an endlessly thinking agent: Pi re-sends
 * it a few times, so every retry is reported and the final failure becomes a
 * visible turn error instead of silence.
 */

let dirs: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.KIP_KEYCHAIN = "file";
});

afterEach(() => {
  server?.stop(true);
  server = null;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  delete process.env.KIP_DATA_DIR;
  delete process.env.KIP_KEYCHAIN;
});

/** Chat completions hang forever; every other route answers so registry refresh is quick. */
function startHangingProvider(): string {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [] });
      }
      return new Promise<Response>(() => {});
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

describe("agent retry reporting", () => {
  test("reports each retry and surfaces the final failure as a turn error", async () => {
    const dataDir = makeTempDir("kip-retry-data-");
    const projectDir = makeTempDir("kip-retry-proj-");
    process.env.KIP_DATA_DIR = dataDir;

    // Short client timeout and a single retry keep the test fast while still
    // exercising the same path a five-minute provider stall takes.
    mkdirSync(join(dataDir, "agent"), { recursive: true });
    writeFileSync(
      join(dataDir, "agent", "settings.json"),
      JSON.stringify({
        httpIdleTimeoutMs: 400,
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 50,
          provider: { maxRetries: 0 },
        },
      }),
    );

    const baseUrl = startHangingProvider();
    const setup = new KipDatabase();
    setup.saveProvider({
      id: "hang",
      displayName: "Hang",
      protocol: "openai-completions",
      baseUrl,
      models: [
        {
          id: "hang-1",
          displayName: "Hang 1",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          supportsVision: false,
          supportsReasoning: false,
        },
      ],
    });
    setup.close();
    await setApiKey("hang", "sk-test");

    const events: AgentStreamEvent[] = [];
    const runtime = await CliRuntime.create({
      cwd: projectDir,
      ephemeral: true,
      continueLast: false,
      onEvent: (_threadId, event) => events.push(event),
    });

    try {
      await runtime.orchestrator.sendPrompt({
        threadId: runtime.thread.id,
        text: "hello",
      });
      // Let the settled/undo bookkeeping finish before asserting.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await runtime.dispose();
    }

    const kinds = events.map((event) => event.kind);
    const retryStart = events.find((event) => event.kind === "retry_start");
    const retryEnd = events.find((event) => event.kind === "retry_end");
    const turnError = events.find((event) => event.kind === "turn_error");

    expect(retryStart).toMatchObject({ attempt: 1, maxAttempts: 1 });
    expect(retryStart && "message" in retryStart && retryStart.message).toMatch(
      /timed out|abort/i,
    );
    expect(retryEnd).toMatchObject({ attempt: 1, success: false });
    expect(turnError && "message" in turnError && turnError.message).toMatch(
      /timed out|abort/i,
    );
    // The failure is reported once, after the retry, never during it.
    expect(kinds.filter((kind) => kind === "turn_error")).toHaveLength(1);
    expect(kinds.indexOf("turn_error")).toBeGreaterThan(
      kinds.indexOf("retry_start"),
    );
    expect(kinds).toContain("turn_complete");
  }, 30_000);
});
