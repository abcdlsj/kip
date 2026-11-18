import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronsUpDown,
  FolderClosed,
  PanelLeftClose,
  Plus,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { SIDEBAR_WIDTH } from "../../../shared/constants";
import { groupThreads } from "../../lib/format";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export function Sidebar() {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const openSettings = useUiStore((state) => state.openSettings);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const threads = useWorkspaceStore((state) => state.threads);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const pickWorkspace = useWorkspaceStore((state) => state.pickWorkspace);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const newThread = useWorkspaceStore((state) => state.newThread);
  const deleteThread = useWorkspaceStore((state) => state.deleteThread);
  const renameThread = useWorkspaceStore((state) => state.renameThread);
  const load = useChatStore((state) => state.load);

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  // Deleting removes the transcript from disk, so the first click only arms it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  const workspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const groups = groupThreads(threads);

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
      {/* Traffic lights sit on the left of this strip. */}
      <div className="drag-region flex h-[44px] shrink-0 items-center justify-end px-2.5">
        {!collapsed && (
          <button
            onClick={() => void toggleSidebar()}
            className="no-drag flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘B)"
          >
            <PanelLeftClose size={15} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="space-y-0.5 px-2.5">
            <Popover.Root open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
              <Popover.Trigger asChild>
                <button className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left transition-colors hover:bg-[var(--bg-subtle)]">
                  <FolderClosed size={14} strokeWidth={1.5} className="shrink-0 text-[var(--text-secondary)]" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {workspace?.name ?? "Workspace"}
                  </span>
                  <ChevronsUpDown size={13} strokeWidth={1.5} className="text-[var(--text-muted)]" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="start"
                  sideOffset={4}
                  className="z-50 w-[224px] rounded-[10px] border hairline bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-modal)]"
                >
                  {workspaces.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        void selectWorkspace(item.id);
                        setWorkspaceOpen(false);
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12.5px] transition-colors hover:bg-[var(--bg-subtle)]"
                    >
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {item.id === activeWorkspaceId && (
                        <Check size={12} strokeWidth={1.5} className="text-[var(--text-secondary)]" />
                      )}
                    </button>
                  ))}
                  <div className="my-1 border-t hairline" />
                  <button
                    onClick={() => {
                      void pickWorkspace();
                      setWorkspaceOpen(false);
                    }}
                    className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
                  >
                    <Plus size={13} strokeWidth={1.5} />
                    Add folder
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <button
              onClick={() => void newThread()}
              className="group/new flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
            >
              <SquarePen size={14} strokeWidth={1.5} className="shrink-0" />
              <span className="whitespace-nowrap">New thread</span>
              <span className="kbd ml-auto shrink-0 opacity-0 transition-opacity group-hover/new:opacity-100">
                ⌘N
              </span>
            </button>
          </div>

          <div className="mt-4 flex-1 overflow-y-auto px-2.5 pb-2 scrollbar-none">
            {groups.map((group) => (
              <div key={group.label} className="mb-4">
                <p className="px-2 pb-1 text-[11.5px] font-medium text-[var(--text-muted)]">
                  {group.label}
                </p>
                {group.items.map((thread) => {
                  const active = thread.id === activeThreadId;
                  return (
                    <div
                      key={thread.id}
                      className={`group flex h-8 items-center gap-2 rounded-[8px] px-2 transition-colors ${
                        active ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-subtle)]"
                      }`}
                    >
                      {thread.isRunning && (
                        <span
                          className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-action)]"
                          aria-label="Running"
                        />
                      )}
                      {editingId === thread.id ? (
                        <input
                          autoFocus
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onBlur={() => void commitRename()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void commitRename();
                            if (event.key === "Escape") setEditingId(null);
                          }}
                          className="w-full bg-transparent text-[13px] outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => openThread(thread.id)}
                          onDoubleClick={() => beginRename(thread.id, thread.title)}
                          className={`min-w-0 flex-1 truncate text-left text-[13px] ${
                            active
                              ? "text-[var(--text-primary)]"
                              : "text-[var(--text-secondary)]"
                          }`}
                        >
                          {thread.title}
                        </button>
                      )}
                      <AnimatePresence>
                        {active && editingId !== thread.id && (
                          <motion.button
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => {
                              if (confirmDeleteId === thread.id) {
                                setConfirmDeleteId(null);
                                void deleteThread(thread.id);
                              } else {
                                setConfirmDeleteId(thread.id);
                              }
                            }}
                            className={`ml-1 flex h-5 shrink-0 items-center justify-center rounded-[5px] transition-opacity hover:bg-[var(--bg-subtle)] ${
                              confirmDeleteId === thread.id
                                ? "px-1.5 text-[11.5px] font-medium text-[var(--status-err)] opacity-100"
                                : "w-5 text-[var(--text-muted)] opacity-0 hover:text-[var(--status-err)] group-hover:opacity-100"
                            }`}
                            aria-label={confirmDeleteId === thread.id ? "Confirm delete thread" : "Delete thread"}
                          >
                            {confirmDeleteId === thread.id ? (
                              "Delete?"
                            ) : (
                              <Trash2 size={12} strokeWidth={1.5} />
                            )}
                          </motion.button>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            ))}
            {threads.length === 0 && (
              <p className="px-2 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                No threads yet.
              </p>
            )}
          </div>

          <div className="px-2.5 pb-2.5 pt-1">
            <button
              onClick={() => openSettings()}
              className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
            >
              <Settings size={14} strokeWidth={1.5} className="shrink-0" />
              Settings
            </button>
          </div>
        </>
      )}
    </motion.aside>
  );
}
