import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { motion } from "motion/react";
import {
  Check,
  ChevronsUpDown,
  FolderClosed,
  GitBranch,
  MessageCircle,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { SIDEBAR_WIDTH } from "../../../shared/constants";
import { compactHomePath, groupThreads } from "../../lib/format";
import { modShortcut } from "../../lib/platform";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { UpdatePill } from "./UpdatePill";

export function Sidebar() {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const openSettings = useUiStore((state) => state.openSettings);
  const setCommandOpen = useUiStore((state) => state.setCommandOpen);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId,
  );
  const threads = useWorkspaceStore((state) => state.threads);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const pickWorkspace = useWorkspaceStore((state) => state.pickWorkspace);
  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const newThread = useWorkspaceStore((state) => state.newThread);
  const deleteThread = useWorkspaceStore((state) => state.deleteThread);
  const renameThread = useWorkspaceStore((state) => state.renameThread);
  const load = useChatStore((state) => state.load);
  const unread = useWorkspaceStore((state) => state.unread);
  // Only the ids are needed; avoid re-rendering on every streamed token.
  const awaiting = useChatStore((state) =>
    Object.entries(state.threads)
      .filter(([, view]) => view.approvals.length > 0)
      .map(([id]) => id)
      .join(","),
  );
  const awaitingIds = new Set(awaiting ? awaiting.split(",") : []);

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  // Deleting removes the transcript from disk, so the first click only arms it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmRemoveWsId, setConfirmRemoveWsId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  useEffect(() => {
    if (!confirmRemoveWsId) return;
    const timer = setTimeout(() => setConfirmRemoveWsId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmRemoveWsId]);

  useEffect(() => {
    if (!workspaceOpen) setConfirmRemoveWsId(null);
  }, [workspaceOpen]);

  const workspace =
    workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const visibleThreads = threads.filter((thread) => !thread.isEmpty);
  const groups = groupThreads(visibleThreads);

  const openThread = (threadId: string) => {
    selectThread(threadId);
    void load(threadId);
  };

  const beginRename = (threadId: string, title: string) => {
    setEditingId(threadId);
    setDraftTitle(title);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const title = draftTitle.trim();
    if (title) await renameThread(editingId, title);
    setEditingId(null);
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
      transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
      className="relative z-20 flex h-full shrink-0 flex-col overflow-hidden bg-[var(--bg-sidebar)]"
    >
      {/* Traffic lights sit on the left of this strip on macOS. */}
      <div className="drag-region flex h-[44px] shrink-0 items-center justify-end gap-0.5 px-2.5">
        {!collapsed && (
          <>
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="btn-icon no-drag h-7 w-7 rounded-[7px]"
              aria-label="Command palette"
              title={`Search & commands (${modShortcut("K")})`}
            >
              <Search size={14} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => void toggleSidebar()}
              className="btn-icon no-drag h-7 w-7 rounded-[7px]"
              aria-label="Collapse sidebar"
              title={`Collapse sidebar (${modShortcut("B")})`}
            >
              <PanelLeftClose size={15} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="space-y-0.5 px-2.5">
            <Popover.Root open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  title={
                    workspace
                      ? compactHomePath(workspace.rootPath)
                      : "Switch workspace"
                  }
                  className="btn-ghost h-8 w-full justify-start gap-2 rounded-[8px] px-2 text-left text-[var(--text-primary)]"
                >
                  <FolderClosed
                    size={14}
                    strokeWidth={1.5}
                    className="shrink-0 text-[var(--text-secondary)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {workspace?.name ?? "Workspace"}
                  </span>
                  <ChevronsUpDown
                    size={13}
                    strokeWidth={1.5}
                    className="shrink-0 text-[var(--text-muted)]"
                  />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="start"
                  sideOffset={4}
                  className="popover-surface z-50 w-[248px] rounded-[11px] border hairline bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-modal)] outline-none"
                >
                  <p className="px-2 pb-1 pt-1 text-[11px] font-medium text-[var(--text-muted)]">
                    Workspaces
                  </p>
                  <div className="thin-scroll max-h-[220px] space-y-0.5 overflow-y-auto">
                    {workspaces.map((item) => {
                      const isActive = item.id === activeWorkspaceId;
                      const armed = confirmRemoveWsId === item.id;
                      return (
                        <div
                          key={item.id}
                          className={`group/ws flex items-center gap-1 rounded-[7px] px-2 py-1.5 transition-colors ${
                            isActive
                              ? "bg-[var(--bg-subtle)]"
                              : "hover:bg-[var(--bg-subtle)]"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              void selectWorkspace(item.id);
                              setWorkspaceOpen(false);
                            }}
                            title={compactHomePath(item.rootPath)}
                            className="flex min-w-0 flex-1 flex-col text-left"
                          >
                            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
                              <span className="truncate">{item.name}</span>
                              {item.gitBranch && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] font-normal text-[var(--text-muted)]">
                                  <GitBranch size={10} strokeWidth={1.5} />
                                  <span className="max-w-[72px] truncate">
                                    {item.gitBranch}
                                  </span>
                                </span>
                              )}
                            </span>
                            <span className="truncate font-mono text-[10.5px] text-[var(--text-muted)]">
                              {compactHomePath(item.rootPath)}
                            </span>
                          </button>
                          {isActive && !armed && (
                            <Check
                              size={12}
                              strokeWidth={1.7}
                              className="shrink-0 text-[var(--text-secondary)]"
                            />
                          )}
                          {workspaces.length > 1 && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                if (armed) {
                                  setConfirmRemoveWsId(null);
                                  void removeWorkspace(item.id);
                                } else {
                                  setConfirmRemoveWsId(item.id);
                                }
                              }}
                              aria-label={
                                armed
                                  ? "Confirm remove workspace"
                                  : "Remove workspace"
                              }
                              className={`flex h-5 shrink-0 items-center justify-center rounded-[5px] transition-opacity ${
                                armed
                                  ? "bg-[color-mix(in_srgb,var(--status-err)_12%,transparent)] px-1.5 text-[11px] font-medium text-[var(--status-err)] opacity-100"
                                  : "w-5 text-[var(--text-muted)] opacity-0 hover:bg-[var(--bg-active)] hover:text-[var(--status-err)] group-hover/ws:opacity-100"
                              }`}
                            >
                              {armed ? (
                                "Remove?"
                              ) : (
                                <Trash2 size={11} strokeWidth={1.5} />
                              )}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="my-1 border-t hairline" />
                  <button
                    type="button"
                    onClick={() => {
                      void pickWorkspace();
                      setWorkspaceOpen(false);
                    }}
                    className="btn-ghost h-8 w-full justify-start gap-2 rounded-[7px] px-2 text-left text-[12.5px]"
                  >
                    <Plus size={13} strokeWidth={1.5} />
                    Add folder
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <button
              type="button"
              onClick={() => void newThread()}
              className="btn-ghost group/new h-8 w-full justify-start gap-2 rounded-[8px] px-2 text-[13px]"
            >
              <SquarePen size={14} strokeWidth={1.5} className="shrink-0" />
              <span className="whitespace-nowrap">New thread</span>
              <span className="kbd ml-auto shrink-0 opacity-0 transition-opacity group-hover/new:opacity-100">
                {modShortcut("N")}
              </span>
            </button>
          </div>

          <div className="thin-scroll mt-4 flex-1 overflow-y-auto px-2.5 pb-2">
            {groups.map((group) => (
              <div key={group.label} className="mb-4">
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)]">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((thread) => {
                    const active = thread.id === activeThreadId;
                    const armed = confirmDeleteId === thread.id;
                    return (
                      <div
                        key={thread.id}
                        className={`group flex h-8 items-center gap-1.5 rounded-[8px] px-2 transition-colors ${
                          active
                            ? "bg-[var(--bg-active)]"
                            : "hover:bg-[var(--bg-subtle)]"
                        }`}
                      >
                        {editingId === thread.id ? (
                          <input
                            autoFocus
                            value={draftTitle}
                            onChange={(event) =>
                              setDraftTitle(event.target.value)
                            }
                            onBlur={() => void commitRename()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void commitRename();
                              if (event.key === "Escape") setEditingId(null);
                            }}
                            className="w-full rounded-[4px] bg-[var(--bg-elevated)] px-1 py-0.5 text-[13px] outline-none ring-1 ring-[var(--border-focus)]"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => openThread(thread.id)}
                            onDoubleClick={() =>
                              beginRename(thread.id, thread.title)
                            }
                            title={thread.title}
                            className={`min-w-0 flex-1 truncate text-left text-[13px] ${
                              active
                                ? "font-medium text-[var(--text-primary)]"
                                : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                            }`}
                          >
                            {thread.title}
                          </button>
                        )}
                        {thread.mode === "chat" && (
                          <MessageCircle
                            size={11}
                            strokeWidth={1.5}
                            className="shrink-0 text-[var(--text-muted)]"
                            aria-label="Chat thread"
                          >
                            <title>
                              Chat thread: no tools, no system prompt
                            </title>
                          </MessageCircle>
                        )}
                        <ThreadStatus
                          state={
                            awaitingIds.has(thread.id)
                              ? "attention"
                              : thread.isRunning
                                ? "working"
                                : unread[thread.id] && !active
                                  ? "done"
                                  : null
                          }
                        />
                        {editingId !== thread.id && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (armed) {
                                setConfirmDeleteId(null);
                                void deleteThread(thread.id);
                              } else {
                                setConfirmDeleteId(thread.id);
                              }
                            }}
                            className={`flex h-5 shrink-0 items-center justify-center rounded-[5px] transition-all ${
                              armed
                                ? "bg-[color-mix(in_srgb,var(--status-err)_12%,transparent)] px-1.5 text-[11px] font-medium text-[var(--status-err)] opacity-100"
                                : "w-5 text-[var(--text-muted)] opacity-0 hover:bg-[var(--bg-active)] hover:text-[var(--status-err)] focus-visible:opacity-100 group-hover:opacity-100"
                            }`}
                            aria-label={
                              armed ? "Confirm delete thread" : "Delete thread"
                            }
                            title={
                              armed ? "Click again to delete" : "Delete thread"
                            }
                          >
                            {armed ? (
                              "Delete?"
                            ) : (
                              <Trash2 size={12} strokeWidth={1.5} />
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {visibleThreads.length === 0 && (
              <p className="px-2 pt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                No threads yet.
              </p>
            )}
          </div>

          <div className="px-2.5 pb-2.5 pt-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => openSettings()}
                title={`Settings (${modShortcut(",")})`}
                className="btn-ghost h-8 min-w-0 flex-1 justify-start gap-2 rounded-[8px] px-2 text-[13px]"
              >
                <Settings size={14} strokeWidth={1.5} className="shrink-0" />
                Settings
              </button>
              <UpdatePill />
            </div>
          </div>
        </>
      )}
    </motion.aside>
  );
}

function ThreadStatus({
  state,
}: {
  state: "working" | "attention" | "done" | null;
}) {
  if (!state) return null;
  if (state === "working") {
    return (
      <span
        className="ring-spin h-[11px] w-[11px] shrink-0"
        aria-label="Working"
        title="Working"
      />
    );
  }
  return (
    <span
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{
        background:
          state === "attention"
            ? "var(--signal-attention)"
            : "var(--signal-done)",
      }}
      aria-label={state === "attention" ? "Waiting for approval" : "Finished"}
      title={state === "attention" ? "Waiting for approval" : "Finished"}
    />
  );
}
