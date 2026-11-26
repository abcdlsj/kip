import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  FolderClosed,
  MessageSquare,
  Minimize2,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sidebar,
  Sun,
} from "lucide-react";
import type { ThemeMode } from "../../../shared/types";
import { compactHomePath } from "../../lib/format";
import { modShortcut } from "../../lib/platform";
import { request } from "../../rpc-client";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  hint?: string;
  group: string;
  icon: typeof Plus;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const open = useUiStore((state) => state.commandOpen);
  const setOpen = useUiStore((state) => state.setCommandOpen);
  const openSettings = useUiStore((state) => state.openSettings);
  const setTheme = useUiStore((state) => state.setTheme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const threads = useWorkspaceStore((state) => state.threads);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const newThread = useWorkspaceStore((state) => state.newThread);
  const loadTurns = useChatStore((state) => state.load);
  const setUsage = useChatStore((state) => state.setUsage);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "new-thread",
        label: "New Thread",
        shortcut: modShortcut("N"),
        group: "Actions",
        icon: Plus,
        run: () => void newThread(),
      },
      {
        id: "settings",
        label: "Open Settings",
        shortcut: modShortcut(","),
        group: "Actions",
        icon: Settings,
        run: () => openSettings(),
      },
      {
        id: "sidebar",
        label: "Toggle Sidebar",
        shortcut: modShortcut("B"),
        group: "Actions",
        icon: Sidebar,
        run: () => void toggleSidebar(),
      },
      {
        id: "theme-light",
        label: "Theme: Light",
        group: "Appearance",
        icon: Sun,
        run: () => void setTheme("light" as ThemeMode),
      },
      {
        id: "theme-dark",
        label: "Theme: Dark",
        group: "Appearance",
        icon: Moon,
        run: () => void setTheme("dark" as ThemeMode),
      },
      {
        id: "theme-system",
        label: "Theme: System",
        group: "Appearance",
        icon: Monitor,
        run: () => void setTheme("system" as ThemeMode),
      },
      {
        id: "sync",
        label: "Sync Now",
        group: "Actions",
        icon: RefreshCw,
        run: () =>
          void request("triggerSync", undefined).catch(() => undefined),
      },
    ];
    if (activeThreadId) {
      list.splice(3, 0, {
        id: "compact",
        label: "Compact Context",
        group: "Actions",
        icon: Minimize2,
        run: async () => {
          const usage = await request("compactThread", {
            threadId: activeThreadId,
          });
          setUsage(activeThreadId, usage);
        },
      });
    }
    for (const thread of threads.filter((t) => !t.isEmpty).slice(0, 8)) {
      list.push({
        id: `thread-${thread.id}`,
        label: thread.title,
        hint: "Thread",
        group: "Threads",
        icon: MessageSquare,
        run: () => {
          selectThread(thread.id);
          void loadTurns(thread.id);
        },
      });
    }
    for (const workspace of workspaces) {
      list.push({
        id: `workspace-${workspace.id}`,
        label: workspace.name,
        hint: compactHomePath(workspace.rootPath),
        group: "Workspaces",
        icon: FolderClosed,
        run: () => void selectWorkspace(workspace.id),
      });
    }
    return list;
  }, [
    activeThreadId,
    loadTurns,
    newThread,
    openSettings,
    selectThread,
    selectWorkspace,
    setTheme,
    setUsage,
    threads,
    toggleSidebar,
    workspaces,
  ]);

  const filtered = commands.filter((command) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      command.label.toLowerCase().includes(needle) ||
      command.group.toLowerCase().includes(needle) ||
      (command.hint?.toLowerCase().includes(needle) ?? false)
    );
  });

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-index="${selected}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);

  const runCommand = async (command: Command | undefined) => {
    if (!command) return;
    setOpen(false);
    await command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-[var(--bg-scrim)] backdrop-blur-[4px]" />
        <Dialog.Content
          className="modal-surface fixed left-1/2 z-50 w-[560px] max-w-[calc(100vw-40px)] -translate-x-1/2 overflow-hidden rounded-[14px] border hairline bg-[var(--bg-elevated)] shadow-[var(--shadow-modal)] outline-none"
          style={{ top: "15vh" }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b hairline px-4">
            <Search
              size={15}
              strokeWidth={1.5}
              className="shrink-0 text-[var(--text-muted)]"
            />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelected((index) =>
                    Math.min(Math.max(0, filtered.length - 1), index + 1),
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelected((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void runCommand(filtered[selected]);
                }
              }}
              placeholder="Search commands, threads, workspaces…"
              className="w-full bg-transparent py-3.5 text-[14.5px] placeholder:text-[var(--text-muted)]"
            />
            <span className="kbd shrink-0">Esc</span>
          </div>
          <div
            ref={listRef}
            className="thin-scroll max-h-[340px] overflow-y-auto p-1.5"
          >
            {filtered.map((command, index) => {
              const Icon = command.icon;
              const showGroup =
                index === 0 || filtered[index - 1]?.group !== command.group;
              const isSelected = index === selected;
              return (
                <div key={command.id}>
                  {showGroup && (
                    <p
                      className={`px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)] ${
                        index === 0 ? "pt-1" : "pt-2.5"
                      }`}
                    >
                      {command.group}
                    </p>
                  )}
                  <button
                    type="button"
                    data-cmd-index={index}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => void runCommand(command)}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left transition-colors ${
                      isSelected
                        ? "bg-[var(--bg-subtle)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)]"
                    }`}
                  >
                    <Icon
                      size={14}
                      strokeWidth={1.5}
                      className={
                        isSelected
                          ? "shrink-0 text-[var(--text-primary)]"
                          : "shrink-0 text-[var(--text-muted)]"
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {command.label}
                    </span>
                    {command.hint && (
                      <span className="max-w-[190px] truncate font-mono text-[11px] text-[var(--text-muted)]">
                        {command.hint}
                      </span>
                    )}
                    {command.shortcut ? (
                      <span className="kbd shrink-0">{command.shortcut}</span>
                    ) : (
                      isSelected && (
                        <ArrowRight
                          size={12}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--text-muted)]"
                        />
                      )
                    )}
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-2 py-6 text-center text-[12.5px] text-[var(--text-muted)]">
                No matches for “{query}”
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
