import * as Popover from "@radix-ui/react-popover";
import {
  Check,
  FileDown,
  GitBranch,
  Minimize2,
  MoreHorizontal,
  PanelLeftOpen,
} from "lucide-react";
import { useState } from "react";
import type {
  ContextUsage,
  ThreadSummary,
  Workspace,
} from "../../../shared/types";
import { compactHomePath, formatTokens } from "../../lib/format";
import {
  isMac,
  modShortcut,
  needsWindowControls,
  platform,
} from "../../lib/platform";
import { request } from "../../rpc-client";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { ChangesChip } from "./ChangesChip";
import { WindowControls } from "./WindowControls";

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
  const changes = useChatStore((state) =>
    thread ? state.threads[thread.id]?.changes : null,
  );
  const running = useChatStore((state) =>
    thread ? state.threads[thread.id]?.running : false,
  );
  const [compacting, setCompacting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const percent = Math.round(usage.ratio * 100);
  const ringStroke =
    percent > 85
      ? "var(--status-err)"
      : percent > 70
        ? "var(--status-warn)"
        : "var(--text-secondary)";

  const exportThread = async () => {
    if (!thread || exporting) return;
    setExporting(true);
    setMenuOpen(false);
    try {
      const { savedPath } = await request("exportThreadMarkdown", {
        threadId: thread.id,
      });
      if (savedPath) {
        setExported(true);
        setTimeout(() => setExported(false), 2000);
      }
    } finally {
      setExporting(false);
    }
  };

  const compact = async () => {
    if (!thread || compacting) return;
    setCompacting(true);
    setMenuOpen(false);
    try {
      const next = await request("compactThread", { threadId: thread.id });
      setUsage(thread.id, next);
    } finally {
      setCompacting(false);
    }
  };

  // Only macOS reserves space for traffic lights on the left when sidebar is collapsed.
  const leftPadding = collapsed ? (isMac ? "pl-[84px]" : "pl-3") : "pl-4";

  return (
    <header
      onDoubleClick={(event) => {
        // The window is frameless off macOS, so nothing else handles the
        // double-click-to-maximize gesture the system title bar would.
        if (platform === "mac") return;
        if ((event.target as HTMLElement).closest("button, a, input, textarea"))
          return;
        void request("windowControl", { action: "maximize" });
      }}
      className={`drag-region absolute inset-x-0 top-0 z-10 flex h-11 items-center gap-2 pr-3 transition-colors ${
        scrolled ? "border-b hairline" : "border-b border-transparent"
      } ${leftPadding}`}
      style={{
        background: "color-mix(in srgb, var(--bg-canvas) 84%, transparent)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      {collapsed && (
        <button
          type="button"
          onClick={() => void toggleSidebar()}
          className="btn-icon no-drag -ml-1 h-7 w-7 rounded-[7px]"
          aria-label="Open sidebar"
          title={`Open sidebar (${modShortcut("B")})`}
        >
          <PanelLeftOpen size={15} strokeWidth={1.5} />
        </button>
      )}
      <div className="no-drag flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--text-muted)]">
        <span
          className="max-w-[160px] truncate"
          title={workspace ? compactHomePath(workspace.rootPath) : undefined}
        >
          {workspace?.name ?? "Kip"}
        </span>
        {thread && (
          <>
            <span className="opacity-40" aria-hidden="true">
              /
            </span>
            <span
              className="max-w-[340px] truncate font-medium text-[var(--text-primary)]"
              title={thread.title}
            >
              {thread.title}
            </span>
          </>
        )}
      </div>
      <div className="no-drag ml-auto flex items-center gap-1">
        {thread && changes && (
          <ChangesChip
            threadId={thread.id}
            changes={changes}
            running={running ?? false}
          />
        )}
        {workspace?.gitBranch && (
          <span
            className="flex h-6 items-center gap-1.5 rounded-[7px] bg-[var(--bg-subtle)] px-2 text-[11.5px] text-[var(--text-secondary)]"
            title={
              workspace.dirtyFiles > 0
                ? `${workspace.gitBranch} · ${workspace.dirtyFiles} uncommitted ${workspace.dirtyFiles === 1 ? "change" : "changes"}`
                : `Git branch: ${workspace.gitBranch}`
            }
          >
            <GitBranch
              size={11}
              strokeWidth={1.5}
              className="shrink-0 text-[var(--text-muted)]"
            />
            <span className="max-w-[140px] truncate font-mono text-[11px]">
              {workspace.gitBranch}
            </span>
            {workspace.dirtyFiles > 0 && (
              <span className="text-meta text-[11px] text-[var(--status-warn)]">
                +{workspace.dirtyFiles}
              </span>
            )}
          </span>
        )}
        {thread && (
          <button
            type="button"
            onClick={() => void compact()}
            disabled={compacting || running}
            title={
              usage.maxTokens
                ? `Context ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} (${percent}%) · Click to compact`
                : "Compact context"
            }
            className="btn-ghost group h-6 gap-1.5 rounded-[7px] px-1.5"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              className="rotate-[-90deg]"
            >
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="none"
                stroke="var(--border-hairline)"
                strokeWidth="1.6"
              />
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="none"
                stroke={ringStroke}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeDasharray={`${Math.max(0.6, usage.ratio * 34.56)} 34.56`}
                style={{
                  transition:
                    "stroke-dasharray 260ms var(--spring), stroke 200ms ease",
                }}
                className={compacting ? "pulse-dot" : ""}
              />
            </svg>
            <span className="text-meta text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]">
              {percent}%
            </span>
          </button>
        )}
        {thread && (
          <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="btn-icon h-6 w-6 rounded-[7px] data-[state=open]:bg-[var(--bg-subtle)] data-[state=open]:text-[var(--text-primary)]"
                aria-label="Thread options"
                title="Thread options"
              >
                {exported ? (
                  <Check
                    size={13}
                    strokeWidth={1.7}
                    className="text-[var(--status-ok)]"
                  />
                ) : (
                  <MoreHorizontal size={14} strokeWidth={1.5} />
                )}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="bottom"
                align="end"
                sideOffset={6}
                className="popover-surface z-50 w-[180px] rounded-[11px] border hairline bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-modal)] outline-none"
              >
                <button
                  type="button"
                  onClick={() => void compact()}
                  disabled={compacting || running}
                  className="btn-ghost h-7 w-full justify-start gap-2 rounded-[6px] px-2 text-left text-[12px]"
                >
                  <Minimize2
                    size={13}
                    strokeWidth={1.5}
                    className="shrink-0 text-[var(--text-muted)]"
                  />
                  <span>{compacting ? "Compacting…" : "Compact context"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void exportThread()}
                  disabled={exporting}
                  className="btn-ghost h-7 w-full justify-start gap-2 rounded-[6px] px-2 text-left text-[12px]"
                >
                  <FileDown
                    size={13}
                    strokeWidth={1.5}
                    className="shrink-0 text-[var(--text-muted)]"
                  />
                  <span>{exporting ? "Exporting…" : "Export Markdown"}</span>
                </button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      {needsWindowControls && (
        <>
          <span
            className="ml-1 h-3.5 w-px shrink-0 bg-[var(--border-hairline)]"
            aria-hidden="true"
          />
          <WindowControls />
        </>
      )}
    </header>
  );
}
