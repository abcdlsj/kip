import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { KIP_SYSTEM_PROMPT } from "../src/shared/constants";
import type { AgentStreamEvent } from "../src/shared/types";
import { ContextBuilder } from "../src/bun/agent/context-builder";
import { readSystemPromptOverride } from "../src/bun/agent/pi-orchestrator";
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
  test("includes workspace instructions before runtime environment and omits preamble", async () => {
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
    expect(joined).not.toContain(KIP_SYSTEM_PROMPT);
    expect(joined).not.toContain("You are Kip");
    expect(joined).toContain("Runtime environment:");
    expect(joined).toContain("- Workspace: demo");
    expect(joined).not.toContain(`(${toPosixPath(root)})`);
    expect(joined).toContain("Always run bun test before finishing.");
    expect(joined).toContain("Prefer pure functions.");
    expect(joined).toContain("User prefers terse answers.");
    expect(joined.indexOf("Workspace instructions (AGENTS.md):")).toBeLessThan(
      joined.indexOf("Runtime environment:"),
    );
  });

  test("deduplicates CLAUDE.md symlinked to AGENTS.md", async () => {
    const root = makeTempDir();
    const content = "Shared project rules for agents.";
    writeFileSync(join(root, "AGENTS.md"), `\uFEFF${content}\n`);
    symlinkSync(join(root, "AGENTS.md"), join(root, "CLAUDE.md"));

    const builder = new ContextBuilder();
    const sections = await builder.buildSystemPromptSections({
      threadId: "th_1",
      workspaceId: "ws_1",
      workspaceRoot: root,
      workspaceName: "demo",
    });

    const joined = sections.join("\n\n");
    expect(joined.split(content)).toHaveLength(2);
    expect(joined).toContain("Workspace instructions (AGENTS.md):");
    expect(joined).not.toContain("Workspace instructions (CLAUDE.md):");
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
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("Runtime environment:");
    expect(sections[0]).not.toContain(KIP_SYSTEM_PROMPT);
  });
});

describe("System prompt assembly", () => {
  async function renderSessionSystemPrompt(workspaceRoot: string, agentDir: string): Promise<string> {
    const builder = new ContextBuilder();
    const toolRegistry = new ToolRegistry();
    const [tools, systemPromptSections] = await Promise.all([
      toolRegistry.resolveTools({
        threadId: "th_1",
        workspaceId: "ws_1",
        workspaceRoot,
      }),
      builder.buildSystemPromptSections({
        threadId: "th_1",
        workspaceId: "ws_1",
        workspaceRoot,
        workspaceName: "demo",
      }),
    ]);

    const systemPrompt = readSystemPromptOverride(agentDir) ?? KIP_SYSTEM_PROMPT;
    const settingsManager = SettingsManager.create(workspaceRoot, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      systemPromptOverride: () => systemPrompt,
      appendSystemPrompt: systemPromptSections,
    });
    await resourceLoader.reload();

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      modelRuntime,
      sessionManager: SessionManager.inMemory(workspaceRoot),
      settingsManager,
      resourceLoader,
      noTools: "builtin",
      customTools: tools,
      tools: tools.map((tool) => tool.name),
    });
    try {
      return session.systemPrompt;
    } finally {
      session.dispose();
    }
  }

  test("uses KIP_SYSTEM_PROMPT by default without Pi harness sections or repo .pi/SYSTEM.md", async () => {
    const workspaceRoot = makeTempDir("kip-ws-");
    const agentDir = makeTempDir("kip-agent-");
    mkdirSync(join(workspaceRoot, ".pi"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".pi", "SYSTEM.md"), "Injected repo prompt.");
    writeFileSync(join(workspaceRoot, "AGENTS.md"), "Repo-specific rule.");

    const rendered = await renderSessionSystemPrompt(workspaceRoot, agentDir);

    expect(KIP_SYSTEM_PROMPT).toContain("assistant");
    expect(KIP_SYSTEM_PROMPT.toLowerCase()).not.toContain("coding agent");
    expect(rendered.startsWith(KIP_SYSTEM_PROMPT)).toBe(true);
    expect(rendered).not.toContain("running inside pi");
    expect(rendered).not.toContain("<docs>");
    expect(rendered).not.toContain("<rules>");
    expect(rendered).not.toContain("<tools>");
    expect(rendered).not.toContain("<project_context>");
    expect(rendered).not.toContain("Injected repo prompt.");
    expect(rendered.split("Repo-specific rule.")).toHaveLength(2);
    expect(rendered).toContain(`<cwd>\n${toPosixPath(workspaceRoot)}\n</cwd>`);
  });

  test("falls back to KIP_SYSTEM_PROMPT when agentDir SYSTEM.md is empty", async () => {
    const workspaceRoot = makeTempDir("kip-ws-");
    const agentDir = makeTempDir("kip-agent-");
    writeFileSync(join(agentDir, "SYSTEM.md"), "   \n\t  ");

    const rendered = await renderSessionSystemPrompt(workspaceRoot, agentDir);

    expect(rendered.startsWith(KIP_SYSTEM_PROMPT)).toBe(true);
    expect(rendered).not.toContain("running inside pi");
    expect(rendered).not.toContain("<docs>");
    expect(rendered).not.toContain("<rules>");
  });

  test("applies non-empty agentDir SYSTEM.md override", async () => {
    const workspaceRoot = makeTempDir("kip-ws-");
    const agentDir = makeTempDir("kip-agent-");
    writeFileSync(join(agentDir, "SYSTEM.md"), "\uFEFFYou are Custom Kip.\n");

    const rendered = await renderSessionSystemPrompt(workspaceRoot, agentDir);

    expect(rendered.startsWith("You are Custom Kip.")).toBe(true);
    expect(rendered).not.toContain(KIP_SYSTEM_PROMPT);
    expect(rendered).not.toContain("running inside pi");
    expect(rendered).not.toContain("<docs>");
    expect(rendered).not.toContain("<rules>");
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
