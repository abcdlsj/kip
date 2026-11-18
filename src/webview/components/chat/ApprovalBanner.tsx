import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ShieldAlert, ChevronDown } from "lucide-react";
import type { ToolApprovalPayload } from "../../../shared/types";
import { useChatStore } from "../../stores/chat-store";
import { DiffView } from "./DiffView";

interface ApprovalBannerProps {
  approval: ToolApprovalPayload;
  threadId: string;
}

export function ApprovalBanner({ approval, threadId }: ApprovalBannerProps) {
  const resolveApproval = useChatStore((state) => state.resolveApproval);
  const [remember, setRemember] = useState(false);
  const [preview, setPreview] = useState(false);
  const highRisk = approval.risk === "high-risk";

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
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
              {preview ? "Hide changes" : "Preview changes"}
            </button>
          )}
          <AnimatePresence initial={false}>
            {preview && approval.previewDiff && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
                className="overflow-hidden"
              >
                <div className="mt-2 max-h-56 overflow-auto rounded-[8px] border hairline">
                  <DiffView
                    before={approval.previewDiff.before}
                    after={approval.previewDiff.after}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="mt-3 flex items-center justify-between gap-3">
            <label
              className={`flex items-center gap-1.5 text-[12px] ${
                highRisk ? "cursor-not-allowed text-[var(--text-muted)]" : "text-[var(--text-secondary)]"
              }`}
            >
              <input
                type="checkbox"
                checked={remember}
                disabled={highRisk}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-3 w-3 accent-[var(--accent-ink)]"
              />
              Remember this command for the session
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void resolveApproval(threadId, approval.toolCallId, false, false)}
                className="h-7 rounded-[8px] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
              >
                Deny
              </button>
              <button
                onClick={() => void resolveApproval(threadId, approval.toolCallId, true, remember)}
                className="h-7 rounded-[8px] bg-[var(--accent-ink)] px-3 text-[12px] font-medium text-[var(--accent-ink-fg)] transition-opacity hover:opacity-90"
              >
                Allow{!highRisk && <span className="ml-1 text-[11.5px] opacity-70">⌘↵</span>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
