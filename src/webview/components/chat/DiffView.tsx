import { diffLines } from "diff";

export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  let oldLine = 1;
  let newLine = 1;
  return (
    <div className="selectable min-w-max py-2 font-[var(--font-mono)] text-[12px] leading-[1.55]">
      {parts.flatMap((part, partIndex) => {
        const lines = part.value.replace(/\n$/, "").split("\n");
        return lines.map((line, lineIndex) => {
          const kind = part.added ? "add" : part.removed ? "remove" : "context";
          const oldNumber = kind === "add" ? "" : String(oldLine++);
          const newNumber = kind === "remove" ? "" : String(newLine++);
          return (
            <div
              key={`${partIndex}-${lineIndex}`}
              className={
                kind === "add"
                  ? "flex bg-[color-mix(in_srgb,var(--status-ok)_9%,transparent)]"
                  : kind === "remove"
                    ? "flex bg-[color-mix(in_srgb,var(--status-err)_8%,transparent)]"
                    : "flex"
              }
            >
              <span className="w-10 shrink-0 select-none pr-1 text-right text-[10.5px] text-[var(--text-muted)]">
                {oldNumber}
              </span>
              <span className="w-10 shrink-0 select-none pr-2 text-right text-[10.5px] text-[var(--text-muted)]">
                {newNumber}
              </span>
              <span
                className={
                  kind === "add"
                    ? "w-4 shrink-0 text-[var(--status-ok)]"
                    : kind === "remove"
                      ? "w-4 shrink-0 text-[var(--status-err)]"
                      : "w-4 shrink-0 text-[var(--text-muted)]"
                }
              >
                {kind === "add" ? "+" : kind === "remove" ? "-" : " "}
              </span>
              <span className="whitespace-pre pr-4">{line || " "}</span>
            </div>
          );
        });
      })}
    </div>
  );
}
