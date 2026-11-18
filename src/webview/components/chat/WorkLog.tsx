import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import type {
  ThinkingBlock,
  ToolApprovalPayload,
  ToolCallBlock,
} from "../../../shared/types";
import { ToolStepPill } from "./ToolStepPill";

type WorkBlock = ThinkingBlock | ToolCallBlock;

interface WorkLogProps {
  blocks: WorkBlock[];
  running: boolean;
  approvals: ToolApprovalPayload[];
}

function durationLabel(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function shortPath(value: string): string {
  const parts = value.split("/");
  const source = parts.indexOf("src");
  if (source >= 0) return parts.slice(source).join("/");
  if (parts.length > 4) return `…/${parts.slice(-3).join("/")}`;
  return value;
}

function currentAction(block: WorkBlock | undefined): string {
  if (!block) return "Working";
  if (block.type === "thinking") return "Thinking";
  const path = typeof block.args.path === "string" ? shortPath(block.args.path) : "";
  switch (block.toolName) {
    case "bash": {
      const command = typeof block.args.command === "string" ? block.args.command : "";
      return command ? `Running ${command.length > 40 ? `${command.slice(0, 37)}…` : command}` : "Running a command";
    }
    case "read":
      return path ? `Reading ${path}` : "Reading a file";
    case "edit":
      return path ? `Editing ${path}` : "Editing";
    case "write":
      return path ? `Writing ${path}` : "Writing";
    case "grep":
      return "Searching the codebase";
    case "find":
      return "Finding files";
    case "ls":
      return "Listing files";
    default:
      return `Using ${block.toolName}`;
  }
}

export function WorkLog({ blocks, running, approvals }: WorkLogProps) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const startedAt = useRef(Date.now());

  const pending = approvals.filter((item) =>
    blocks.some((block) => block.type === "tool_call" && block.id === item.toolCallId),
  );
  const hasError = blocks.some(
    (block) => block.type === "tool_call" && block.status === "error",
  );
  const hasDenied = blocks.some(
    (block) => block.type === "tool_call" && block.status === "denied",
  );
  const toolCount = blocks.filter((block) => block.type === "tool_call").length;

  useEffect(() => {
    if (pending.length > 0) setOpen(true);
  }, [pending.length]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const measured = blocks.reduce((sum, block) => {
    if (block.type === "thinking") return sum + (block.durationMs ?? 0);
    return sum + (block.durationMs ?? 0);
  }, 0);
  const elapsed = running ? Math.max(measured, Date.now() - startedAt.current) : measured;
  const last = blocks[blocks.length - 1];
  const action = currentAction(last);
  const waiting = pending.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="my-1.5"
    >
      <button
        onClick={() => setOpen((value) => !value)}
        className="group -ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-[8px] px-1.5 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
      >
        <span className="flex h-4 w-4 items-center justify-center">
          {running ? (
            <Loader2 size={11} strokeWidth={1.6} className="animate-spin text-[var(--text-muted)]" />
          ) : hasError ? (
            <AlertCircle size={11} strokeWidth={1.6} className="text-[var(--status-err)]" />
          ) : hasDenied ? (
            <X size={11} strokeWidth={1.7} className="text-[var(--status-warn)]" />
          ) : waiting ? (
            <ShieldAlert size={11} strokeWidth={1.6} className="text-[var(--status-warn)]" />
          ) : (
            <Sparkles size={12} strokeWidth={1.5} />
          )}
        </span>
        <span className={`truncate ${running ? "thinking-shimmer" : ""}`}>
          {waiting
            ? "Waiting for approval"
            : running
              ? action
              : elapsed >= 1000
                ? `Worked for ${durationLabel(elapsed)}`
                : `Worked`}
        </span>
        {!running && toolCount > 0 && (
          <span className="shrink-0 text-[var(--text-muted)]">
            · {toolCount} {toolCount === 1 ? "step" : "steps"}
          </span>
        )}
        {hasError && <span className="text-[11.5px] text-[var(--status-err)]">· error</span>}
        {hasDenied && <span className="text-[11.5px] text-[var(--status-warn)]">· denied</span>}
        {running && elapsed > 3000 && (
          <span className="text-meta text-[var(--text-muted)]">{durationLabel(elapsed)}</span>
        )}
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={`text-[var(--text-muted)] transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
            className="overflow-hidden"
          >
            <div className="ml-[1px] border-l border-[var(--border-focus)] py-1 pl-4 [border-left-color:var(--border-hairline)]">
              {blocks.map((block, index) => (
                <motion.div
                  key={block.id}
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index, 8) * 0.018, duration: 0.16 }}
                >
                  {block.type === "thinking" ? (
                    <div className="my-1">
                      <div className="flex h-5 items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
                        <Sparkles size={10} strokeWidth={1.5} />
                        <span>
                          {!block.isComplete
                            ? "Thinking"
                            : block.durationMs
                              ? `Thought for ${durationLabel(block.durationMs)}`
                              : "Thought"}
                        </span>
                      </div>
                      <p className="selectable font-prose whitespace-pre-wrap pb-1 text-[13.5px] leading-[1.65] text-[var(--text-secondary)]">
                        {block.thinking}
                      </p>
                    </div>
                  ) : (
                    <ToolStepPill block={block} compact />
                  )}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
