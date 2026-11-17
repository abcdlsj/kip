import { useEffect, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { Logo } from "./components/layout/Logo";
import { CommandPalette } from "./components/modals/CommandPalette";
import { SettingsModal } from "./components/modals/SettingsModal";
import { onAgentStream, onSyncStatus } from "./rpc-client";
import { useChatStore } from "./stores/chat-store";
import { useUiStore } from "./stores/ui-store";
import { useWorkspaceStore } from "./stores/workspace-store";

export default function App() {
  const [booted, setBooted] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([
        useUiStore.getState().initialize(),
        useWorkspaceStore.getState().initialize(),
      ]);
      if (!cancelled) setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!booted || !activeThreadId) return;
    void useChatStore.getState().load(activeThreadId).catch(() => undefined);
  }, [activeThreadId, booted]);

  useEffect(() => {
    return onAgentStream(({ threadId, event }) => {
      useChatStore.getState().applyEvent(threadId, event);
      useWorkspaceStore.getState().applyStreamMeta({
        kind: event.kind,
        title: event.kind === "thread_title_updated" ? event.title : undefined,
      });
      if (event.kind === "turn_start") {
        useWorkspaceStore.getState().setThreadRunning(threadId, true);
      } else if (event.kind === "turn_complete" || event.kind === "turn_error") {
        useWorkspaceStore.getState().setThreadRunning(threadId, false);
      }
    });
  }, []);

  useEffect(() => {
    return onSyncStatus(({ state, message }) => {
      useUiStore.getState().setSyncState(state, message);
    });
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const ui = useUiStore.getState();
      const workspace = useWorkspaceStore.getState();
      if (event.key === "Escape") {
        if (ui.commandOpen) {
          ui.setCommandOpen(false);
          return;
        }
        if (ui.settingsOpen) {
          ui.closeSettings();
          return;
        }
        const threadId = workspace.activeThreadId;
        const view = threadId ? useChatStore.getState().threads[threadId] : undefined;
        if (threadId && view?.running) {
          void useChatStore.getState().abort(threadId);
        }
        return;
      }
      if (!meta) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        ui.setCommandOpen(!ui.commandOpen);
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void workspace.newThread();
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        void ui.toggleSidebar();
      } else if (event.key === ",") {
        event.preventDefault();
        ui.openSettings();
      } else if (event.key === "Enter") {
        const threadId = workspace.activeThreadId;
        if (!threadId) return;
        const view = useChatStore.getState().threads[threadId];
        const pending = view?.approvals[0];
        if (!pending) return;
        event.preventDefault();
        void useChatStore
          .getState()
          .resolveApproval(threadId, pending.toolCallId, true, false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!booted) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[var(--bg-canvas)]">
        <div className="pulse-dot">
          <Logo size={44} />
        </div>
        <p className="text-meta text-[var(--text-muted)]">KIP</p>
      </div>
    );
  }

  return (
    <>
      <AppShell scrolled={scrolled} onScrolled={setScrolled} />
      <SettingsModal />
      <CommandPalette />
    </>
  );
}
