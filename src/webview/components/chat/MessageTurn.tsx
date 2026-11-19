import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Copy, FileText, Pencil, RotateCcw } from "lucide-react";
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
  /** Present when the message can be edited (the thread is idle). */
  onEdit?: (turnId: string, text: string) => void;
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
  onEdit,
}: MessageTurnProps) {
  const segments = useMemo(() => groupBlocks(turn), [turn]);

  if (turn.role === "user") {
    return <UserMessage turn={turn} onEdit={onEdit} />;
  }

  const streaming = running && isLast;
  const lastTextBlock = [...turn.blocks].reverse().find((block) => block.type === "text");
  const textBlocks = turn.blocks.filter((block): block is TextBlock => block.type === "text");
  const workSegments = segments.filter((segment) => segment.kind === "work").length;

  return (
    <div className="group/turn my-5">
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
            <WorkLog
              blocks={segment.blocks}
              running={streaming}
              approvals={pending}
              durationMs={workSegments === 1 ? turn.durationMs : undefined}
            />
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

const actionClass =
  "flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]";

/**
 * A user message reads as a quoted prompt: a hairline rule on the left, no
 * bubble. Editing happens in place and reruns the thread from that point.
 */
function UserMessage({
  turn,
  onEdit,
}: {
  turn: ChatTurn;
  onEdit?: (turnId: string, text: string) => void;
}) {
  const text = turn.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!editing || !input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(320, input.scrollHeight)}px`;
  }, [editing, draft]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const submit = () => {
    const next = draft.trim();
    if (!next || !onEdit) return;
    setEditing(false);
    if (next !== text) onEdit(turn.id, next);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/user mb-3 mt-8 flex flex-col items-end first:mt-2">
      {turn.attachments?.length ? (
        <div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {turn.attachments.map((attachment) => (
            <span
              key={attachment.path}
              className="inline-flex h-[22px] items-center gap-1 rounded-[6px] bg-[var(--bg-subtle)] px-1.5 text-[11.5px] text-[var(--text-secondary)]"
            >
              <FileText size={11} strokeWidth={1.5} />
              {attachment.name}
            </span>
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className="w-full rounded-[12px] border border-[var(--border-focus)] bg-[var(--bg-elevated)] px-3.5 pb-2 pt-2.5 shadow-[var(--shadow-composer)]">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(text);
                setEditing(false);
              }
            }}
            rows={1}
            className="selectable font-prose thin-scroll w-full resize-none bg-transparent text-[15px] leading-[1.65] outline-none"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-[var(--text-muted)]">
              Reruns from here. File changes are not undone.
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  setDraft(text);
                  setEditing(false);
                }}
                className="h-7 rounded-[8px] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!draft.trim()}
                className="h-7 rounded-[8px] bg-[var(--accent-ink)] px-3 text-[12px] font-medium text-[var(--accent-ink-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="max-w-[85%] rounded-[14px] bg-[var(--bg-subtle)] px-3.5 py-2.5">
            <p className="selectable font-prose whitespace-pre-wrap break-words text-[15px] leading-[1.65] text-[var(--text-primary)]">
              {text}
            </p>
          </div>
          <div className="mt-1 flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 group-focus-within/user:opacity-100">
            {onEdit && (
              <button
                onClick={() => {
                  setDraft(text);
                  setEditing(true);
                }}
                className={actionClass}
                aria-label="Edit message"
              >
                <Pencil size={11} strokeWidth={1.5} />
                Edit
              </button>
            )}
            <button onClick={() => void copy()} className={actionClass} aria-label="Copy message">
              {copied ? <Check size={11} strokeWidth={1.7} /> : <Copy size={11} strokeWidth={1.5} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
