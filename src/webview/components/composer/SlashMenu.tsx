import {
  FileDown,
  Minimize2,
  type LucideIcon,
  Settings,
  ShieldCheck,
  ShieldHalf,
  ShieldOff,
  SquarePen,
  Undo2,
} from "lucide-react";
import type { ApprovalPolicy } from "../../../shared/types";

export type SlashCommandId =
  | "new"
  | "compact"
  | "undo"
  | "read-only-auto"
  | "full-auto"
  | "strict"
  | "export"
  | "settings";

export interface SlashCommand {
  id: SlashCommandId;
  description: string;
  icon: LucideIcon;
  group: "Thread" | "Approval" | "App";
  /** Set for approval commands; used to mark the active policy. */
  policy?: ApprovalPolicy;
  needsThread?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "new", description: "Start a new thread", icon: SquarePen, group: "Thread" },
  {
    id: "compact",
    description: "Summarize earlier context to free space",
    icon: Minimize2,
    group: "Thread",
    needsThread: true,
  },
  {
    id: "undo",
    description: "Undo file changes from the last turn",
    icon: Undo2,
    group: "Thread",
    needsThread: true,
  },
  {
    id: "export",
    description: "Export this thread as Markdown",
    icon: FileDown,
    group: "Thread",
    needsThread: true,
  },
  {
    id: "read-only-auto",
    description: "Ask before writes and commands",
    icon: ShieldHalf,
    group: "Approval",
    policy: "read-only-auto",
  },
  {
    id: "full-auto",
    description: "Work inside the workspace without asking",
    icon: ShieldOff,
    group: "Approval",
    policy: "full-auto",
  },
  {
    id: "strict",
    description: "Ask before every tool call",
    icon: ShieldCheck,
    group: "Approval",
    policy: "strict",
  },
  { id: "settings", description: "Open settings", icon: Settings, group: "App" },
];

/** The partial command name while the draft is a lone `/word`, else null. */
export function slashQuery(draft: string): string | null {
  const match = /^\/([\w-]*)$/.exec(draft);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function matchCommands(query: string, hasThread: boolean): SlashCommand[] {
  const available = SLASH_COMMANDS.filter((command) => hasThread || !command.needsThread);
  if (!query) return available;
  const starts = available.filter((command) => command.id.startsWith(query));
  const contains = available.filter(
    (command) =>
      !command.id.startsWith(query) &&
      (command.id.includes(query) || command.description.toLowerCase().includes(query)),
  );
  return [...starts, ...contains];
}

interface SlashMenuProps {
  commands: SlashCommand[];
  selected: number;
  /** Group headers only make sense for the full, unfiltered list. */
  grouped: boolean;
  policy: ApprovalPolicy | undefined;
  onHover: (index: number) => void;
  onRun: (command: SlashCommand) => void;
}

export function SlashMenu({ commands, selected, grouped, policy, onHover, onRun }: SlashMenuProps) {
  if (commands.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-[340px] rounded-[12px] border hairline bg-[var(--bg-elevated)] px-3 py-2.5 text-[12.5px] text-[var(--text-muted)] shadow-[var(--shadow-modal)]">
        No matching command
      </div>
    );
  }
  let lastGroup = "";
  return (
    <div
      role="listbox"
      className="absolute bottom-full left-0 mb-2 w-[340px] overflow-hidden rounded-[12px] border hairline bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-modal)]"
    >
      {commands.map((command, index) => {
        const header = grouped && command.group !== lastGroup ? command.group : null;
        lastGroup = command.group;
        const Icon = command.icon;
        const active = index === selected;
        const current = command.policy !== undefined && command.policy === policy;
        return (
          <div key={command.id}>
            {header && (
              <p className={`px-2 pb-1 text-[11px] font-medium text-[var(--text-muted)] ${index === 0 ? "pt-1" : "pt-2"}`}>
                {header}
              </p>
            )}
            <button
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onRun(command);
              }}
              className={`flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2 text-left transition-colors ${
                active ? "bg-[var(--bg-subtle)]" : ""
              }`}
            >
              <Icon
                size={13}
                strokeWidth={1.5}
                className={`shrink-0 ${active ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
              />
              <span className="shrink-0 font-[var(--font-mono)] text-[12.5px] text-[var(--text-primary)]">
                /{command.id}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">
                {command.description}
              </span>
              {current ? (
                <span className="shrink-0 text-[11px] font-medium text-[var(--text-secondary)]">Current</span>
              ) : (
                active && <span className="kbd shrink-0">↵</span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
