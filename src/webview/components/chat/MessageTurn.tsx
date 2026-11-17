import { memo } from "react";
import { AlertCircle, FileText, RotateCcw } from "lucide-react";
import type { ChatTurn, ToolApprovalPayload } from "../../../shared/types";
import { ApprovalBanner } from "./ApprovalBanner";
import { Markdown } from "./Markdown";
import { ThinkingTrace } from "./ThinkingTrace";
import { ToolStepPill } from "./ToolStepPill";

interface MessageTurnProps {
  turn: ChatTurn;
  threadId: string;
  approvals: ToolApprovalPayload[];
  running: boolean;
  isLast: boolean;
  onRetry?: (turnId: string) => void;
}

function MessageTurnInner({
  turn,
  threadId,
  approvals,
  running,
  isLast,
  onRetry,
}: MessageTurnProps) {
  if (turn.role === "user") {
    const text = turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    return (
      <div className="my-5 flex justify-start">
        <div className="max-w-[82%] rounded-[16px] bg-[var(--bg-subtle)] px-4 py-2.5">
          {turn.attachments?.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {turn.attachments.map((attachment) => (
                <span
                  key={attachment.path}
                  className="inline-flex h-[22px] items-center gap-1 rounded-[6px] border hairline px-1.5 text-[11px] text-[var(--text-secondary)]"
                >
                  <FileText size={11} strokeWidth={1.5} />
                  {attachment.name}
                </span>
              ))}
            </div>
          ) : null}
          <p className="selectable whitespace-pre-wrap text-[15px] leading-[1.6]">{text}</p>
        </div>
      </div>
    );
  }

  const streaming = running && isLast;
  const lastTextBlock = [...turn.blocks].reverse().find((block) => block.type === "text");

  return (
    <div className="my-4">
      {turn.blocks.map((block) => {
        if (block.type === "thinking") {
          return (
            <ThinkingTrace key={block.id} block={block} streaming={streaming && !block.isComplete} />
          );
        }
        if (block.type === "text") {
          const isStreamingBlock = streaming && block.id === lastTextBlock?.id;
          return (
            <div key={block.id} className={isStreamingBlock ? "caret" : ""}>
              <Markdown streaming={isStreamingBlock}>{block.text}</Markdown>
            </div>
          );
        }
        const pending = approvals.find((item) => item.toolCallId === block.id);
        return (
          <div key={block.id}>
            <ToolStepPill block={block} />
            {pending && <ApprovalBanner approval={pending} threadId={threadId} />}
          </div>
        );
      })}
      {turn.error && (
        <div className="my-3 flex items-center gap-2 text-[12px] text-[var(--status-err)]">
          <AlertCircle size={13} strokeWidth={1.5} />
          <span className="selectable">{turn.error}</span>
          {onRetry && (
            <button
              onClick={() => onRetry?.(turn.id)}
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--status-err)_30%,transparent)] px-2 py-0.5 text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--status-err)_8%,transparent)]"
            >
              <RotateCcw size={10} strokeWidth={1.5} />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const MessageTurn = memo(MessageTurnInner);
