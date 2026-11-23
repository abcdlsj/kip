import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { TextBlock } from "../../../shared/types";
import { copyText } from "../../lib/clipboard";

export function TurnActions({ blocks }: { blocks: TextBlock[] }) {
  const [copied, setCopied] = useState(false);
  const text = blocks
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  if (!text) return null;

  const copy = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-1.5 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100">
      <button
        type="button"
        onClick={() => void copy()}
        className="btn-ghost h-6 gap-1 rounded-[5px] px-1.5 text-[11.5px] text-[var(--text-muted)]"
        aria-label="Copy response"
      >
        {copied ? (
          <Check
            size={11}
            strokeWidth={1.7}
            className="text-[var(--status-ok)]"
          />
        ) : (
          <Copy size={11} strokeWidth={1.5} />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
