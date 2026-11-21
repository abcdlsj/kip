import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronDown,
  Copy,
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
import { copyText } from "../../lib/clipboard";
import { stepLabel } from "../../lib/tool-label";
import { DiffView } from "./DiffView";

interface ToolStepPillProps {
  block: ToolCallBlock;
  compact?: boolean;
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
  if (block.status === "denied") return null;
  return <X size={11} strokeWidth={1.7} className="text-[var(--status-err)]" />;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function ToolStepPill({ block, compact = false }: ToolStepPillProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasDetail = Boolean(block.output || block.diff);
  const label = stepLabel(block);
  const seconds =
    block.durationMs === undefined
      ? null
      : block.durationMs >= 1000
        ? `${(block.durationMs / 1000).toFixed(1)}s`
        : `${block.durationMs}ms`;

  const cleanOutput = block.output ? stripAnsi(block.output) : "";

  const copyOutput = async () => {
    const ok = await copyText(cleanOutput);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((value) => !value)}
        aria-expanded={hasDetail ? open : undefined}
        className={
          compact
            ? `flex h-7 w-full items-center gap-2 rounded-[6px] px-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors ${
                hasDetail ? "hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]" : "cursor-default"
              }`
            : `flex h-7 max-w-full items-center gap-2 rounded-[8px] border hairline bg-[var(--bg-subtle)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors ${
                hasDetail ? "hover:border-[var(--border-focus)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]" : "cursor-default"
              }`
        }
      >
        <span className="flex shrink-0 items-center text-[var(--text-muted)]">
          {iconFor(block.toolName, block.risk === "high-risk")}
        </span>
        <span className="truncate font-mono text-[12px]" title={label}>
          {label}
        </span>
        {block.risk === "high-risk" && (
          <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--status-err)_12%,transparent)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--status-err)]">
            Risky
          </span>
        )}
        {block.status === "awaiting_approval" && (
          <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--signal-attention)_16%,transparent)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--status-warn)]">
            Waiting
          </span>
        )}
        {block.status === "denied" && (
          <span className="shrink-0 rounded-full bg-[var(--bg-active)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--text-muted)]">
            Denied
          </span>
        )}
        {block.outsideWorkspace && (
          <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--status-warn)_14%,transparent)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--status-warn)]">
            Outside workspace
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[var(--text-muted)]">
          {seconds && <span className="text-meta text-[11px]">{seconds}</span>}
          {(!compact || block.status !== "completed") && statusIcon(block)}
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
            <div
              className={`group/out relative mt-1.5 overflow-hidden rounded-[10px] border border-[var(--code-border)] bg-[var(--bg-code-block)] ${
                compact ? "ml-1" : ""
              }`}
            >
              {!block.diff && cleanOutput && (
                <button
                  type="button"
                  onClick={() => void copyOutput()}
                  aria-label="Copy output"
                  title="Copy output"
                  className={`btn-icon absolute right-2 top-2 z-10 h-6 gap-1 rounded-[6px] bg-[var(--bg-code-block)] px-1.5 text-[11px] transition-opacity ${
                    copied ? "opacity-100 text-[var(--status-ok)]" : "opacity-0 group-hover/out:opacity-100"
                  }`}
                >
                  {copied ? <Check size={11} strokeWidth={1.7} /> : <Copy size={11} strokeWidth={1.5} />}
                  {copied ? "Copied" : ""}
                </button>
              )}
              <div className="thin-scroll max-h-72 overflow-auto">
                {block.diff ? (
                  <DiffView before={block.diff.before} after={block.diff.after} />
                ) : (
                  <pre className="selectable whitespace-pre-wrap p-3 font-mono text-[12px] leading-[1.6] text-[var(--text-secondary)]">
                    {cleanOutput}
                  </pre>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
