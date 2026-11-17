import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { TextBlock } from "../../../shared/types";

export function TurnActions({ blocks }: { blocks: TextBlock[] }) {
  const [copied, setCopied] = useState(false);
  const text = blocks.map((block) => block.text).join("\n\n").trim();
  if (!text) return null;

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
      <button
        onClick={() => void copy()}
        className="flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
        aria-label="Copy response"
      >
        {copied ? <Check size={11} strokeWidth={1.7} /> : <Copy size={11} strokeWidth={1.5} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
