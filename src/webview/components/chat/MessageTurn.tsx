import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  Pencil,
  RotateCcw,
} from "lucide-react";
import {
  mergeCitations,
  parseReplyContent,
  type ParsedReply,
} from "../../../shared/citations";
import type {
  ChatTurn,
  TextBlock,
  ThinkingBlock,
  ToolApprovalPayload,
  ToolCallBlock,
} from "../../../shared/types";
import { copyText } from "../../lib/clipboard";
import { ApprovalBanner } from "./ApprovalBanner";
import { FollowUpsRow } from "./FollowUpsRow";
import { Markdown } from "./Markdown";
import { SourcesRow } from "./SourcesRow";
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
  /** Sends a suggested follow-up query when the user clicks an elicitation item. */
  onFollowUp?: (query: string) => void;
}

function groupBlocks(turn: ChatTurn): Segment[] {
  const segments: Segment[] = [];
  let work: WorkBlock[] = [];
  const flush = () => {
    if (work.length === 0) return;
    const first = work[0];
    if (first)
      segments.push({ kind: "work", key: `work_${first.id}`, blocks: work });
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
  onFollowUp,
}: MessageTurnProps) {
  const segments = useMemo(() => groupBlocks(turn), [turn]);

  if (turn.role === "user") {
    return <UserMessage turn={turn} onEdit={onEdit} />;
  }

  const streaming = running && isLast;
  const lastTextBlock = [...turn.blocks]
    .reverse()
    .find((block) => block.type === "text");
  const textBlocks = turn.blocks.filter(
    (block): block is TextBlock => block.type === "text",
  );
  const parsedByBlock = useMemo(() => {
    const map = new Map<string, ParsedReply>();
    for (const block of textBlocks) {
      map.set(block.id, parseReplyContent(block.text));
    }
    return map;
  }, [textBlocks]);
  const cleanTextBlocks = useMemo(
    () =>
      textBlocks.map((block) => ({
        ...block,
        text: parsedByBlock.get(block.id)?.body ?? block.text,
      })),
    [textBlocks, parsedByBlock],
  );
  const sources = useMemo(
    () =>
      mergeCitations(
        textBlocks.map((block) => parsedByBlock.get(block.id)?.sources ?? []),
      ),
    [textBlocks, parsedByBlock],
  );
  const elicitations = useMemo(() => {
    for (let i = textBlocks.length - 1; i >= 0; i -= 1) {
      const group = parsedByBlock.get(textBlocks[i]!.id)?.elicitations;
      if (group && group.items.length > 0) return group;
    }
    return null;
  }, [textBlocks, parsedByBlock]);
  const workSegments = segments.filter(
    (segment) => segment.kind === "work",
  ).length;

  return (
    <div className="group/turn my-5">
      {segments.map((segment) => {
        if (segment.kind === "text") {
          const isStreamingBlock =
            streaming && segment.block.id === lastTextBlock?.id;
          const body =
            parsedByBlock.get(segment.block.id)?.body ?? segment.block.text;
          return (
            <div
              key={segment.block.id}
              className={isStreamingBlock ? "caret" : ""}
            >
              <Markdown streaming={isStreamingBlock}>{body}</Markdown>
            </div>
          );
        }

        const pending = approvals.filter((approval) =>
          segment.blocks.some(
            (block) =>
              block.type === "tool_call" && block.id === approval.toolCallId,
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
        <div className="my-3 flex items-start justify-between gap-3 rounded-[10px] border border-[color-mix(in_srgb,var(--status-err)_28%,transparent)] bg-[color-mix(in_srgb,var(--status-err)_6%,transparent)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-err)]">
          <div className="flex min-w-0 items-start gap-2">
            <AlertCircle
              size={14}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0"
            />
            <span className="selectable break-words leading-[1.5]">
              {turn.error}
            </span>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(turn.id)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border border-[color-mix(in_srgb,var(--status-err)_35%,transparent)] px-2 text-[11.5px] font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--status-err)_10%,transparent)] active:scale-[0.98]"
            >
              <RotateCcw size={11} strokeWidth={1.5} />
              Retry
            </button>
          )}
        </div>
      )}
      {sources.length > 0 && <SourcesRow sources={sources} />}
      {!streaming && <TurnActions blocks={cleanTextBlocks} />}
      {isLast && !streaming && elicitations && onFollowUp && (
        <FollowUpsRow group={elicitations} onSelect={onFollowUp} />
      )}
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
    const ok = await copyText(text);
    if (!ok) return;
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
                type="button"
                onClick={() => {
                  setDraft(text);
                  setEditing(false);
                }}
                className="btn-ghost h-7 rounded-[8px] px-2.5 text-[12px] font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!draft.trim()}
                className="btn-primary h-7 rounded-[8px] px-3 text-[12px]"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="max-w-[85%] rounded-[16px] bg-[var(--bg-user)] px-4 py-2.5">
            <p className="selectable font-prose whitespace-pre-wrap break-words text-[15px] leading-[1.65] text-[var(--text-primary)]">
              {text}
            </p>
          </div>
          <div className="mt-1 flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 group-focus-within/user:opacity-100">
            {onEdit && (
              <button
                type="button"
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
            <button
              type="button"
              onClick={() => void copy()}
              className={actionClass}
              aria-label="Copy message"
            >
              {copied ? (
                <Check
                  size={11}
                  strokeWidth={1.7}
                  className="text-[var(--status-ok)]"
                />
              ) : (
                <Copy size={11} strokeWidth={1.5} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
