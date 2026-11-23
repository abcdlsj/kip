import { useMemo, useState } from "react";
import { diffLines } from "diff";

interface DiffRow {
  kind: "add" | "remove" | "context";
  oldNumber: string;
  newNumber: string;
  line: string;
}

type DiffChunk =
  | { kind: "rows"; id: string; rows: DiffRow[] }
  | { kind: "fold"; id: string; rows: DiffRow[] };

const CONTEXT_KEEP = 3;
const MIN_FOLD_LINES = 8;

function buildChunks(before: string, after: string): DiffChunk[] {
  const parts = diffLines(before, after);
  let oldLine = 1;
  let newLine = 1;
  const allRows: DiffRow[] = [];

  for (const part of parts) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      const kind = part.added ? "add" : part.removed ? "remove" : "context";
      allRows.push({
        kind,
        oldNumber: kind === "add" ? "" : String(oldLine++),
        newNumber: kind === "remove" ? "" : String(newLine++),
        line,
      });
    }
  }

  // Collapse long unchanged runs while preserving `CONTEXT_KEEP` lines around each change.
  const chunks: DiffChunk[] = [];
  let cursor = 0;
  while (cursor < allRows.length) {
    if (allRows[cursor]!.kind !== "context") {
      const start = cursor;
      while (cursor < allRows.length && allRows[cursor]!.kind !== "context")
        cursor += 1;
      chunks.push({
        kind: "rows",
        id: `chg_${start}`,
        rows: allRows.slice(start, cursor),
      });
      continue;
    }
    const start = cursor;
    while (cursor < allRows.length && allRows[cursor]!.kind === "context")
      cursor += 1;
    const run = allRows.slice(start, cursor);
    const isLeading = start === 0;
    const isTrailing = cursor === allRows.length;
    const keepTop = isLeading ? 0 : CONTEXT_KEEP;
    const keepBottom = isTrailing ? 0 : CONTEXT_KEEP;
    const foldable = run.length - keepTop - keepBottom;

    if (foldable >= MIN_FOLD_LINES) {
      if (keepTop > 0) {
        chunks.push({
          kind: "rows",
          id: `ctx_t_${start}`,
          rows: run.slice(0, keepTop),
        });
      }
      chunks.push({
        kind: "fold",
        id: `fold_${start}`,
        rows: run.slice(keepTop, run.length - keepBottom),
      });
      if (keepBottom > 0) {
        chunks.push({
          kind: "rows",
          id: `ctx_b_${start}`,
          rows: run.slice(run.length - keepBottom),
        });
      }
    } else {
      chunks.push({ kind: "rows", id: `ctx_${start}`, rows: run });
    }
  }

  return chunks;
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const chunks = useMemo(() => buildChunks(before, after), [before, after]);
  const [expanded, setExpanded] = useState<Record<string, true>>({});

  return (
    <div className="selectable min-w-max py-1.5 font-mono text-[12px] leading-[1.6] tabular-nums">
      {chunks.map((chunk) => {
        if (chunk.kind === "fold" && !expanded[chunk.id]) {
          return (
            <button
              key={chunk.id}
              type="button"
              onClick={() =>
                setExpanded((state) => ({ ...state, [chunk.id]: true }))
              }
              className="flex w-full items-center gap-2 border-y border-[var(--code-border)] bg-[var(--bg-subtle)] px-3 py-1 text-left font-sans text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-active)] hover:text-[var(--text-secondary)]"
            >
              <span>···</span>
              <span>Show {chunk.rows.length} unchanged lines</span>
            </button>
          );
        }
        return chunk.rows.map((row, index) => (
          <div
            key={`${chunk.id}-${index}`}
            className={
              row.kind === "add"
                ? "flex bg-[color-mix(in_srgb,var(--status-ok)_10%,transparent)]"
                : row.kind === "remove"
                  ? "flex bg-[color-mix(in_srgb,var(--status-err)_9%,transparent)]"
                  : "flex"
            }
          >
            <span className="w-10 shrink-0 select-none pr-1.5 text-right text-[11px] text-[var(--text-muted)] opacity-75">
              {row.oldNumber}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-[var(--code-border)] pr-2 text-right text-[11px] text-[var(--text-muted)] opacity-75">
              {row.newNumber}
            </span>
            <span
              className={
                row.kind === "add"
                  ? "w-5 shrink-0 select-none text-center text-[var(--status-ok)]"
                  : row.kind === "remove"
                    ? "w-5 shrink-0 select-none text-center text-[var(--status-err)]"
                    : "w-5 shrink-0 select-none text-center text-[var(--text-muted)]"
              }
            >
              {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
            </span>
            <span className="whitespace-pre pr-4">{row.line || " "}</span>
          </div>
        ));
      })}
    </div>
  );
}
