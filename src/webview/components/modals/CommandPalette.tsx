import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  FolderClosed,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Sidebar,
  Sun,
  Minimize2,
} from "lucide-react";
import type { ThemeMode } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

interface Command {
  id: string;
  label: string;
  hint: string;
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
        hint: "⌘N",
        group: "Actions",
        icon: Plus,
        run: () => void newThread(),
      },
      {
        id: "settings",
        label: "Open Settings",
        hint: "⌘,",
        group: "Actions",
        icon: Settings,
        run: () => openSettings(),
      },
      {
        id: "sidebar",
        label: "Toggle Sidebar",
        hint: "⌘B",
        group: "Actions",
        icon: Sidebar,
        run: () => void toggleSidebar(),
      },
      {
        id: "theme-light",
        label: "Theme: Light",
        hint: "",
        group: "Appearance",
        icon: Sun,
        run: () => void setTheme("light" as ThemeMode),
      },
      {
        id: "theme-dark",
        label: "Theme: Dark",
        hint: "",
        group: "Appearance",
        icon: Moon,
        run: () => void setTheme("dark" as ThemeMode),
      },
      {
        id: "theme-system",
        label: "Theme: System",
        hint: "",
        group: "Appearance",
        icon: Sun,
        run: () => void setTheme("system" as ThemeMode),
      },
      {
        id: "sync",
        label: "Sync Now",
        hint: "",
        group: "Actions",
        icon: RefreshCw,
        run: () => void request("triggerSync", undefined).catch(() => undefined),
      },
    ];
    if (activeThreadId) {
      list.splice(3, 0, {
        id: "compact",
        label: "Compact Context",
        hint: "",
        group: "Actions",
        icon: Minimize2,
        run: async () => {
          const usage = await request("compactThread", { threadId: activeThreadId });
          setUsage(activeThreadId, usage);
        },
      });
    }
    for (const thread of threads.slice(0, 8)) {
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
        hint: workspace.rootPath,
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
      command.group.toLowerCase().includes(needle)
    );
  });

  const runCommand = async (command: Command | undefined) => {
    if (!command) return;
    setOpen(false);
    await command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--bg-scrim)] backdrop-blur-[4px]" />
        <Dialog.Content
          className="fixed left-1/2 z-50 w-[560px] max-w-[calc(100vw-40px)] -translate-x-1/2 overflow-hidden rounded-[14px] border hairline bg-[var(--bg-elevated)] shadow-[var(--shadow-modal)]"
          style={{ top: "16vh" }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
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
                setSelected((index) => Math.min(filtered.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                void runCommand(filtered[selected]);
              }
            }}
            placeholder="Search Kip…"
            className="w-full border-b hairline bg-transparent px-4 py-3.5 text-[15px]"
          />
          <div className="max-h-[320px] overflow-y-auto p-1.5 thin-scroll">
            {filtered.map((command, index) => {
              const Icon = command.icon;
              const showGroup = index === 0 || filtered[index - 1]?.group !== command.group;
              return (
                <div key={command.id}>
                  {showGroup && (
                    <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--text-muted)]">
                      {command.group}
                    </p>
                  )}
                  <button
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => void runCommand(command)}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2 text-left transition-colors ${
                      index === selected ? "bg-[var(--bg-subtle)]" : ""
                    }`}
                  >
                    <Icon size={13} strokeWidth={1.5} className="text-[var(--text-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{command.label}</span>
                    {command.hint && (
                      <span className="max-w-[180px] truncate text-[11px] text-[var(--text-muted)]">
                        {command.hint}
                      </span>
                    )}
                    {index === selected && (
                      <ArrowRight size={12} strokeWidth={1.5} className="text-[var(--text-muted)]" />
                    )}
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">
                No matches
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
