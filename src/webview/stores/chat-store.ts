/** Per-thread streaming state. Updates are isolated by thread id. */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  AgentStreamEvent,
  ChatTurn,
  ContextUsage,
  QueuedPrompt,
  RunChanges,
  ToolApprovalPayload,
} from "../../shared/types";
import { request } from "../rpc-client";

export interface ThreadView {
  turns: ChatTurn[];
  usage: ContextUsage;
  running: boolean;
  approvals: ToolApprovalPayload[];
  /** Messages sent during the run that the agent has not picked up yet. */
  queued: QueuedPrompt[];
  error: string | null;
  loaded: boolean;
  /** The latest run with undoable file changes (Git workspaces only). */
  changes: RunChanges | null;
}

const emptyView = (): ThreadView => ({
  turns: [],
  usage: { usedTokens: 0, maxTokens: 0, ratio: 0 },
  running: false,
  approvals: [],
  queued: [],
  error: null,
  loaded: false,
  changes: null,
});

interface ChatState {
  threads: Record<string, ThreadView>;
  load: (threadId: string) => Promise<void>;
  appendUserTurn: (
    threadId: string,
    text: string,
    attachments?: ChatTurn["attachments"],
  ) => void;
  applyEvent: (threadId: string, event: AgentStreamEvent) => void;
  removeApproval: (threadId: string, toolCallId: string) => void;
  /** Stops the run and returns the text of queued messages that were dropped. */
  abort: (threadId: string) => Promise<string[]>;
  setError: (threadId: string, message: string) => void;
  resolveApproval: (
    threadId: string,
    toolCallId: string,
    approved: boolean,
    remember: boolean,
    reason?: string,
  ) => Promise<void>;
  /** Replaces a user message and everything after it, then reruns from there. */
  editUserTurn: (
    threadId: string,
    turnId: string,
    text: string,
  ) => Promise<void>;
  undoChanges: (threadId: string) => Promise<string | null>;
  clear: (threadId: string) => void;
  setUsage: (threadId: string, usage: ContextUsage) => void;
  view: (threadId: string | null) => ThreadView;
}

export const useChatStore = create<ChatState>()(
  immer((set, get) => ({
    threads: {},

    view: (threadId) =>
      threadId ? (get().threads[threadId] ?? emptyView()) : emptyView(),

    load: async (threadId) => {
      const [result, changes] = await Promise.all([
        request("loadThreadTurns", { threadId }),
        request("getRunChanges", { threadId }).catch(() => null),
      ]);
      set((state) => {
        const previous = state.threads[threadId];
        state.threads[threadId] = {
          ...emptyView(),
          turns: result.turns,
          usage: result.usage,
          loaded: true,
          changes,
          // A run keeps going while the view reloads; keep its live state.
          running: previous?.running ?? false,
          approvals: previous?.approvals ?? [],
          queued: previous?.queued ?? [],
        };
      });
    },

    appendUserTurn: (threadId, text, attachments) => {
      set((state) => {
        const view = state.threads[threadId] ?? emptyView();
        view.turns.push({
          id: `user_${crypto.randomUUID()}`,
          role: "user",
          blocks: [
            { type: "text", id: `user_txt_${crypto.randomUUID()}`, text },
          ],
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
            const block = turn?.blocks.find(
              (item) => item.id === event.blockId,
            );
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
              (item) =>
                item.type === "tool_call" &&
                item.id === event.approval.toolCallId,
            );
            if (block?.type === "tool_call") block.status = "awaiting_approval";
            if (
              !view.approvals.some(
                (item) => item.toolCallId === event.approval.toolCallId,
              )
            ) {
              view.approvals.push(event.approval);
            }
            return;
          }
          case "tool_approved": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            const block = turn?.blocks.find(
              (item) =>
                item.type === "tool_call" && item.id === event.toolCallId,
            );
            if (
              block?.type === "tool_call" &&
              block.status === "awaiting_approval"
            ) {
              block.status = event.approved === false ? "denied" : "running";
            }
            view.approvals = view.approvals.filter(
              (item) => item.toolCallId !== event.toolCallId,
            );
            return;
          }
          case "tool_end": {
            const turn = view.turns.find((item) => item.id === event.turnId);
            const block = turn?.blocks.find(
              (item) =>
                item.type === "tool_call" && item.id === event.toolCallId,
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
            view.queued = [];
            const lastTurn = view.turns[view.turns.length - 1];
            for (const block of lastTurn?.blocks ?? []) {
              if (block.type === "thinking") block.isComplete = true;
            }
            const lastUser = [...view.turns]
              .reverse()
              .find((turn) => turn.role === "user");
            if (lastTurn?.role === "assistant" && lastUser) {
              lastTurn.durationMs = Date.now() - lastUser.createdAt;
            }
            return;
          }
          case "changes_update":
            view.changes = event.changes;
            return;
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
          case "user_turn":
            view.turns.push(event.turn);
            return;
          case "queue_update":
            view.queued = event.queued;
            return;
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
          view.approvals = view.approvals.filter(
            (item) => item.toolCallId !== toolCallId,
          );
        }
      });
    },

    abort: async (threadId) => {
      const { restored } = await request("abortThread", { threadId });
      set((state) => {
        const view = state.threads[threadId];
        if (view) {
          view.running = false;
          view.approvals = [];
          view.queued = [];
        }
      });
      return restored;
    },

    resolveApproval: async (
      threadId,
      toolCallId,
      approved,
      remember,
      reason,
    ) => {
      await request("resolveToolApproval", {
        threadId,
        toolCallId,
        approved,
        rememberForSession: remember,
        reason,
      });
      set((state) => {
        const view = state.threads[threadId];
        if (!view) return;
        view.approvals = view.approvals.filter(
          (item) => item.toolCallId !== toolCallId,
        );
        for (const turn of view.turns) {
          const block = turn.blocks.find(
            (item) => item.type === "tool_call" && item.id === toolCallId,
          );
          if (
            block?.type === "tool_call" &&
            block.status === "awaiting_approval"
          ) {
            block.status = approved ? "running" : "denied";
          }
        }
      });
    },

    editUserTurn: async (threadId, turnId, text) => {
      const view = get().threads[threadId];
      if (!view || view.running) return;
      const index = view.turns.findIndex((turn) => turn.id === turnId);
      const target = view.turns[index];
      if (!target || target.role !== "user") return;
      const userIndex = view.turns
        .slice(0, index)
        .filter((turn) => turn.role === "user").length;
      set((state) => {
        const current = state.threads[threadId];
        if (!current) return;
        current.turns = current.turns.slice(0, index);
        current.turns.push({
          id: `user_${crypto.randomUUID()}`,
          role: "user",
          blocks: [
            { type: "text", id: `user_txt_${crypto.randomUUID()}`, text },
          ],
          attachments: target.attachments,
          createdAt: Date.now(),
        });
        current.running = true;
        current.error = null;
      });
      try {
        await request("editPrompt", { threadId, userIndex, text });
      } catch (error) {
        get().setError(
          threadId,
          error instanceof Error ? error.message : "Could not edit the message",
        );
      }
    },

    undoChanges: async (threadId) => {
      const runId = get().threads[threadId]?.changes?.id;
      if (!runId) return null;
      const result = await request("undoRunChanges", { threadId, runId });
      set((state) => {
        const view = state.threads[threadId];
        if (view) view.changes = result.next;
      });
      return result.ok ? null : (result.error ?? "Undo failed");
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
