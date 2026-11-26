import { CornerDownRight } from "lucide-react";
import type { ElicitationsGroup } from "../../../shared/citations";

interface FollowUpsRowProps {
  group: ElicitationsGroup;
  onSelect: (query: string) => void;
}

/**
 * Minimal follow-up prompt suggestions parsed from `<ElicitationsGroup>`.
 * Clicking an item sends its `query` directly into the current thread.
 */
export function FollowUpsRow({ group, onSelect }: FollowUpsRowProps) {
  if (group.items.length === 0) return null;

  return (
    <div className="mt-3 pt-2.5 border-t hairline">
      {group.message && (
        <p className="mb-1.5 text-[11.5px] text-[var(--text-muted)]">
          {group.message}
        </p>
      )}
      <div className="flex flex-col items-start gap-1">
        {group.items.map((item) => (
          <button
            key={`${item.label}:${item.query}`}
            type="button"
            title={item.query}
            onClick={() => onSelect(item.query)}
            className="group inline-flex max-w-full items-center gap-1.5 rounded-[8px] px-2 py-1 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] active:scale-[0.995]"
          >
            <CornerDownRight
              size={11}
              strokeWidth={1.5}
              className="shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--text-primary)]"
            />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
