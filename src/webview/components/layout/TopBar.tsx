import { GitBranch, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import type { ContextUsage, ThreadSummary, Workspace } from "../../../shared/types";
import { formatTokens } from "../../lib/format";
import { request } from "../../rpc-client";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";

interface TopBarProps {
  workspace: Workspace | null;
  thread: ThreadSummary | null;
  usage: ContextUsage;
  scrolled: boolean;
}

export function TopBar({ workspace, thread, usage, scrolled }: TopBarProps) {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const setUsage = useChatStore((state) => state.setUsage);
  const [compacting, setCompacting] = useState(false);
  const percent = Math.round(usage.ratio * 100);

  const compact = async () => {
    if (!thread || compacting) return;
    setCompacting(true);
    try {
      const next = await request("compactThread", { threadId: thread.id });
      setUsage(thread.id, next);
    } finally {
      setCompacting(false);
    }
  };

  return (
    <header
      className={`drag-region absolute inset-x-0 top-0 z-10 flex h-11 items-center gap-2 pr-3 transition-colors ${
        scrolled ? "border-b hairline" : "border-b border-transparent"
      } ${collapsed ? "pl-[84px]" : "pl-4"}`}
      style={{
        background: "color-mix(in srgb, var(--bg-canvas) 82%, transparent)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      {collapsed && (
        <button
          onClick={() => void toggleSidebar()}
          className="no-drag -ml-1 flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
          aria-label="Open sidebar"
          title="Open sidebar (⌘B)"
        >
          <PanelLeftOpen size={15} strokeWidth={1.5} />
        </button>
      )}
      <div className="no-drag flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--text-muted)]">
        <span className="max-w-[160px] truncate">{workspace?.name ?? "Kip"}</span>
        {thread && (
          <>
            <span className="opacity-40">/</span>
            <span className="max-w-[320px] truncate font-medium text-[var(--text-primary)]">
              {thread.title}
            </span>
          </>
        )}
      </div>
      <div className="no-drag ml-auto flex items-center gap-2.5">
        {workspace?.gitBranch && (
          <span className="flex h-6 items-center gap-1.5 rounded-[7px] bg-[var(--bg-subtle)] px-2 text-[11.5px] text-[var(--text-secondary)]">
            <GitBranch size={11} strokeWidth={1.5} />
            <span className="max-w-[140px] truncate font-[var(--font-mono)] text-[11px]">
              {workspace.gitBranch}
            </span>
            {workspace.dirtyFiles > 0 && (
              <span className="text-[11px] text-[var(--status-warn)]">+{workspace.dirtyFiles}</span>
            )}
          </span>
        )}
        {thread && (
          <button
            onClick={() => void compact()}
            disabled={compacting}
            title={
              usage.maxTokens
                ? `Context ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} · Click to compact`
                : "Compact context"
            }
            className="group flex h-6 items-center gap-1.5 rounded-[7px] px-1.5 transition-colors hover:bg-[var(--bg-subtle)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" className="rotate-[-90deg]">
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="none"
                stroke="var(--border-focus)"
                strokeWidth="1.5"
              />
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="none"
                stroke={percent > 85 ? "var(--status-err)" : "var(--text-secondary)"}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={`${Math.max(0.5, usage.ratio * 34.56)} 34.56`}
                className={compacting ? "pulse-dot" : ""}
              />
            </svg>
            <span className="text-meta text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]">
              {percent}%
            </span>
          </button>
        )}
      </div>
    </header>
  );
}
