import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, Plus } from "lucide-react";
import type { Workspace } from "../../../shared/types";
import { SUGGESTIONS } from "../../../shared/constants";
import { greeting } from "../../lib/format";
import { submitPrompt } from "../../lib/send";
import { useChatStore } from "../../stores/chat-store";
import { NEW_THREAD_DRAFT, useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { MessageTurn } from "./MessageTurn";

interface ThreadCanvasProps {
  threadId: string | null;
  workspace: Workspace | null;
  onScrolled?: (scrolled: boolean) => void;
}

export function ThreadCanvas({ threadId, workspace, onScrolled }: ThreadCanvasProps) {
  const view = useChatStore((state) => (threadId ? state.threads[threadId] : undefined));
  const load = useChatStore((state) => state.load);
  const setDraft = useUiStore((state) => state.setDraft);
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
    if (smooth) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
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
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextPinned = distance <= 48;
    setPinned(nextPinned);
    setShowJump(!nextPinned && distance > 120);
    onScrolled?.(container.scrollTop > 8);
  };

  const retry = async (turnId: string) => {
    if (!threadId || !view) return;
    const index = view.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;
    const source = [...view.turns.slice(0, index)].reverse().find((turn) => turn.role === "user");
    if (!source) return;
    const text = source.blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (!text) return;
    await submitPrompt({ threadId, text });
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

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="thin-scroll h-full overflow-y-auto px-7 pt-[64px] pb-[180px]"
      >
        <div className="mx-auto w-full max-w-[740px]">
          {isEmpty ? (
            <div className="flex min-h-[46vh] flex-col justify-center pt-10">
              {needsProvider ? (
                <div className="max-w-[520px]">
                  <p className="text-meta text-[var(--text-muted)]">FIRST RUN</p>
                  <h1 className="title-large mt-3">Welcome to Kip.</h1>
                  <p className="mt-3 text-[15px] leading-[1.65] text-[var(--text-secondary)]">
                    Connect an OpenAI-compatible endpoint to begin. Kip keeps credentials in
                    your system keychain and never writes them to a database.
                  </p>
                  <button
                    onClick={() => openSettings("providers")}
                    className="mt-6 inline-flex h-9 items-center gap-2 rounded-full bg-[var(--accent-action)] px-4 text-[13px] font-medium text-[var(--accent-action-fg)] transition-opacity hover:opacity-90"
                  >
                    <Plus size={14} strokeWidth={1.5} />
                    Add a model provider
                  </button>
                </div>
              ) : (
                <div>
                  <h1 className="title-large">{greeting()}</h1>
                  <p className="mt-2 text-[15px] text-[var(--text-secondary)]">
                    Ready in{" "}
                    <span className="font-[var(--font-mono)] text-[13px]">
                      {workspace?.rootPath ?? "~/.kip/scratchpad"}
                    </span>
                  </p>
                  <div className="mt-8 flex flex-wrap gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => void startSuggestion(suggestion)}
                        className="h-8 rounded-full border hairline px-3.5 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      setDraft(NEW_THREAD_DRAFT, "");
                      void newThread();
                    }}
                    className="mt-6 text-[12px] text-[var(--text-muted)] underline decoration-[var(--border-focus)] underline-offset-4 hover:text-[var(--text-secondary)]"
                  >
                    or begin with a blank thread
                  </button>
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
                />
              ))}
              {view?.running &&
                !view.turns[view.turns.length - 1]?.blocks.some(
                  (block) => block.type !== "text",
                ) && (
                  <div className="mt-3 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-secondary)] pulse-dot" />
                    <span>Kip is thinking</span>
                  </div>
                )}
            </>
          )}
        </div>
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
            onClick={() => {
              setPinned(true);
              scrollToBottom(true);
            }}
            className="absolute bottom-[168px] left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border hairline bg-[color-mix(in_srgb,var(--bg-elevated)_88%,transparent)] px-3 text-[12px] font-medium text-[var(--text-secondary)] shadow-[var(--shadow-composer)] backdrop-blur-md"
          >
            <ArrowDown size={12} strokeWidth={1.5} />
            Jump to latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
