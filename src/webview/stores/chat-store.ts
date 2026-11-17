/** Per-thread streaming state. Updates are isolated by thread id. */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  AgentStreamEvent,
  ChatTurn,
  ContextUsage,
  ToolApprovalPayload,
} from "../../shared/types";
import { request } from "../rpc-client";

export interface ThreadView {
  turns: ChatTurn[];
  usage: ContextUsage;
  running: boolean;
  approvals: ToolApprovalPayload[];
  error: string | null;
  loaded: boolean;
}

const emptyView = (): ThreadView => ({
  turns: [],
  usage: { usedTokens: 0, maxTokens: 0, ratio: 0 },
  running: false,
  approvals: [],
  error: null,
  loaded: false,
});

interface ChatState {
  threads: Record<string, ThreadView>;
  load: (threadId: string) => Promise<void>;
  appendUserTurn: (threadId: string, text: string, attachments?: ChatTurn["attachments"]) => void;
  applyEvent: (threadId: string, event: AgentStreamEvent) => void;
  removeApproval: (threadId: string, toolCallId: string) => void;
  abort: (threadId: string) => Promise<void>;
  setError: (threadId: string, message: string) => void;
  resolveApproval: (
    threadId: string,
    toolCallId: string,
    approved: boolean,
    remember: boolean,
  ) => Promise<void>;
  clear: (threadId: string) => void;
  setUsage: (threadId: string, usage: ContextUsage) => void;
  view: (threadId: string | null) => ThreadView;
}

export const useChatStore = create<ChatState>()(
  immer((set, get) => ({
    threads: {},

    view: (threadId) => (threadId ? get().threads[threadId] ?? emptyView() : emptyView()),

    load: async (threadId) => {
      const result = await request("loadThreadTurns", { threadId });
      set((state) => {
        state.threads[threadId] = {
          ...emptyView(),
          turns: result.turns,
          usage: result.usage,
          loaded: true,
        };
      });
    },

    appendUserTurn: (threadId, text, attachments) => {
      set((state) => {
        const view = state.threads[threadId] ?? emptyView();
        view.turns.push({
          id: `user_${crypto.randomUUID()}`,
          role: "user",
          blocks: [{ type: "text", id: `user_txt_${crypto.randomUUID()}`, text }],
          attachments,
          createdAt: Date.now(),
        });
        view.running = true;
        view.error = null;
        view.loaded = true;
        state.threads[threadId] = view;
      });
    },

    applyEvent: (threadId, event) => {
      set((state) => {
        const view = state.threads[threadId] ?? emptyView();
        state.threads[threadId] = view;
        switch (event.kind) {
          case "turn_start": {
            if (!view.turns.some((turn) => turn.id === event.turn.id)) {
              view.turns.push(event.turn);
            }
            view.running = true;
            view.error = null;
            return;
          }
          case "text_delta": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            if (!turn) return;
            let block = turn.blocks.find((item) => item.id === event.blockId);
            if (!block || block.type !== "text") {
              block = { type: "text", id: event.blockId, text: "" };
              turn.blocks.push(block);
            }
            block.text += event.delta;
            return;
          }
          case "thinking_delta": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            if (!turn) return;
            let block = turn.blocks.find((item) => item.id === event.blockId);
            if (!block || block.type !== "thinking") {
              block = {
                type: "thinking",
                id: event.blockId,
                thinking: "",
                isComplete: false,
              };
              turn.blocks.push(block);
            }
            block.thinking += event.delta;
            return;
          }
          case "thinking_done": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            const block = turn?.blocks.find((item) => item.id === event.blockId);
            if (block?.type === "thinking") {
              block.isComplete = true;
              block.durationMs = event.durationMs;
            }
            return;
          }
          case "tool_start": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            if (!turn) return;
            if (!turn.blocks.some((item) => item.id === event.block.id)) {
              turn.blocks.push(event.block);
            }
            return;
          }
          case "tool_approval_required": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            const block = turn?.blocks.find(
              (item) => item.type === "tool_call" && item.id === event.approval.toolCallId,
            );
            if (block?.type === "tool_call") block.status = "awaiting_approval";
            if (!view.approvals.some((item) => item.toolCallId === event.approval.toolCallId)) {
              view.approvals.push(event.approval);
            }
            return;
          }
          case "tool_end": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            const block = turn?.blocks.find(
              (item) => item.type === "tool_call" && item.id === event.toolCallId,
            );
            if (block?.type === "tool_call") {
              block.status = event.status;
              block.output = event.output;
              block.diff = event.diff;
              block.durationMs = event.durationMs;
              block.summaryLabel = event.summaryLabel;
            }
            view.approvals = view.approvals.filter(
              (item) => item.toolCallId !== event.toolCallId,
            );
            return;
          }
          case "usage_update":
            view.usage = event.usage;
            return;
          case "turn_complete": {
            view.running = false;
            view.approvals = [];
            const lastTurn = view.turns[view.turns.length - 1];
            for (const block of lastTurn?.blocks ?? []) {
              if (block.type === "thinking") block.isComplete = true;
            }
            return;
          }
          case "turn_error": {
            view.running = false;
            view.error = event.message;
            const last = view.turns[view.turns.length - 1];
            if (last?.role === "assistant") {
              last.error = event.message;
            } else {
              view.turns.push({
                id: `err_${crypto.randomUUID()}`,
                role: "assistant",
                blocks: [],
                createdAt: Date.now(),
                error: event.message,
              });
            }
            return;
          }
          case "thread_title_updated":
            return;
          default:
            return;
        }
      });
    },

    setError: (threadId, message) => {
      set((state) => {
        const view = state.threads[threadId] ?? emptyView();
        view.running = false;
        view.error = message;
        const last = view.turns[view.turns.length - 1];
        if (last?.role === "assistant") {
          last.error = message;
        } else {
          view.turns.push({
            id: `err_${crypto.randomUUID()}`,
            role: "assistant",
            blocks: [],
            createdAt: Date.now(),
            error: message,
          });
        }
        state.threads[threadId] = view;
      });
    },

    removeApproval: (threadId, toolCallId) => {
      set((state) => {
        const view = state.threads[threadId];
        if (view) {
          view.approvals = view.approvals.filter((item) => item.toolCallId !== toolCallId);
        }
      });
    },

    abort: async (threadId) => {
      await request("abortThread", { threadId });
      set((state) => {
        const view = state.threads[threadId];
        if (view) {
          view.running = false;
          view.approvals = [];
        }
      });
    },

    resolveApproval: async (threadId, toolCallId, approved, remember) => {
      await request("resolveToolApproval", {
        threadId,
        toolCallId,
        approved,
        rememberForSession: remember,
      });
      get().removeApproval(threadId, toolCallId);
    },

    clear: (threadId) => {
      set((state) => {
        state.threads[threadId] = emptyView();
      });
    },

    setUsage: (threadId, usage) => {
      set((state) => {
        const view = state.threads[threadId];
        if (view) view.usage = usage;
      });
    },
  })),
);
