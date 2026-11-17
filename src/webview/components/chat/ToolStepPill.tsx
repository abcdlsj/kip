import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronDown,
  FilePenLine,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  ShieldAlert,
  Terminal,
  X,
} from "lucide-react";
import type { ToolCallBlock } from "../../../shared/types";
import { DiffView } from "./DiffView";

interface ToolStepPillProps {
  block: ToolCallBlock;
}

function iconFor(toolName: string, highRisk: boolean) {
  if (highRisk) return <ShieldAlert size={13} strokeWidth={1.5} className="text-[var(--status-err)]" />;
  switch (toolName) {
    case "bash":
      return <Terminal size={13} strokeWidth={1.5} />;
    case "edit":
    case "write":
      return <FilePenLine size={13} strokeWidth={1.5} />;
    case "grep":
    case "find":
      return <Search size={13} strokeWidth={1.5} />;
    case "ls":
      return <FolderOpen size={13} strokeWidth={1.5} />;
    default:
      return <FileText size={13} strokeWidth={1.5} />;
  }
}

function statusIcon(block: ToolCallBlock) {
  if (block.status === "running") {
    return <Loader2 size={11} strokeWidth={1.5} className="animate-spin text-[var(--text-muted)]" />;
  }
  if (block.status === "awaiting_approval") {
    return <ShieldAlert size={11} strokeWidth={1.5} className="text-[var(--status-warn)]" />;
  }
  if (block.status === "completed") {
    return <Check size={11} strokeWidth={1.7} className="text-[var(--status-ok)]" />;
  }
  return <X size={11} strokeWidth={1.7} className="text-[var(--status-err)]" />;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function ToolStepPill({ block }: ToolStepPillProps) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(block.output || block.diff);
  const seconds =
    block.durationMs === undefined
      ? null
      : block.durationMs >= 1000
        ? `${(block.durationMs / 1000).toFixed(1)}s`
        : `${block.durationMs}ms`;

  return (
    <div className="my-2">
      <button
        onClick={() => hasDetail && setOpen((value) => !value)}
        className="flex h-7 max-w-full items-center gap-2 rounded-full border hairline px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
      >
        <span className="flex items-center">{iconFor(block.toolName, block.risk === "high-risk")}</span>
        <span className="truncate font-[var(--font-mono)] text-[11.5px]">{block.summaryLabel}</span>
        {block.risk === "high-risk" && (
          <span className="rounded-full bg-[color-mix(in_srgb,var(--status-err)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-err)]">
            Risky
          </span>
        )}
        {block.outsideWorkspace && (
          <span className="rounded-full bg-[color-mix(in_srgb,var(--status-warn)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-warn)]">
            Outside workspace
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 pl-2 text-[var(--text-muted)]">
          {seconds && <span className="text-meta">{seconds}</span>}
          {statusIcon(block)}
          {hasDetail && (
            <ChevronDown
              size={12}
              strokeWidth={1.5}
              className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
            className="overflow-hidden"
          >
            <div className="mt-2 max-h-72 overflow-auto rounded-[10px] border hairline bg-[var(--bg-code)]">
              {block.diff ? (
                <DiffView before={block.diff.before} after={block.diff.after} />
              ) : (
                <pre className="selectable whitespace-pre-wrap p-3 font-[var(--font-mono)] text-[12px] leading-[1.6] text-[var(--text-secondary)]">
                  {stripAnsi(block.output ?? "")}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
