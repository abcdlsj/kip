import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Undo2 } from "lucide-react";
import type { RunChanges } from "../../../shared/types";
import { useChatStore } from "../../stores/chat-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

const STATUS_MARK: Record<string, { mark: string; color: string }> = {
  added: { mark: "A", color: "var(--status-ok)" },
  modified: { mark: "M", color: "var(--text-muted)" },
  deleted: { mark: "D", color: "var(--status-err)" },
};

/**
 * Files the last run changed, shown in the top bar. Click for the list and a
 * one-step undo. Only Git workspaces produce changes.
 */
export function ChangesChip({
  threadId,
  changes,
  running,
}: {
  threadId: string;
  changes: RunChanges;
  running: boolean;
}) {
  const undo = useChatStore((state) => state.undoChanges);
  const refreshWorkspaces = useWorkspaceStore(
    (state) => state.refreshWorkspaces,
  );
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = changes.files.length;

  useEffect(() => {
    if (!open) {
      setArmed(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const runUndo = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const failure = await undo(threadId);
      if (failure) setError(failure);
      else setOpen(false);
      void refreshWorkspaces();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="btn-ghost h-6 gap-1.5 rounded-[7px] px-2 text-[11.5px] text-[var(--text-muted)] data-[state=open]:bg-[var(--bg-subtle)]"
          title="Changes from the last turn"
        >
          <span className="text-meta">
            {count} {count === 1 ? "file" : "files"}
          </span>
          <span className="text-meta text-[var(--status-ok)]">
            +{changes.added}
          </span>
          <span className="text-meta text-[var(--status-err)]">
            −{changes.removed}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="popover-surface z-50 w-[308px] overflow-hidden rounded-[12px] border hairline bg-[var(--bg-elevated)] shadow-[var(--shadow-modal)] outline-none"
        >
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)]">
            Last turn
          </p>
          <div className="thin-scroll max-h-[260px] overflow-y-auto px-1 pb-1">
            {changes.files.map((file) => {
              const status = STATUS_MARK[file.status] ?? STATUS_MARK.modified!;
              const normalized = file.path.replaceAll("\\", "/");
              return (
                <div
                  key={file.path}
                  className="flex h-7 items-center gap-2 rounded-[6px] px-2 text-[12px] hover:bg-[var(--bg-subtle)]"
                  title={normalized}
                >
                  <span
                    className="w-2.5 shrink-0 font-mono text-[10.5px] font-semibold"
                    style={{ color: status.color }}
                  >
                    {status.mark}
                  </span>
                  <span className="flex min-w-0 flex-1 font-mono text-[11.5px]">
                    {normalized.includes("/") && (
                      <span className="min-w-0 truncate text-[var(--text-muted)]">
                        {normalized.slice(0, normalized.lastIndexOf("/") + 1)}
                      </span>
                    )}
                    <span className="shrink-0 text-[var(--text-secondary)]">
                      {normalized.slice(normalized.lastIndexOf("/") + 1)}
                    </span>
                  </span>
                  <span className="text-meta shrink-0 text-[11px] text-[var(--status-ok)]">
                    {file.added ? `+${file.added}` : ""}
                  </span>
                  <span className="text-meta w-7 shrink-0 text-right text-[11px] text-[var(--status-err)]">
                    {file.removed ? `−${file.removed}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
          {error && (
            <p className="selectable border-t hairline px-3 py-2 text-[11.5px] leading-[1.45] text-[var(--status-err)]">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between border-t hairline px-2.5 py-1.5">
            <span className="text-[11px] text-[var(--text-muted)]">
              {running ? "Available when the run ends" : "Restores these files"}
            </span>
            <button
              type="button"
              onClick={() => void runUndo()}
              disabled={busy || running}
              className={`flex h-6 items-center gap-1 rounded-[6px] px-2 text-[12px] font-medium transition-colors disabled:opacity-40 ${
                armed
                  ? "bg-[color-mix(in_srgb,var(--status-err)_12%,transparent)] text-[var(--status-err)]"
                  : "btn-ghost"
              }`}
            >
              <Undo2 size={12} strokeWidth={1.5} />
              {armed ? "Confirm undo" : "Undo"}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
