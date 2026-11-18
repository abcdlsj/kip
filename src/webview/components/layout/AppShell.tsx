import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { ThreadCanvas } from "../chat/ThreadCanvas";
import { Composer } from "../composer/Composer";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

interface AppShellProps {
  scrolled: boolean;
  onScrolled: (scrolled: boolean) => void;
}

export function AppShell({ scrolled, onScrolled }: AppShellProps) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const threads = useWorkspaceStore((state) => state.threads);
  const view = useChatStore((state) =>
    activeThreadId ? state.threads[activeThreadId] : undefined,
  );

  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const thread = threads.find((item) => item.id === activeThreadId) ?? null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-window)]">
      <Sidebar />
      {/* The content sits on an inset panel; the sidebar shares the window chrome. */}
      <main
        className={`relative my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-[var(--bg-canvas)] shadow-[var(--shadow-panel)] ${
          collapsed ? "ml-1.5" : ""
        }`}
      >
        <TopBar
          workspace={workspace}
          thread={thread}
          usage={view?.usage ?? { usedTokens: 0, maxTokens: 0, ratio: 0 }}
          scrolled={scrolled}
        />
        <ThreadCanvas threadId={activeThreadId} workspace={workspace} onScrolled={onScrolled} />
        <Composer />
      </main>
    </div>
  );
}
