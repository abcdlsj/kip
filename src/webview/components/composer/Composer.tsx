import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  FileText,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import type { FileSuggestion } from "../../../shared/types";
import { MAX_ATTACHMENT_BYTES } from "../../../shared/constants";
import { submitPrompt } from "../../lib/send";
import { request } from "../../rpc-client";
import { useChatStore } from "../../stores/chat-store";
import { NEW_THREAD_DRAFT, useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ModelSelector } from "./ModelSelector";

interface PendingImage {
  name: string;
  mimeType: string;
  base64Data: string;
  previewUrl: string;
}

export function Composer() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const draftKey = activeThreadId ?? NEW_THREAD_DRAFT;
  const draft = useUiStore((state) => state.drafts[draftKey] ?? "");
  const storeDraft = useUiStore((state) => state.setDraft);
  const setDraft = (text: string) => storeDraft(draftKey, text);
  const newThread = useWorkspaceStore((state) => state.newThread);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const view = useChatStore((state) =>
    activeThreadId ? state.threads[activeThreadId] : undefined,
  );
  const abort = useChatStore((state) => state.abort);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);

  const running = view?.running ?? false;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(220, Math.max(52, textarea.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const match = /(?:^|\s)@([^\s@]*)$/.exec(draft);
    if (!match) {
      setSuggestions([]);
      return;
    }
    const query = match[1] ?? "";
    let cancelled = false;
    const timer = setTimeout(() => {
      void request("listWorkspaceFiles", { workspaceId: activeWorkspaceId, query })
        .then((files) => {
          if (cancelled) return;
          setSuggestions(files.slice(0, 8));
          setSelectedSuggestion(0);
        })
        .catch(() => setSuggestions([]));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, activeWorkspaceId]);

  useEffect(() => {
    return () => {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
    };
  }, [images]);

  const insertSuggestion = (suggestion: FileSuggestion) => {
    const next = draft.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
      const prefix = match.startsWith("@") ? "" : " ";
      return `${prefix}@${suggestion.path} `;
    });
    setDraft(next);
    setSuggestions([]);
    textareaRef.current?.focus();
  };

  const addFiles = async (files: FileList | File[]) => {
    const next: PendingImage[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/") || file.size > MAX_ATTACHMENT_BYTES) continue;
      const dataUrl = await readAsDataUrl(file);
      const base64Data = dataUrl.split(",")[1] ?? "";
      next.push({
        name: file.name || "pasted-image.png",
        mimeType: file.type,
        base64Data,
        previewUrl: URL.createObjectURL(file),
      });
    }
    if (next.length) setImages((current) => [...current, ...next].slice(0, 6));
  };

  const send = async () => {
    const text = draft.trim();
    if (running || !activeWorkspaceId) return;
    if (!text && images.length === 0) return;
    let threadId = activeThreadId;
    if (!threadId) {
      const thread = await newThread();
      threadId = thread?.id ?? null;
      if (threadId) selectThread(threadId);
    }
    if (!threadId) return;
    const referencedFiles = Array.from(text.matchAll(/(?:^|\s)@([^\s@]+)/g))
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value));
    setDraft("");
    const pending = images;
    setImages([]);
    await submitPrompt({
      threadId,
      text,
      referencedFiles,
      images: pending.map(({ name, mimeType, base64Data }) => ({ name, mimeType, base64Data })),
    });
    setTimeout(() => void refreshThreads(), 400);
  };

  const stop = async () => {
    if (activeThreadId) await abort(activeThreadId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestion((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestion((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const suggestion = suggestions[selectedSuggestion];
        if (suggestion) insertSuggestion(suggestion);
        return;
      }
      if (event.key === "Escape") {
        // Closing the file list must not reach the global Esc-to-stop handler.
        event.preventDefault();
        event.stopPropagation();
        setSuggestions([]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-6 pb-5">
      <div className="pointer-events-auto relative w-[min(740px,100%)]">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-[340px] overflow-hidden rounded-[10px] border hairline bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-modal)]">
            <p className="px-2 py-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-muted)]">
              Files
            </p>
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.path}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertSuggestion(suggestion);
                }}
                className={`flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left transition-colors ${
                  index === selectedSuggestion ? "bg-[var(--bg-subtle)]" : ""
                }`}
              >
                <FileText size={12} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
                <span className="truncate font-[var(--font-mono)] text-[11.5px] text-[var(--text-secondary)]">
                  {suggestion.path}
                </span>
              </button>
            ))}
          </div>
        )}
        <div
          className="rounded-[18px] border bg-[var(--bg-elevated)] px-3.5 pb-2.5 pt-3 shadow-[var(--shadow-composer)] transition-colors duration-150"
          style={{
            borderColor: focused ? "var(--border-focus)" : "var(--border-hairline)",
          }}
        >
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((image, index) => (
                <div key={`${image.name}-${index}`} className="relative">
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="h-14 w-14 rounded-[8px] border hairline object-cover"
                  />
                  <button
                    onClick={() =>
                      setImages((current) => {
                        URL.revokeObjectURL(image.previewUrl);
                        return current.filter((_, itemIndex) => itemIndex !== index);
                      })
                    }
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent-action)] text-[var(--accent-action-fg)]"
                    aria-label="Remove image"
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (files.length) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            rows={2}
            placeholder={
              activeWorkspaceId
                ? "Ask, @reference a file, or paste an image"
                : "Add a workspace to begin"
            }
            disabled={!activeWorkspaceId}
            className="selectable thin-scroll w-full resize-none bg-transparent text-[16px] leading-[1.55] placeholder:text-[var(--text-muted)] disabled:opacity-60"
            style={{ maxHeight: 220 }}
          />
          <div className="mt-1 flex h-8 items-center gap-1">
            <ModelSelector />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
              aria-label="Attach image"
            >
              <Paperclip size={14} strokeWidth={1.5} />
            </button>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-meta hidden text-[var(--text-muted)] sm:block">
                {running ? "Esc to stop" : "Enter to send"}
              </span>
              {running ? (
                <button
                  onClick={() => void stop()}
                  className="flex h-7 w-7 items-center justify-center rounded-[9px] border border-[var(--border-focus)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
                  aria-label="Stop"
                >
                  <Square size={10} strokeWidth={2} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={!activeWorkspaceId || (!draft.trim() && images.length === 0)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-action)] text-[var(--accent-action-fg)] transition-opacity disabled:opacity-30"
                  aria-label="Send"
                >
                  <ArrowUp size={15} strokeWidth={1.8} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
