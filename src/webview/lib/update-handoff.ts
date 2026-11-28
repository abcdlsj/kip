/**
 * Zero-data-loss handoff helpers for Seamless Auto-Update.
 * Captures and restores active workspace/thread, unsaved composer drafts,
 * and thread scroll position across atomic `.app` restarts.
 */
import type {
  UpdateHandoffAppState,
  UpdateHandoffPayload,
} from "../../shared/types";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useWorkspaceStore } from "../stores/workspace-store";

interface ScrollSnapshot {
  scrollTop: number;
  scrollPinned: boolean;
}

interface PendingScrollRestore extends ScrollSnapshot {
  threadId: string;
}

const scrollByThread = new Map<string, ScrollSnapshot>();
let pendingScrollRestore: PendingScrollRestore | null = null;

export function recordThreadScroll(
  threadId: string | null,
  scrollTop: number,
  scrollPinned: boolean,
): void {
  if (!threadId) return;
  scrollByThread.set(threadId, { scrollTop, scrollPinned });
}

export function consumePendingScrollRestore(
  threadId: string | null,
): ScrollSnapshot | null {
  if (!threadId || !pendingScrollRestore) return null;
  if (pendingScrollRestore.threadId !== threadId) return null;
  const result: ScrollSnapshot = {
    scrollTop: pendingScrollRestore.scrollTop,
    scrollPinned: pendingScrollRestore.scrollPinned,
  };
  pendingScrollRestore = null;
  return result;
}

export function hasActiveAgentRun(): boolean {
  const chatThreads = useChatStore.getState().threads;
  for (const view of Object.values(chatThreads)) {
    if (view.running || view.approvals.length > 0) return true;
  }
  const wsThreads = useWorkspaceStore.getState().threads;
  return wsThreads.some((thread) => thread.isRunning);
}

export function captureUpdateHandoffState(): UpdateHandoffAppState {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  const { drafts } = useUiStore.getState();
  const scroll = activeThreadId ? scrollByThread.get(activeThreadId) : undefined;
  return {
    activeWorkspaceId,
    activeThreadId,
    drafts: { ...drafts },
    ...(scroll
      ? { scrollTop: scroll.scrollTop, scrollPinned: scroll.scrollPinned }
      : {}),
  };
}

export async function applyUpdateHandoff(
  payload: UpdateHandoffPayload,
): Promise<void> {
  const appState = payload.app_state;
  if (!appState || typeof appState !== "object") return;

  if (appState.drafts && typeof appState.drafts === "object") {
    useUiStore.getState().restoreDrafts(appState.drafts);
  }

  if (
    typeof appState.activeThreadId === "string" &&
    typeof appState.scrollTop === "number"
  ) {
    pendingScrollRestore = {
      threadId: appState.activeThreadId,
      scrollTop: appState.scrollTop,
      scrollPinned: appState.scrollPinned ?? false,
    };
  }

  await useWorkspaceStore
    .getState()
    .restoreSession(
      appState.activeWorkspaceId ?? null,
      appState.activeThreadId ?? null,
    );
}
