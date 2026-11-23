import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ThinkingBlock } from "../../../shared/types";

interface ThinkingTraceProps {
  block: ThinkingBlock;
  streaming: boolean;
}

export function ThinkingTrace({ block, streaming }: ThinkingTraceProps) {
  const [open, setOpen] = useState(false);
  const seconds = (block.durationMs ?? 0) / 1000;
  const label = !block.isComplete
    ? "Thinking"
    : block.durationMs === undefined || block.durationMs === 0
      ? "Thought"
      : `Thought for ${seconds.toFixed(1)}s`;

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="btn-ghost group -ml-1.5 h-[26px] gap-1.5 rounded-[7px] px-1.5 text-[12.5px] text-[var(--text-muted)]"
      >
        <Sparkles
          size={12}
          strokeWidth={1.5}
          className={streaming ? "pulse-dot" : ""}
        />
        <span className={streaming ? "thinking-shimmer" : ""}>{label}</span>
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}
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
            <div className="selectable mt-1.5 font-prose whitespace-pre-wrap border-l-[1.5px] border-[var(--border-hairline)] pl-3 text-[13.5px] leading-[1.65] text-[var(--text-secondary)]">
              {block.thinking}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
