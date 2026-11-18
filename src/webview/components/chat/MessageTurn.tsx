import { memo, useMemo } from "react";
import { AlertCircle, FileText, RotateCcw } from "lucide-react";
import type {
  ChatTurn,
  TextBlock,
  ThinkingBlock,
  ToolApprovalPayload,
  ToolCallBlock,
} from "../../../shared/types";
import { ApprovalBanner } from "./ApprovalBanner";
import { Markdown } from "./Markdown";
import { ThinkingTrace } from "./ThinkingTrace";
import { ToolStepPill } from "./ToolStepPill";
import { TurnActions } from "./TurnActions";
import { WorkLog } from "./WorkLog";

type WorkBlock = ThinkingBlock | ToolCallBlock;
type Segment =
  | { kind: "text"; block: TextBlock }
  | { kind: "work"; key: string; blocks: WorkBlock[] };

interface MessageTurnProps {
  turn: ChatTurn;
  threadId: string;
  approvals: ToolApprovalPayload[];
  running: boolean;
  isLast: boolean;
  onRetry?: (turnId: string) => void;
}

function groupBlocks(turn: ChatTurn): Segment[] {
  const segments: Segment[] = [];
  let work: WorkBlock[] = [];
  const flush = () => {
    if (work.length === 0) return;
    const first = work[0];
    if (first) segments.push({ kind: "work", key: `work_${first.id}`, blocks: work });
    work = [];
  };
  for (const block of turn.blocks) {
    if (block.type === "text") {
      flush();
      segments.push({ kind: "text", block });
    } else {
      work.push(block);
    }
  }
  flush();
  return segments;
}

function MessageTurnInner({
  turn,
  threadId,
  approvals,
  running,
  isLast,
  onRetry,
}: MessageTurnProps) {
  const segments = useMemo(() => groupBlocks(turn), [turn]);

  if (turn.role === "user") {
    const text = turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    return (
      <div className="my-5 flex justify-start">
        <div className="max-w-[82%] rounded-[16px] bg-[var(--bg-user)] px-4 py-3">
          {turn.attachments?.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {turn.attachments.map((attachment) => (
                <span
                  key={attachment.path}
                  className="inline-flex h-[22px] items-center gap-1 rounded-[6px] border hairline px-1.5 text-[11.5px] text-[var(--text-secondary)]"
                >
                  <FileText size={11} strokeWidth={1.5} />
                  {attachment.name}
                </span>
              ))}
            </div>
          ) : null}
          <p className="selectable font-prose whitespace-pre-wrap text-[15px] leading-[1.65]">{text}</p>
        </div>
      </div>
    );
  }

  const streaming = running && isLast;
  const lastTextBlock = [...turn.blocks].reverse().find((block) => block.type === "text");
  const textBlocks = turn.blocks.filter((block): block is TextBlock => block.type === "text");

  return (
    <div className="group/turn my-4">
      {segments.map((segment) => {
        if (segment.kind === "text") {
          const isStreamingBlock = streaming && segment.block.id === lastTextBlock?.id;
          return (
            <div key={segment.block.id} className={isStreamingBlock ? "caret" : ""}>
              <Markdown streaming={isStreamingBlock}>{segment.block.text}</Markdown>
            </div>
          );
        }

        const pending = approvals.filter((approval) =>
          segment.blocks.some(
            (block) => block.type === "tool_call" && block.id === approval.toolCallId,
          ),
        );

        if (segment.blocks.length === 1) {
          const only = segment.blocks[0];
          if (!only) return null;
          if (only.type === "thinking") {
            return (
              <ThinkingTrace
                key={segment.key}
                block={only}
                streaming={streaming && !only.isComplete}
              />
            );
          }
          return (
            <div key={segment.key}>
              <ToolStepPill block={only} />
              {pending.map((approval) => (
                <ApprovalBanner
                  key={approval.toolCallId}
                  approval={approval}
                  threadId={threadId}
                />
              ))}
            </div>
          );
        }

        return (
          <div key={segment.key}>
            <WorkLog blocks={segment.blocks} running={streaming} approvals={pending} />
            {pending.map((approval) => (
              <ApprovalBanner
                key={approval.toolCallId}
                approval={approval}
                threadId={threadId}
              />
            ))}
          </div>
        );
      })}
      {turn.error && (
        <div className="my-3 flex items-center gap-2 text-[12px] text-[var(--status-err)]">
          <AlertCircle size={13} strokeWidth={1.5} />
          <span className="selectable">{turn.error}</span>
          {onRetry && (
            <button
              onClick={() => onRetry(turn.id)}
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--status-err)_30%,transparent)] px-2 py-0.5 text-[11.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--status-err)_8%,transparent)]"
            >
              <RotateCcw size={10} strokeWidth={1.5} />
              Retry
            </button>
          )}
        </div>
      )}
      {!streaming && <TurnActions blocks={textBlocks} />}
    </div>
  );
}

export const MessageTurn = memo(MessageTurnInner);
