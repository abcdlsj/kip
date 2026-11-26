import { useState } from "react";
import { ArrowUpRight, Globe } from "lucide-react";
import type { CitationSource } from "../../../shared/citations";

const INITIAL_VISIBLE = 4;

interface SourcesRowProps {
  sources: CitationSource[];
}

/**
 * Minimal citation strip shown quietly below grounded replies.
 * Keeps long source lists compact behind a subtle `+N` toggle.
 */
export function SourcesRow({ sources }: SourcesRowProps) {
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;

  const visible = expanded ? sources : sources.slice(0, INITIAL_VISIBLE);
  const hiddenCount = sources.length - visible.length;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {visible.map((source, index) => {
        const badge = source.id ?? index + 1;
        const label =
          source.title && source.title !== source.url
            ? source.title
            : source.domain;
        return (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            title={`${source.title} — ${source.domain}`}
            className="group inline-flex h-[22px] max-w-[220px] items-center gap-1.5 rounded-full border hairline bg-[var(--bg-subtle)] px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-focus)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
          >
            <Globe
              size={10}
              strokeWidth={1.5}
              className="shrink-0 text-[var(--text-muted)]"
            />
            <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
              {badge}
            </span>
            <span className="truncate">{label}</span>
            <ArrowUpRight
              size={10}
              strokeWidth={1.6}
              className="shrink-0 text-[var(--text-muted)] opacity-60 transition-opacity group-hover:opacity-100"
            />
          </a>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex h-[22px] items-center rounded-full border hairline px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
        >
          +{hiddenCount}
        </button>
      )}
    </div>
  );
}
