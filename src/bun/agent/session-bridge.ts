/**
 * Projects Pi's persisted session transcript into Kip's turn/block view model.
 * Pi stays authoritative for model context; this projection is display-only.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ChatTurn, ContentBlock, ContextUsage, ToolCallBlock } from "../../shared/types";
import { summarizeToolCall } from "./tool-policy";

interface ToolMeta {
  output?: string;
  isError: boolean;
}

export function projectSessionTurns(
  entries: SessionEntry[],
  workspaceRoot: string,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const toolMeta = new Map<string, ToolMeta>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as AgentMessage;

    if (message.role === "user") {
      turns.push(projectUser(entry.id, message));
      continue;
    }

    if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      toolMeta.set(result.toolCallId, {
        output: textOf(result.content),
        isError: result.isError,
      });
      continue;
    }

    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      const last = turns[turns.length - 1];
      const target =
        last && last.role === "assistant"
          ? last
          : (() => {
              const turn: ChatTurn = {
                id: `turn_${entry.id}`,
                role: "assistant",
                blocks: [],
                createdAt: assistant.timestamp,
              };
              turns.push(turn);
              return turn;
            })();
      appendAssistantBlocks(target, assistant, entry.id, workspaceRoot);
      if (assistant.errorMessage) target.error = assistant.errorMessage;
      continue;
    }

    if (message.role === "bashExecution") {
      const last = turns[turns.length - 1];
      const block: ToolCallBlock = {
        type: "tool_call",
        id: `bash_${entry.id}`,
        toolName: "bash",
        args: {},
        status: "completed",
        summaryLabel: "Ran shell command",
      };
      if (last?.role === "assistant") last.blocks.push(block);
      else
        turns.push({
          id: `turn_${entry.id}`,
          role: "assistant",
          blocks: [block],
          createdAt: Date.now(),
        });
    }
  }

  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type !== "tool_call") continue;
      const meta = toolMeta.get(block.id);
      if (!meta) continue;
      block.output = meta.output;
      block.status = meta.isError ? "error" : "completed";
    }
  }
  return turns;
}

function projectUser(entryId: string, message: UserMessage): ChatTurn {
  const blocks: ContentBlock[] = [];
  if (typeof message.content === "string") {
    blocks.push({ type: "text", id: `${entryId}_text`, text: message.content });
  } else {
    message.content.forEach((part, index) => {
      if (part.type === "text") {
        blocks.push({ type: "text", id: `${entryId}_${index}`, text: part.text });
      }
    });
  }
  return {
    id: entryId,
    role: "user",
    blocks,
    createdAt: message.timestamp,
  };
}

function appendAssistantBlocks(
  turn: ChatTurn,
  message: AssistantMessage,
  entryId: string,
  workspaceRoot: string,
): void {
  message.content.forEach((part, index) => {
    if (part.type === "text") {
      turn.blocks.push({
        type: "text",
        id: `${entryId}_t${index}`,
        text: part.text,
      });
    } else if (part.type === "thinking") {
      turn.blocks.push({
        type: "thinking",
        id: `${entryId}_th${index}`,
        thinking: part.thinking,
        isComplete: true,
      });
    } else if (part.type === "toolCall") {
      turn.blocks.push({
        type: "tool_call",
        id: part.id,
        toolName: part.name,
        args: part.arguments as Record<string, unknown>,
        status: "completed",
        summaryLabel: summarizeToolCall(
          part.name,
          part.arguments as Record<string, unknown>,
          workspaceRoot,
        ),
      });
    }
  });
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function toSharedUsage(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): ContextUsage {
  if (!usage) return { usedTokens: 0, maxTokens: 0, ratio: 0 };
  const used = usage.tokens ?? 0;
  const max = usage.contextWindow || 0;
  return {
    usedTokens: used,
    maxTokens: max,
    ratio: max > 0 ? Math.min(1, used / max) : 0,
  };
}

export function titleFromPrompt(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = clean.split(" ").slice(0, 7).join(" ");
  const title = words.length > 42 ? `${words.slice(0, 42).trim()}` : words;
  return title || "New Thread";
}
