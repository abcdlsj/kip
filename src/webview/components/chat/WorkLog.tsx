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
import { formatWorkDuration } from "../../../shared/duration";
import { activeLabel } from "../../lib/tool-label";
import { ThinkingTrace } from "./ThinkingTrace";
import { ToolStepPill } from "./ToolStepPill";

type WorkBlock = ThinkingBlock | ToolCallBlock;

interface WorkLogProps {
  blocks: WorkBlock[];
  running: boolean;
  approvals: ToolApprovalPayload[];
  /** Wall time of the whole run, when this log is the run's only work. */
  durationMs?: number;
}

function currentAction(block: WorkBlock | undefined): string {
  if (!block) return "Working";
  if (block.type === "thinking") return "Thinking";
  return activeLabel(block);
}

export function WorkLog({
  blocks,
  running,
  approvals,
  durationMs,
}: WorkLogProps) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const startedAt = useRef(Date.now());

  const pending = approvals.filter((item) =>
    blocks.some(
      (block) => block.type === "tool_call" && block.id === item.toolCallId,
    ),
  );
  const hasError = blocks.some(
    (block) => block.type === "tool_call" && block.status === "error",
  );
  const hasDenied = blocks.some(
    (block) => block.type === "tool_call" && block.status === "denied",
  );
  const toolCount = blocks.filter((block) => block.type === "tool_call").length;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const measured = blocks.reduce((sum, block) => {
    if (block.type === "thinking") return sum + (block.durationMs ?? 0);
    return sum + (block.durationMs ?? 0);
  }, 0);
  const elapsed = running
    ? Math.max(measured, Date.now() - startedAt.current)
    : Math.max(measured, durationMs ?? 0);
  const elapsedLabel = formatWorkDuration(elapsed);
  const last = blocks[blocks.length - 1];
  const action = currentAction(last);
  const waiting = pending.length > 0;

  // Auto-open the work log whenever an approval arrives so pending steps never hide inside the fold.
  useEffect(() => {
    if (waiting) setOpen(true);
  }, [waiting]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="my-1.5"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="btn-ghost group -ml-1.5 h-7 max-w-full justify-start gap-1.5 rounded-[8px] px-1.5 text-[13px]"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {waiting ? (
            <ShieldAlert
              size={12}
              strokeWidth={1.6}
              className="text-[var(--status-warn)]"
            />
          ) : running ? (
            <Loader2
              size={11}
              strokeWidth={1.6}
              className="animate-spin text-[var(--text-muted)]"
            />
          ) : hasError ? (
            <AlertCircle
              size={11}
              strokeWidth={1.6}
              className="text-[var(--status-err)]"
            />
          ) : hasDenied ? (
            <X
              size={11}
              strokeWidth={1.7}
              className="text-[var(--status-warn)]"
            />
          ) : (
            <Sparkles size={12} strokeWidth={1.5} />
          )}
        </span>
        <span
          className={`truncate ${
            waiting
              ? "font-medium text-[var(--status-warn)]"
              : running
                ? "thinking-shimmer"
                : ""
          }`}
        >
          {waiting
            ? "Waiting for approval"
            : running
              ? action
              : elapsedLabel
                ? `Worked for ${elapsedLabel}`
                : "Worked"}
        </span>
        {toolCount > 0 && (
          <span className="shrink-0 text-[var(--text-muted)]">
            · {toolCount} {toolCount === 1 ? "step" : "steps"}
          </span>
        )}
        {hasError && (
          <span className="shrink-0 text-[11.5px] text-[var(--status-err)]">
            · error
          </span>
        )}
        {hasDenied && (
          <span className="shrink-0 text-[11.5px] text-[var(--status-warn)]">
            · denied
          </span>
        )}
        {running && !waiting && elapsed > 3000 && elapsedLabel && (
          <span className="text-meta shrink-0 text-[var(--text-muted)]">
            {elapsedLabel}
          </span>
        )}
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={`shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${
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
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 34,
              mass: 0.8,
            }}
            className="overflow-hidden"
          >
            <div className="ml-[5px] border-l border-[var(--border-hairline)] py-1 pl-3.5">
              {blocks.map((block, index) => (
                <motion.div
                  key={block.id}
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    delay: Math.min(index, 8) * 0.018,
                    duration: 0.16,
                  }}
                >
                  {block.type === "thinking" ? (
                    <ThinkingTrace
                      block={block}
                      streaming={running && !block.isComplete}
                    />
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
