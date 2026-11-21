import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStreamEvent } from "../src/shared/types";
import { ContextBuilder } from "../src/bun/agent/context-builder";
import { FrameBuffer } from "../src/bun/agent/stream-buffer";
import { ToolInterceptor, type ToolHook } from "../src/bun/agent/tool-interceptor";
import { ToolRegistry, type AnyToolDefinition } from "../src/bun/agent/tool-registry";
import { PluginRegistry } from "../src/bun/plugins/registry";
import { inspectGit } from "../src/bun/system/git-inspector";
import { splitLines, toPosixPath } from "../src/bun/system/platform";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function makeTempDir(prefix = "kip-arch-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeTool(name: string, result = "ok"): AnyToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" } as never,
    execute: (async () => ({
      content: [{ type: "text", text: result }],
      details: {},
    })) as never,
  } as AnyToolDefinition;
}

describe("ToolRegistry", () => {
  test("composes built-in tools with custom providers and allows overriding by name", async () => {
    const root = makeTempDir();
    const registry = new ToolRegistry();
    registry.register({
      id: "mcp-demo",
      createTools: () => [makeTool("mcp_search"), makeTool("read", "overridden")],
    });

    const tools = await registry.resolveTools({
      threadId: "th_1",
      workspaceId: "ws_1",
      workspaceRoot: root,
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("bash");
    expect(names).toContain("edit");
    expect(names).toContain("mcp_search");
    expect(names.filter((name) => name === "read")).toHaveLength(1);

    registry.unregister("mcp-demo");
    const afterUnregister = await registry.resolveTools({
      threadId: "th_1",
      workspaceId: "ws_1",
      workspaceRoot: root,
    });
    expect(afterUnregister.map((tool) => tool.name)).not.toContain("mcp_search");
  });
});

describe("ContextBuilder", () => {
  test("includes runtime environment, AGENTS.md instructions, and custom providers", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "AGENTS.md"), "Always run bun test before finishing.");
    mkdirSync(join(root, ".kip"), { recursive: true });
    writeFileSync(join(root, ".kip", "instructions.md"), "Prefer pure functions.");

    const builder = new ContextBuilder();
    builder.register({
      id: "custom-memory",
      build: () => "User prefers terse answers.",
    });

    const sections = await builder.buildSystemPromptSections({
      threadId: "th_1",
      workspaceId: "ws_1",
      workspaceRoot: root,
      workspaceName: "demo",
    });

    const joined = sections.join("\n\n");
    expect(joined).toContain("Runtime environment:");
    expect(joined).toContain("Always run bun test before finishing.");
    expect(joined).toContain("Prefer pure functions.");
    expect(joined).toContain("User prefers terse answers.");
  });

  test("ignores failing custom context providers without aborting session boot", async () => {
    const root = makeTempDir();
    const builder = new ContextBuilder();
    builder.register({
      id: "broken",
      build: () => {
        throw new Error("boom");
      },
    });
    const sections = await builder.buildSystemPromptSections({
      threadId: "th_1",
      workspaceId: "ws_1",
      workspaceRoot: root,
      workspaceName: "demo",
    });
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FrameBuffer", () => {
  test("coalesces adjacent deltas for the same block and flushes immediately on demand", () => {
    const events: AgentStreamEvent[] = [];
    const buffer = new FrameBuffer((_threadId, event) => events.push(event), "th_1", 50);

    buffer.push("text_delta", "turn_1", "blk_1", "Hello");
    buffer.push("text_delta", "turn_1", "blk_1", ", ");
    buffer.push("text_delta", "turn_1", "blk_1", "world!");
    buffer.push("thinking_delta", "turn_1", "thk_1", "step 1");
    expect(buffer.hasPending).toBe(true);
    expect(events).toHaveLength(0);

    buffer.flush();
    expect(buffer.hasPending).toBe(false);
    expect(events).toEqual([
      { kind: "text_delta", turnId: "turn_1", blockId: "blk_1", delta: "Hello, world!" },
      { kind: "thinking_delta", turnId: "turn_1", blockId: "thk_1", delta: "step 1" },
    ]);
  });
});

describe("ToolInterceptor hooks", () => {
  test("invokes beforeToolCall, afterToolCall, and onToolError hooks", async () => {
    const root = makeTempDir();
    const trace: string[] = [];
    const hook: ToolHook = {
      beforeToolCall: ({ toolName }) => {
        trace.push(`before:${toolName}`);
      },
      afterToolCall: ({ toolName }) => {
        trace.push(`after:${toolName}`);
      },
      onToolError: ({ toolName }) => {
        trace.push(`error:${toolName}`);
      },
    };

    const guard = new ToolInterceptor({
      workspaceRoot: root,
      threadId: "th_1",
      policy: "read-only-auto",
      requestApproval: () => {},
      hooks: [hook],
    });

    const safe = guard.wrap(makeTool("read"));
    await safe.execute("c1", { path: "README.md" } as never, undefined, undefined, {} as never);

    const blocked = guard.wrap(makeTool("read"));
    await expect(
      blocked.execute("c2", { path: "~/.ssh/id_rsa" } as never, undefined, undefined, {} as never),
    ).rejects.toThrow(/blocked/i);

    expect(trace).toEqual(["before:read", "after:read", "before:read", "error:read"]);
  });
});

describe("PluginRegistry", () => {
  test("supports dynamic registration and lookup", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "ollama",
      kind: "gateway",
      label: "Ollama",
      description: "Local Ollama",
      providerId: "ollama",
      fields: [],
      probe: async () => ({ ok: true }),
    });
    expect(registry.find("ollama")?.label).toBe("Ollama");
    expect(registry.list()).toHaveLength(1);
    registry.unregister("ollama");
    expect(registry.find("ollama")).toBeUndefined();
  });
});

describe("Cross-platform utilities & Git inspector", () => {
  test("normalizes Windows paths and CRLF line endings", () => {
    expect(toPosixPath("src\\bun\\index.ts")).toBe("src/bun/index.ts");
    expect(splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("inspectGit reads branch and dirty file count in a single call", async () => {
    const root = makeTempDir("kip-git-");
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await run(["init", "-b", "main"]);
    await run(["config", "user.email", "kip@example.com"]);
    await run(["config", "user.name", "Kip"]);
    writeFileSync(join(root, "a.txt"), "hello\n");
    await run(["add", "a.txt"]);
    await run(["commit", "-m", "init"]);

    const clean = await inspectGit(root);
    expect(clean).toEqual({ branch: "main", dirtyFiles: 0 });

    writeFileSync(join(root, "b.txt"), "dirty\n");
    const dirty = await inspectGit(root);
    expect(dirty).toEqual({ branch: "main", dirtyFiles: 1 });
  });
});
