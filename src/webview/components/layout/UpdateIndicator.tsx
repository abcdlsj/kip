/**
 * The single quiet update mark at the bottom of the sidebar. It only appears
 * when a newer release exists, and it is the only place an update is acted on:
 * Homebrew installs get the cask command, dmg installs a restart prompt.
 */
import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpCircle, Check, Copy } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";

const BREW_COMMAND = "brew upgrade --cask kip";

const ICON_BUTTON = "btn-icon h-7 w-7 shrink-0 rounded-[7px]";

export function UpdateIndicator() {
  const update = useUiStore((state) => state.update);
  const openUpdatePage = useUiStore((state) => state.openUpdatePage);
  const restartForUpdate = useUiStore((state) => state.restartForUpdate);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [runningThreads, setRunningThreads] = useState<number | null>(null);

  // Ask only while the prompt is open: restarting is what stops agents.
  useEffect(() => {
    if (!open) {
      setCopied(false);
      setRunningThreads(null);
      return;
    }
    let cancelled = false;
    void request("getRunningThreadCount", undefined)
      .then((count) => {
        if (!cancelled) setRunningThreads(count);
      })
      .catch(() => {
        if (!cancelled) setRunningThreads(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!update?.available) return null;

  const version = update.latest;
  const icon = <ArrowUpCircle size={14} strokeWidth={1.5} />;
  const label = `Update available: Kip ${version}`;

  if (update.installSource === "manual") {
    return (
      <button
        onClick={() => void openUpdatePage()}
        title={label}
        aria-label={label}
        className={ICON_BUTTON}
      >
        {icon}
      </button>
    );
  }

  // The bundle is being fetched; the spinner is the only progress shown.
  // Homebrew installs never stage anything, so they skip this and open the
  // command prompt right away.
  if (update.installSource === "direct" && update.state !== "ready") {
    const downloading = update.state === "downloading";
    return (
      <button
        disabled
        title={downloading ? `Downloading Kip ${version}… ${update.progress}%` : label}
        aria-label={downloading ? `Downloading Kip ${version}` : label}
        className={`${ICON_BUTTON} cursor-default hover:bg-transparent`}
      >
        <span className="ring-spin h-[11px] w-[11px]" />
      </button>
    );
  }

  const running = runningThreads ?? 0;
  const promptLabel =
    update.installSource === "homebrew"
      ? `Update available: Kip ${version}`
      : `Restart to install Kip ${version}`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button title={promptLabel} aria-label={promptLabel} className={ICON_BUTTON}>
          {icon}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          className="popover-surface z-50 w-[224px] rounded-[11px] border hairline bg-[var(--bg-elevated)] p-2.5 shadow-[var(--shadow-modal)] outline-none"
        >
          {update.installSource === "homebrew" ? (
            <>
              <p className="text-[12.5px] font-medium">Kip {version} is available</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                Installed with Homebrew. Update from the terminal:
              </p>
              <button
                onClick={() => {
                  void copyText(BREW_COMMAND).then((ok) => {
                    if (ok) setCopied(true);
                  });
                }}
                title="Copy command"
                className="mt-2 flex h-7 w-full items-center gap-2 rounded-[6px] bg-[var(--bg-subtle)] px-2 text-left transition-colors hover:bg-[var(--bg-active)]"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{BREW_COMMAND}</span>
                {copied ? (
                  <Check size={12} strokeWidth={1.5} className="shrink-0 text-[var(--status-ok)]" />
                ) : (
                  <Copy size={12} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
                )}
              </button>
              {update.releaseUrl && (
                <button
                  onClick={() => {
                    setOpen(false);
                    void openUpdatePage();
                  }}
                  className="mt-1.5 h-6 w-full rounded-[6px] text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
                >
                  Release notes
                </button>
              )}
            </>
          ) : (
            <>
              <p className="text-[12.5px] font-medium">Kip {version} is ready</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                {running > 0
                  ? `Restarting stops ${running} running ${running === 1 ? "agent" : "agents"}.`
                  : "Kip restarts to finish the update."}
              </p>
              <button
                onClick={() => {
                  setOpen(false);
                  void restartForUpdate();
                }}
                className="mt-2 h-7 w-full rounded-[6px] bg-[var(--accent-ink)] text-[12px] font-medium text-[var(--accent-ink-fg)] transition-opacity hover:opacity-90"
              >
                {running > 0 ? "Stop agents & restart" : "Restart Kip"}
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
