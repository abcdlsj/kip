import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  parseCliArgs,
  parseLayout,
  parsePolicy,
  parseThinking,
  resolveModelOption,
} from "../src/cli/args";
import { CliRuntime } from "../src/cli/runtime";
import {
  ApprovalPromptComponent,
  AssistantTurnComponent,
  HeaderComponent,
  PickerOverlayComponent,
  StatusBarComponent,
  TopBarComponent,
  UserMessageComponent,
  WelcomeEmptyComponent,
} from "../src/cli/tui/components";
import { createKipTheme } from "../src/cli/tui/theme";
import { KipDatabase } from "../src/bun/storage/db";
import type { ChatTurn, ModelOption } from "../src/shared/types";

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

describe("CLI argument parsing", () => {
  test("parses default TUI invocation and one-shot print flags", () => {
    expect(parseCliArgs([])).toEqual({
      command: "run",
      print: false,
      prompt: null,
      continueLast: false,
      chat: false,
      quiet: false,
    });

    const printArgs = parseCliArgs([
      "-p",
      "summarize this repo",
      "-m",
      "sonnet",
      "-t",
      "high",
      "--permission",
      "auto",
      "-q",
    ]);
    expect(printArgs).toEqual({
      command: "run",
      print: true,
      prompt: "summarize this repo",
      model: "sonnet",
      thinking: "high",
      policy: "full-auto",
      continueLast: false,
      chat: false,
      quiet: true,
    });
  });

  test("supports subcommands, aliases, and validation errors", () => {
    expect(parseCliArgs(["models"]).command).toBe("models");
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(parseCliArgs(["-v"]).command).toBe("version");
    expect(parseCliArgs(["--yolo", "-c", "--chat", "-f"])).toMatchObject({
      policy: "yolo",
      continueLast: true,
      chat: true,
      layout: "fullscreen",
    });
    expect(parseCliArgs(["--inline"]).layout).toBe("inline");
    expect(parseLayout("full")).toBe("fullscreen");
    expect(parseLayout("inline")).toBe("inline");
    expect(parsePolicy("ask")).toBe("read-only-auto");
    expect(parseThinking("med")).toBe("medium");

    expect(() => parseCliArgs(["--permission", "bogus"])).toThrow();
    expect(() => parseCliArgs(["--thinking", "ultra"])).toThrow();
    expect(() => parseCliArgs(["--unknown"])).toThrow();
  });

  test("resolves model queries by exact id, provider/id, and fuzzy match", () => {
    const models: ModelOption[] = [
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        contextWindow: 200_000,
        supportsReasoning: true,
      },
      {
        provider: "openai",
        modelId: "gpt-4.1",
        displayName: "GPT 4.1",
        contextWindow: 128_000,
        supportsReasoning: false,
      },
      {
        provider: "openai",
        modelId: "gpt-4.1-mini",
        displayName: "GPT 4.1 Mini",
        contextWindow: 128_000,
        supportsReasoning: false,
      },
    ];

    expect(resolveModelOption(models, "sonnet").match?.modelId).toBe(
      "claude-sonnet-4",
    );
    expect(resolveModelOption(models, "openai/gpt-4.1").match?.modelId).toBe(
      "gpt-4.1",
    );
    expect(resolveModelOption(models, "gpt-4.1").match?.modelId).toBe(
      "gpt-4.1",
    );
    expect(resolveModelOption(models, "4.1").candidates?.length).toBe(2);
    expect(resolveModelOption(models, "missing").match).toBeUndefined();
  });
});

describe("TUI components", () => {
  const theme = createKipTheme("dark", "truecolor");

  test("respects narrow and standard terminal widths including CJK text", () => {
    const turn: ChatTurn = {
      id: "turn_1",
      role: "assistant",
      createdAt: Date.now(),
      blocks: [
        {
          type: "thinking",
          id: "thk_1",
          thinking: "分析仓库结构与安全边界",
          durationMs: 1240,
          isComplete: true,
        },
        {
          type: "tool_call",
          id: "tool_1",
          toolName: "edit",
          args: { path: "src/cli/index.ts" },
          status: "completed",
          summaryLabel: "Edited src/cli/index.ts (+2 -1)",
          durationMs: 18,
          diff: {
            before: "const a = 1;\n",
            after: "const a = 2;\nconst b = 3;\n",
            filePath: "src/cli/index.ts",
          },
        },
        {
          type: "text",
          id: "txt_1",
          text: "已完成更新，支持 `kip -p` 与极简交互式 TUI。",
        },
      ],
    };

    const components = [
      new HeaderComponent(theme, {
        workspacePath: "/Users/demo/Workspace/kip",
        homeDir: "/Users/demo",
        gitBranch: "main",
        modelLabel: "Claude Sonnet 4",
        thinking: "medium",
        policy: "read-only-auto",
        mode: "agent",
      }),
      new TopBarComponent(theme, {
        workspacePath: "/Users/demo/Workspace/kip",
        homeDir: "/Users/demo",
        gitBranch: "main",
        threadTitle: "检查仓库结构",
        modelLabel: "Claude Sonnet 4",
        thinking: "medium",
        policy: "read-only-auto",
        mode: "agent",
      }),
      new WelcomeEmptyComponent(
        theme,
        "/Users/demo/Workspace/kip",
        "/Users/demo",
      ),
      new UserMessageComponent(theme, "帮我检查一下当前仓库结构"),
      new AssistantTurnComponent(theme, turn, false),
      new AssistantTurnComponent(theme, turn, true),
      new StatusBarComponent(theme, {
        workspaceName: "kip",
        gitBranch: "main",
        modelLabel: "Claude Sonnet 4",
        thinking: "medium",
        policy: "yolo",
        mode: "agent",
        usage: { usedTokens: 24_000, maxTokens: 200_000, ratio: 0.12 },
      }),
      new StatusBarComponent(theme, {
        workspaceName: "kip",
        gitBranch: "main",
        modelLabel: "Claude Sonnet 4",
        thinking: "medium",
        policy: "read-only-auto",
        mode: "agent",
        usage: { usedTokens: 24_000, maxTokens: 200_000, ratio: 0.12 },
        layout: "fullscreen",
      }),
      new PickerOverlayComponent(theme, {
        title: "Permission",
        items: [
          { value: "ask", label: "Ask", description: "Safe reads auto" },
          { value: "yolo", label: "YOLO", description: "Never ask" },
        ],
        onSelect: () => {},
        onCancel: () => {},
      }),
    ];

    for (const width of [40, 80]) {
      for (const comp of components) {
        const lines = comp.render(width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("approval prompt disables always-in-session for high-risk commands", () => {
    const decisions: Array<[boolean, boolean]> = [];
    const prompt = new ApprovalPromptComponent(
      theme,
      {
        threadId: "th_1",
        toolCallId: "tc_1",
        toolName: "bash",
        summaryLabel: "Ran rm -rf dist",
        commandOrPath: "rm -rf dist",
        risk: "high-risk",
        outsideWorkspace: false,
      },
      (approved, remember) => decisions.push([approved, remember]),
    );

    expect(prompt.canRemember).toBe(false);
    // Pressing 'a' must be ignored for high-risk calls.
    prompt.handleInput("a");
    expect(decisions).toEqual([]);
    prompt.handleInput("y");
    expect(decisions).toEqual([[true, false]]);
  });
});

describe("CliRuntime lifecycle", () => {
  test("cleans up ephemeral workspace and thread on dispose", async () => {
    const dataDir = makeTempDir("kip-cli-data-");
    const projectDir = makeTempDir("kip-cli-proj-");
    const prevDataDir = process.env.KIP_DATA_DIR;
    process.env.KIP_DATA_DIR = dataDir;

    try {
      const runtime = await CliRuntime.create({
        cwd: projectDir,
        ephemeral: true,
        continueLast: false,
      });
      const createdThreadId = runtime.thread.id;
      const createdWorkspaceId = runtime.workspace.id;
      await runtime.dispose();

      const verifyDb = new KipDatabase();
      try {
        expect(verifyDb.getThread(createdThreadId)).toBeNull();
        expect(verifyDb.getWorkspace(createdWorkspaceId)).toBeNull();
      } finally {
        verifyDb.close();
      }
    } finally {
      if (prevDataDir === undefined) delete process.env.KIP_DATA_DIR;
      else process.env.KIP_DATA_DIR = prevDataDir;
    }
  });

  test("persists TUI layout preference in Kip settings", async () => {
    const dataDir = makeTempDir("kip-cli-layout-");
    const projectDir = makeTempDir("kip-cli-layout-proj-");
    const prevDataDir = process.env.KIP_DATA_DIR;
    process.env.KIP_DATA_DIR = dataDir;

    try {
      const first = await CliRuntime.create({
        cwd: projectDir,
        ephemeral: true,
        continueLast: false,
      });
      expect(first.getTuiLayout()).toBe("inline");
      first.setTuiLayout("fullscreen");
      await first.dispose();

      const second = await CliRuntime.create({
        cwd: projectDir,
        ephemeral: true,
        continueLast: false,
      });
      expect(second.getTuiLayout()).toBe("fullscreen");
      await second.dispose();
    } finally {
      if (prevDataDir === undefined) delete process.env.KIP_DATA_DIR;
      else process.env.KIP_DATA_DIR = prevDataDir;
    }
  });
});
