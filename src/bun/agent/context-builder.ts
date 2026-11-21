/**
 * Composable system prompt context assembly.
 *
 * Keeps the base agent instructions concise while enriching each session with
 * runtime environment info (OS, shell, workspace root, Git branch) and
 * project-level instruction files (`AGENTS.md`, `CLAUDE.md`, `.kip/instructions.md`).
 * Additional `PromptContextProvider`s (e.g. skills, memory, MCP resources) can
 * be registered without modifying the orchestrator.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SYSTEM_PROMPT } from "../../shared/constants";
import { inspectGit } from "../system/git-inspector";
import { describeRuntimeEnv, toPosixPath } from "../system/platform";

export interface PromptContextInput {
  threadId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
}

export interface PromptContextProvider {
  readonly id: string;
  build(input: PromptContextInput): string | null | Promise<string | null>;
}

const INSTRUCTION_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  join(".kip", "instructions.md"),
];

/** Cap injected workspace instruction text so large docs never crowd out context. */
const MAX_INSTRUCTION_CHARS = 16_000;

/** Appends concise OS, shell, workspace path, and Git branch metadata. */
export function createRuntimeContextProvider(): PromptContextProvider {
  return {
    id: "runtime-env",
    async build(input) {
      const git = await inspectGit(input.workspaceRoot).catch(() => ({
        branch: null,
        dirtyFiles: 0,
      }));
      const lines = [
        "Runtime environment:",
        `- OS: ${describeRuntimeEnv()}`,
        `- Workspace: ${input.workspaceName} (${toPosixPath(input.workspaceRoot)})`,
      ];
      if (git.branch) {
        lines.push(`- Git branch: ${git.branch}`);
      }
      return lines.join("\n");
    },
  };
}

/** Reads project instructions (`AGENTS.md`, `CLAUDE.md`, `.kip/instructions.md`) if present. */
export function createWorkspaceInstructionsProvider(): PromptContextProvider {
  return {
    id: "workspace-instructions",
    build(input) {
      const sections: string[] = [];
      let remaining = MAX_INSTRUCTION_CHARS;
      for (const relativePath of INSTRUCTION_CANDIDATES) {
        if (remaining <= 0) break;
        const fullPath = join(input.workspaceRoot, relativePath);
        if (!existsSync(fullPath)) continue;
        try {
          if (!statSync(fullPath).isFile()) continue;
          const raw = readFileSync(fullPath, "utf8").trim();
          if (!raw) continue;
          const clipped =
            raw.length > remaining
              ? `${raw.slice(0, remaining)}\n\n[Truncated for context budget]`
              : raw;
          sections.push(`Workspace instructions (${toPosixPath(relativePath)}):\n${clipped}`);
          remaining -= clipped.length;
        } catch {
          // Ignore unreadable instruction files.
        }
      }
      return sections.length > 0 ? sections.join("\n\n") : null;
    },
  };
}

export class ContextBuilder {
  private readonly providers = new Map<string, PromptContextProvider>();

  constructor(
    initial: PromptContextProvider[] = [
      createRuntimeContextProvider(),
      createWorkspaceInstructionsProvider(),
    ],
  ) {
    for (const provider of initial) {
      this.providers.set(provider.id, provider);
    }
  }

  register(provider: PromptContextProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): void {
    this.providers.delete(providerId);
  }

  async buildSystemPromptSections(input: PromptContextInput): Promise<string[]> {
    const sections = [DEFAULT_SYSTEM_PROMPT];
    for (const provider of this.providers.values()) {
      try {
        const chunk = await provider.build(input);
        if (chunk?.trim()) sections.push(chunk.trim());
      } catch {
        // Optional context providers must never block starting a session.
      }
    }
    return sections;
  }
}
