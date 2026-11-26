import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUpRight, Plus } from "lucide-react";
import type { Workspace } from "../../../shared/types";
import { SUGGESTIONS } from "../../../shared/constants";
import { compactHomePath, greeting } from "../../lib/format";
import { modShortcut } from "../../lib/platform";
import { submitPrompt } from "../../lib/send";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { MessageTurn } from "./MessageTurn";

interface ThreadCanvasProps {
  threadId: string | null;
  workspace: Workspace | null;
  onScrolled?: (scrolled: boolean) => void;
}

export function ThreadCanvas({
  threadId,
  workspace,
  onScrolled,
}: ThreadCanvasProps) {
  const view = useChatStore((state) =>
    threadId ? state.threads[threadId] : undefined,
  );
  const load = useChatStore((state) => state.load);
  const openSettings = useUiStore((state) => state.openSettings);
  const providers = useUiStore((state) => state.providers);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const newThread = useWorkspaceStore((state) => state.newThread);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const approvalCount = view?.approvals.length ?? 0;
  const previousApprovals = useRef(0);

  useEffect(() => {
    if (!threadId) return;
    if (view?.loaded) return;
    void load(threadId);
  }, [threadId, view?.loaded, load]);

  const scrollToBottom = useCallback((smooth = false) => {
    const container = scrollRef.current;
    if (!container) return;
    if (smooth)
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    else container.scrollTop = container.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (pinned && view?.loaded) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [view?.turns, view?.running, view?.loaded, pinned, scrollToBottom]);

  useLayoutEffect(() => {
    if (approvalCount > previousApprovals.current) {
      setPinned(true);
      requestAnimationFrame(() => scrollToBottom());
    }
    previousApprovals.current = approvalCount;
  }, [approvalCount, scrollToBottom]);

  useEffect(() => {
    if (threadId) setPinned(true);
  }, [threadId]);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distance =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextPinned = distance <= 48;
    setPinned(nextPinned);
    setShowJump(!nextPinned && distance > 120);
    onScrolled?.(container.scrollTop > 8);
  };

  const editTurn = useChatStore((state) => state.editUserTurn);

  /** Reruns the prompt in place instead of appending a duplicate message. */
  const retry = async (turnId: string) => {
    if (!threadId || !view) return;
    const index = view.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;
    const source = [...view.turns.slice(0, index)]
      .reverse()
      .find((turn) => turn.role === "user");
    if (!source) return;
    const text = source.blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (!text) return;
    await editTurn(threadId, source.id, text);
  };

  const edit = (turnId: string, text: string) => {
    if (threadId) void editTurn(threadId, turnId, text);
  };

  const startSuggestion = async (suggestion: string) => {
    if (!workspace) return;
    let target = threadId;
    if (!target) {
      const thread = await newThread();
      target = thread?.id ?? null;
      if (target) selectThread(target);
    }
    if (!target) return;
    await submitPrompt({ threadId: target, text: suggestion });
    void refreshThreads();
  };

  const needsProvider = providers.length === 0;
  const isEmpty = !view || view.turns.length === 0;
  const displayPath = workspace
    ? compactHomePath(workspace.rootPath)
    : "~/.kip/scratchpad";

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="thin-scroll h-full overflow-y-auto px-7 pt-[64px] pb-[184px]"
      >
        <div className="mx-auto w-full max-w-[740px]">
          {isEmpty ? (
            <div className="flex min-h-[46vh] flex-col justify-center pt-10">
              {needsProvider ? (
                <div className="max-w-[520px]">
                  <p className="text-meta text-[var(--text-muted)]">
                    FIRST RUN
                  </p>
                  <h1 className="title-large mt-3">Welcome to Kip.</h1>
                  <p className="mt-3 text-[15px] leading-[1.65] text-[var(--text-secondary)]">
                    Connect an OpenAI-compatible, Anthropic, or Google endpoint
                    to begin. Kip keeps credentials in your system keychain and
                    never writes them to a database.
                  </p>
                  <button
                    type="button"
                    onClick={() => openSettings("providers")}
                    className="btn-primary mt-6 h-9 rounded-[10px] px-4 text-[13px]"
                  >
                    <Plus size={14} strokeWidth={1.5} />
                    Add a model provider
                  </button>
                </div>
              ) : (
                <div>
                  <h1 className="title-large">{greeting()}</h1>
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[14px] text-[var(--text-muted)]">
                    <span>Ready in</span>
                    <span
                      title={workspace?.rootPath}
                      className="rounded-[6px] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--text-secondary)]"
                    >
                      {displayPath}
                    </span>
                  </p>
                  <div className="mt-7 flex flex-wrap gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion}
                        onClick={() => void startSuggestion(suggestion)}
                        className="group/sug inline-flex h-9 items-center gap-1.5 rounded-[10px] border hairline bg-[var(--bg-elevated)] px-3.5 text-[13px] text-[var(--text-secondary)] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-[var(--border-focus)] hover:text-[var(--text-primary)] active:scale-[0.98]"
                      >
                        <span>{suggestion}</span>
                        <ArrowUpRight
                          size={13}
                          strokeWidth={1.5}
                          className="text-[var(--text-muted)] opacity-60 transition-transform group-hover/sug:-translate-y-px group-hover/sug:translate-x-px group-hover/sug:opacity-100"
                        />
                      </button>
                    ))}
                  </div>
                  <p className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-muted)]">
                    <span className="inline-flex items-center gap-1">
                      <span className="kbd">@</span> reference files
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="kbd">/</span> commands
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="kbd">{modShortcut("K")}</span> palette
                    </span>
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
              {view?.turns.map((turn, index) => (
                <MessageTurn
                  key={turn.id}
                  turn={turn}
                  threadId={threadId ?? ""}
                  approvals={view.approvals}
                  running={view.running}
                  isLast={index === view.turns.length - 1}
                  onRetry={threadId ? retry : undefined}
                  onEdit={threadId && !view.running ? edit : undefined}
                  onFollowUp={
                    !view.running
                      ? (query) => void startSuggestion(query)
                      : undefined
                  }
                />
              ))}
              {view?.running &&
                !view.turns[view.turns.length - 1]?.blocks.some(
                  (block) => block.type !== "text",
                ) && (
                  <div className="mt-3 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-secondary)] pulse-dot" />
                    <span className="thinking-shimmer">Kip is thinking</span>
                  </div>
                )}
            </>
          )}
        </div>
      </div>

      {/* Soft paper fade so scrolled prose dissolves quietly behind the floating composer. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24"
        style={{
          background:
            "linear-gradient(to top, var(--bg-canvas) 35%, color-mix(in srgb, var(--bg-canvas) 0%, transparent))",
        }}
        aria-hidden="true"
      />

      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 34,
              mass: 0.8,
            }}
            onClick={() => {
              setPinned(true);
              scrollToBottom(true);
            }}
            className="btn-secondary absolute bottom-[136px] left-1/2 z-10 h-8 -translate-x-1/2 rounded-full bg-[color-mix(in_srgb,var(--bg-elevated)_90%,transparent)] px-3 text-[12px] shadow-[var(--shadow-composer)] backdrop-blur-md"
          >
            <ArrowDown size={12} strokeWidth={1.5} />
            Jump to latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
