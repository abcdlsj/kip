import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  Terminal,
  Trash2,
} from "lucide-react";
import type { CliInstallStatus, CliTuiLayout } from "../../../shared/types";
import { copyText } from "../../lib/clipboard";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";

const TUI_LAYOUTS: Array<{
  id: CliTuiLayout;
  title: string;
  description: string;
}> = [
  {
    id: "inline",
    title: "Inline",
    description: "Flows naturally in terminal scrollback.",
  },
  {
    id: "fullscreen",
    title: "Fullscreen",
    description: "Pinned header, scrollable canvas, fixed composer.",
  },
];

const EXAMPLES: Array<{ cmd: string; note: string }> = [
  { cmd: "kip", note: "Open interactive TUI in the current folder" },
  { cmd: 'kip -p "explain this repo"', note: "Ask once and print the answer" },
  { cmd: "kip -c", note: "Continue the last thread in this folder" },
  { cmd: "kip --fullscreen", note: "Launch in fullscreen viewport mode" },
];

export function CliPanel() {
  const settings = useUiStore((state) => state.settings);
  const setCliTuiLayout = useUiStore((state) => state.setCliTuiLayout);
  const activeLayout: CliTuiLayout = settings?.cliTuiLayout ?? "inline";

  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [feedback, setFeedback] = useState<{
    text: string;
    tone: "ok" | "error" | "info";
  } | null>(null);
  const [copiedHint, setCopiedHint] = useState(false);

  const load = async () => {
    try {
      const next = await request("getCliStatus", undefined);
      setStatus(next);
    } catch (error) {
      setFeedback({
        text: error instanceof Error ? error.message : "Unable to inspect CLI.",
        tone: "error",
      });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleInstall = async () => {
    setBusy("install");
    setFeedback(null);
    try {
      const next = await request("installCli", undefined);
      setStatus(next);
      if (next.installed) {
        setFeedback({
          text: next.inPath
            ? `Installed \`kip\` at ${next.installPath}.`
            : `Installed at ${next.installPath}. Add it to your shell PATH below.`,
          tone: "ok",
        });
      } else {
        setFeedback({
          text: next.reason ?? "Could not install the CLI command.",
          tone: "error",
        });
      }
    } catch (error) {
      setFeedback({
        text:
          error instanceof Error
            ? error.message
            : "Could not install the CLI command.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async () => {
    setBusy("uninstall");
    setFeedback(null);
    try {
      const next = await request("uninstallCli", undefined);
      setStatus(next);
      setFeedback({ text: "Removed `kip` from PATH.", tone: "info" });
    } catch (error) {
      setFeedback({
        text:
          error instanceof Error
            ? error.message
            : "Could not remove the CLI command.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleCopyHint = async () => {
    if (!status?.pathHint) return;
    await copyText(status.pathHint);
    setCopiedHint(true);
    setTimeout(() => setCopiedHint(false), 1500);
  };

  return (
    <div>
      <h2 className="text-[15px] font-semibold">TUI</h2>
      <p className="mt-1 max-w-[460px] text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        Use Kip in your terminal — interactive TUI or one-shot CLI, sharing your
        providers, keys, and safety policy.
      </p>

      <div className="mt-4 rounded-[11px] border hairline bg-[var(--bg-subtle)] px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {!status ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]">
                <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                Checking PATH…
              </span>
            ) : status.installed ? (
              <div>
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                  <CheckCircle2
                    size={13}
                    strokeWidth={1.6}
                    className="shrink-0 text-[var(--status-ok)]"
                  />
                  <span>Installed</span>
                  {status.outdated && (
                    <span className="rounded-full bg-[var(--bg-active)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--status-warn)]">
                      Update available
                    </span>
                  )}
                </span>
                <p className="mt-1 truncate font-mono text-[11.5px] text-[var(--text-muted)]">
                  {status.installPath}
                </p>
              </div>
            ) : (
              <div>
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                  <Terminal
                    size={13}
                    strokeWidth={1.5}
                    className="shrink-0 text-[var(--text-muted)]"
                  />
                  <span>Not installed</span>
                </span>
                <p className="mt-1 truncate font-mono text-[11.5px] text-[var(--text-muted)]">
                  Will install to {status.targetPath}
                </p>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {status?.installed && (
              <button
                type="button"
                onClick={() => void handleUninstall()}
                disabled={busy !== null}
                className="btn-secondary h-7 rounded-[7px] bg-[var(--bg-elevated)] px-2.5 text-[11.5px]"
              >
                {busy === "uninstall" ? (
                  <Loader2
                    size={11}
                    strokeWidth={1.5}
                    className="animate-spin"
                  />
                ) : (
                  <Trash2 size={11} strokeWidth={1.5} />
                )}
                Uninstall
              </button>
            )}
            {(!status?.installed || status.outdated) && (
              <button
                type="button"
                onClick={() => void handleInstall()}
                disabled={busy !== null || !status?.available}
                className="btn-primary h-7 rounded-[7px] px-3 text-[12px]"
              >
                {busy === "install" ? (
                  <Loader2
                    size={11}
                    strokeWidth={1.5}
                    className="animate-spin"
                  />
                ) : null}
                {status?.installed ? "Update CLI" : "Install CLI to PATH"}
              </button>
            )}
          </div>
        </div>

        {status && !status.inPath && status.pathHint && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-[8px] border hairline bg-[var(--bg-elevated)] px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
              {status.pathHint}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyHint()}
              className="btn-ghost h-6 shrink-0 rounded-[6px] px-2 text-[11px]"
              title="Copy PATH snippet"
            >
              {copiedHint ? (
                <>
                  <Check size={11} strokeWidth={1.7} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={11} strokeWidth={1.5} />
                  Copy
                </>
              )}
            </button>
          </div>
        )}

        {status?.reason && !feedback && (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--status-warn)]">
            {status.reason}
          </p>
        )}
      </div>

      {feedback && (
        <p
          className={`mt-2.5 text-[12px] ${
            feedback.tone === "error"
              ? "text-[var(--status-err)]"
              : feedback.tone === "ok"
                ? "text-[var(--status-ok)]"
                : "text-[var(--text-secondary)]"
          }`}
        >
          {feedback.text}
        </p>
      )}

      <div className="mt-5 border-t hairline pt-4">
        <h3 className="text-[13px] font-medium">TUI style</h3>
        <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
          Default layout when launching <span className="font-mono">kip</span>.
          Switch anytime with <span className="font-mono">/layout</span>.
        </p>
        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
          {TUI_LAYOUTS.map((item) => {
            const selected = activeLayout === item.id;
            return (
              <button
                type="button"
                key={item.id}
                aria-pressed={selected}
                onClick={() => void setCliTuiLayout(item.id)}
                className={`flex items-start gap-3 rounded-[11px] border p-2.5 text-left transition-all active:scale-[0.99] ${
                  selected
                    ? "border-[var(--border-focus)] bg-[var(--bg-subtle)]"
                    : "hairline hover:bg-[var(--bg-subtle)]"
                }`}
              >
                <LayoutPreview layout={item.id} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      {item.title}
                    </span>
                    {selected && (
                      <Check
                        size={11}
                        strokeWidth={1.8}
                        className="shrink-0 text-[var(--text-primary)]"
                      />
                    )}
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-[1.35] text-[var(--text-muted)]">
                    {item.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 border-t hairline pt-4">
        <h3 className="text-[13px] font-medium">Quick start</h3>
        <div className="mt-2.5 space-y-1.5">
          {EXAMPLES.map((item) => (
            <div
              key={item.cmd}
              className="flex items-baseline justify-between gap-3 rounded-[8px] px-2.5 py-1.5 odd:bg-[var(--bg-subtle)]"
            >
              <code className="shrink-0 font-mono text-[12px] text-[var(--text-primary)]">
                {item.cmd}
              </code>
              <span className="truncate text-[12px] text-[var(--text-muted)]">
                {item.note}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          Inside the TUI, type <span className="font-mono">/</span> for{" "}
          <span className="font-mono">/model</span>,{" "}
          <span className="font-mono">/permission</span>,{" "}
          <span className="font-mono">/thinking</span>, or{" "}
          <span className="font-mono">/fullscreen</span>. Press{" "}
          <span className="kbd">Ctrl+O</span> to expand details.
        </p>
      </div>
    </div>
  );
}

function LayoutPreview({ layout }: { layout: CliTuiLayout }) {
  if (layout === "fullscreen") {
    return (
      <span
        aria-hidden="true"
        className="flex h-11 w-14 shrink-0 flex-col justify-between rounded-[6px] border hairline bg-[var(--bg-elevated)] p-1.5"
      >
        <span className="flex items-center justify-between border-b hairline pb-1">
          <span className="h-1 w-4 rounded-full bg-[var(--accent-action)]/75" />
          <span className="h-1 w-3 rounded-full bg-[var(--text-muted)]/35" />
        </span>
        <span className="flex flex-col gap-1 py-0.5">
          <span className="h-1 w-7 rounded-full bg-[var(--text-muted)]/35" />
          <span className="h-1 w-9 rounded-full bg-[var(--text-muted)]/22" />
        </span>
        <span className="h-1.5 w-full rounded-[2px] border hairline bg-[var(--bg-subtle)]" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-11 w-14 shrink-0 flex-col justify-end gap-1 rounded-[6px] border hairline bg-[var(--bg-elevated)] p-1.5"
    >
      <span className="h-1 w-6 rounded-full bg-[var(--text-muted)]/22" />
      <span className="h-1 w-9 rounded-full bg-[var(--text-muted)]/38" />
      <span className="h-1 w-7 rounded-full bg-[var(--text-muted)]/25" />
      <span className="mt-0.5 flex items-center gap-1 border-t hairline pt-1">
        <span className="h-1 w-1.5 rounded-full bg-[var(--accent-action)]/80" />
        <span className="h-1 w-6 rounded-full bg-[var(--text-muted)]/40" />
      </span>
    </span>
  );
}
