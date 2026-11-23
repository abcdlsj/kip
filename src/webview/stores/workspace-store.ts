/** Workspace and thread navigation state. */
import { create } from "zustand";
import type {
  ApprovalPolicy,
  ThinkingLevel,
  ThreadMode,
  ThreadSummary,
  Workspace,
} from "../../shared/types";
import { request } from "../rpc-client";

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  loading: boolean;
  /** Threads whose run finished while the user was looking elsewhere. */
  unread: Record<string, true>;
  markUnread: (threadId: string) => void;
  /** Opens a thread, switching workspace first when it belongs to another one. */
  openThread: (threadId: string) => Promise<void>;
  initialize: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  pickWorkspace: () => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshThreads: () => Promise<void>;
  newThread: (mode?: ThreadMode) => Promise<ThreadSummary | null>;
  selectThread: (threadId: string | null) => void;
  deleteThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  applyStreamMeta: (
    threadId: string,
    event: {
      kind: string;
      title?: string;
    },
  ) => void;
  setThreadRunning: (threadId: string, running: boolean) => void;
  updateThreadModel: (
    threadId: string,
    provider: string,
    modelId: string,
  ) => Promise<void>;
  setThreadThinking: (threadId: string, level: ThinkingLevel) => Promise<void>;
  setThreadMode: (threadId: string, mode: ThreadMode) => Promise<void>;
  setThreadApprovalPolicy: (
    threadId: string,
    policy: ApprovalPolicy | null,
  ) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  threads: [],
  activeThreadId: null,
  loading: true,
  unread: {},

  markUnread: (threadId) =>
    set((state) => ({ unread: { ...state.unread, [threadId]: true } })),

  openThread: async (threadId) => {
    if (get().threads.some((thread) => thread.id === threadId)) {
      get().selectThread(threadId);
      return;
    }
    for (const workspace of get().workspaces) {
      const threads = await request("listThreads", {
        workspaceId: workspace.id,
      });
      if (!threads.some((thread) => thread.id === threadId)) continue;
      set({ activeWorkspaceId: workspace.id, threads });
      get().selectThread(threadId);
      return;
    }
  },

  initialize: async () => {
    const workspaces = await request("listWorkspaces", undefined);
    const first = workspaces[0] ?? null;
    set({ workspaces, activeWorkspaceId: first?.id ?? null, loading: false });
    if (first) {
      const threads = await request("listThreads", { workspaceId: first.id });
      set({
        threads,
        activeThreadId: threads[0]?.id ?? null,
      });
    }
  },

  refreshWorkspaces: async () => {
    const workspaces = await request("listWorkspaces", undefined);
    set({ workspaces });
  },

  selectWorkspace: async (workspaceId) => {
    set({ activeWorkspaceId: workspaceId, threads: [], activeThreadId: null });
    const threads = await request("listThreads", { workspaceId });
    set({ threads, activeThreadId: threads[0]?.id ?? null });
  },

  pickWorkspace: async () => {
    const workspace = await request("pickAndCreateWorkspace", undefined);
    if (!workspace) return;
    await get().refreshWorkspaces();
    await get().selectWorkspace(workspace.id);
  },

  removeWorkspace: async (workspaceId) => {
    await request("removeWorkspace", { workspaceId });
    const workspaces = await request("listWorkspaces", undefined);
    const wasActive = get().activeWorkspaceId === workspaceId;
    const nextId = wasActive
      ? (workspaces[0]?.id ?? null)
      : get().activeWorkspaceId;
    set({ workspaces, activeWorkspaceId: nextId });
    if (wasActive) {
      if (nextId) {
        const threads = await request("listThreads", { workspaceId: nextId });
        set({ threads, activeThreadId: threads[0]?.id ?? null });
      } else {
        set({ threads: [], activeThreadId: null });
      }
    }
  },

  refreshThreads: async () => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) return;
    const threads = await request("listThreads", { workspaceId });
    set({ threads });
  },

  newThread: async (mode) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) return null;
    const thread = await request("createThread", { workspaceId, mode });
    set((state) => ({
      threads: [thread, ...state.threads],
      activeThreadId: thread.id,
    }));
    return thread;
  },

  selectThread: (threadId) =>
    set((state) => {
      if (!threadId || !state.unread[threadId])
        return { activeThreadId: threadId };
      const unread = { ...state.unread };
      delete unread[threadId];
      return { activeThreadId: threadId, unread };
    }),

  deleteThread: async (threadId) => {
    await request("deleteThread", { threadId });
    set((state) => {
      const threads = state.threads.filter((thread) => thread.id !== threadId);
      return {
        threads,
        activeThreadId:
          state.activeThreadId === threadId
            ? (threads[0]?.id ?? null)
            : state.activeThreadId,
      };
    });
  },

  renameThread: async (threadId, title) => {
    await request("renameThread", { threadId, title });
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, title } : thread,
      ),
    }));
  },

  applyStreamMeta: (threadId, event) => {
    if (event.kind === "thread_title_updated" && event.title) {
      set((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, title: event.title ?? thread.title }
            : thread,
        ),
      }));
    }
  },

  setThreadRunning: (threadId, running) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, isRunning: running } : thread,
      ),
    }));
  },

  updateThreadModel: async (threadId, provider, modelId) => {
    await request("setThreadModel", { threadId, provider, modelId });
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, modelProvider: provider, modelId }
          : thread,
      ),
    }));
  },

  setThreadThinking: async (threadId, level) => {
    await request("setThinkingLevel", { threadId, level });
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, thinkingLevel: level } : thread,
      ),
    }));
  },

  setThreadMode: async (threadId, mode) => {
    await request("setThreadMode", { threadId, mode });
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, mode } : thread,
      ),
    }));
  },

  setThreadApprovalPolicy: async (threadId, policy) => {
    await request("setThreadApprovalPolicy", { threadId, policy });
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, approvalPolicy: policy } : thread,
      ),
    }));
  },
}));
