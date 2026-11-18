import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ShieldAlert, ChevronDown } from "lucide-react";
import { diffLines } from "diff";
import type { ToolApprovalPayload } from "../../../shared/types";
import { useChatStore } from "../../stores/chat-store";
import { DiffView } from "./DiffView";

interface ApprovalBannerProps {
  approval: ToolApprovalPayload;
  threadId: string;
}

/** Diffs at or under this many changed lines open without a click. */
const AUTO_PREVIEW_LINES = 40;

const spring = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

function changedLines(diff: ToolApprovalPayload["previewDiff"]): number {
  if (!diff) return 0;
  let count = 0;
  for (const part of diffLines(diff.before, diff.after)) {
    if (part.added || part.removed) count += part.count ?? 0;
  }
  return count;
}

function rememberLabel(approval: ToolApprovalPayload): string {
  if (approval.toolName === "bash") return "Remember this command for the session";
  if (approval.toolName === "write" || approval.toolName === "edit") {
    return "Allow changes to this file for the session";
  }
  return "Remember for the session";
}

export function ApprovalBanner({ approval, threadId }: ApprovalBannerProps) {
  const resolveApproval = useChatStore((state) => state.resolveApproval);
  const highRisk = approval.risk === "high-risk";
  const changes = useMemo(() => changedLines(approval.previewDiff), [approval.previewDiff]);
  const [remember, setRemember] = useState(false);
  const [preview, setPreview] = useState(changes > 0 && changes <= AUTO_PREVIEW_LINES);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const canRemember = !highRisk && !approval.outsideWorkspace;

  const deny = () => void resolveApproval(threadId, approval.toolCallId, false, false, reason);
  const allow = () =>
    void resolveApproval(threadId, approval.toolCallId, true, canRemember && remember);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="my-3 rounded-[14px] border hairline bg-[var(--bg-elevated)] px-4 py-3.5 shadow-[var(--shadow-composer)]"
      style={highRisk ? { borderColor: "color-mix(in srgb, var(--status-err) 55%, transparent)" } : undefined}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert
          size={14}
          strokeWidth={1.5}
          className={highRisk ? "mt-0.5 text-[var(--status-err)]" : "mt-0.5 text-[var(--status-warn)]"}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[1.4]">
            {highRisk ? "This command can destroy data" : "Approval required"}
          </p>
          <p className="mt-0.5 text-[12px] leading-[1.5] text-[var(--text-muted)]">
            {approval.outsideWorkspace
              ? "This path is outside the selected workspace."
              : highRisk
                ? "Review carefully. This action cannot be remembered for the session."
                : "Kip pauses before changing files or running commands."}
          </p>
          <pre className="selectable thin-scroll mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--bg-code)] px-2.5 py-2 font-[var(--font-mono)] text-[12px] leading-[1.5] text-[var(--text-secondary)]">
            {approval.commandOrPath}
          </pre>
          {approval.previewDiff && (
            <button
              onClick={() => setPreview((value) => !value)}
              className="mt-2 flex items-center gap-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <ChevronDown
                size={12}
                strokeWidth={1.5}
                className={`transition-transform ${preview ? "rotate-180" : ""}`}
              />
              {preview ? "Hide changes" : `Preview changes · ${changes} ${changes === 1 ? "line" : "lines"}`}
            </button>
          )}
          <AnimatePresence initial={false}>
            {preview && approval.previewDiff && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={spring}
                className="overflow-hidden"
              >
                <div className="thin-scroll mt-2 max-h-64 overflow-auto rounded-[8px] border hairline bg-[var(--bg-code-block)]">
                  <DiffView
                    before={approval.previewDiff.before}
                    after={approval.previewDiff.after}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-3 flex min-h-7 items-center justify-between gap-3">
            {denying ? (
              <input
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    deny();
                  } else if (event.key === "Escape") {
                    // Esc closes the note; it must not stop the whole run.
                    event.preventDefault();
                    event.stopPropagation();
                    setDenying(false);
                    setReason("");
                  }
                }}
                placeholder="What should Kip do instead? (optional)"
                className="selectable font-prose h-7 min-w-0 flex-1 rounded-[8px] border hairline bg-[var(--bg-canvas)] px-2.5 text-[12.5px] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
              />
            ) : canRemember ? (
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  className="h-3 w-3 accent-[var(--accent-ink)]"
                />
                {rememberLabel(approval)}
              </label>
            ) : (
              <span />
            )}
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => {
                  if (denying) deny();
                  else setDenying(true);
                }}
                className="h-7 rounded-[8px] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
              >
                {denying ? "Deny ↵" : "Deny"}
              </button>
              {!denying && (
                <button
                  onClick={allow}
                  className="h-7 rounded-[8px] bg-[var(--accent-ink)] px-3 text-[12px] font-medium text-[var(--accent-ink-fg)] transition-opacity hover:opacity-90"
                >
                  Allow{!highRisk && <span className="ml-1 text-[11.5px] opacity-70">⌘↵</span>}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
