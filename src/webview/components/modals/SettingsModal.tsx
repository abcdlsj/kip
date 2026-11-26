import * as Dialog from "@radix-ui/react-dialog";
import {
  Boxes,
  Check,
  Cloud,
  Palette,
  Puzzle,
  RotateCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type {
  ApprovalPolicy,
  ThemeMode,
  ThinkingLevel,
} from "../../../shared/types";
import { modShortcut } from "../../lib/platform";
import { useUiStore } from "../../stores/ui-store";
import { CliPanel } from "./CliPanel";
import { PluginsPanel } from "./PluginsPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { SyncPanel } from "./SyncPanel";

const TABS = [
  { id: "providers", label: "Providers", icon: Boxes },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "safety", label: "Safety", icon: ShieldCheck },
  { id: "cli", label: "CLI", icon: Terminal },
  { id: "sync", label: "Sync", icon: Cloud },
] as const;

export function SettingsModal() {
  const open = useUiStore((state) => state.settingsOpen);
  const tab = useUiStore((state) => state.settingsTab);
  const openSettings = useUiStore((state) => state.openSettings);
  const close = useUiStore((state) => state.closeSettings);
  const settings = useUiStore((state) => state.settings);
  const providers = useUiStore((state) => state.providers);
  const setTheme = useUiStore((state) => state.setTheme);
  const setApprovalPolicy = useUiStore((state) => state.setApprovalPolicy);
  const setDefaultThinking = useUiStore((state) => state.setDefaultThinking);
  // Same source as the update arrow: the version the running bundle reports.
  const version = useUiStore((state) => state.update?.current);
  const refresh = useUiStore((state) => state.refresh);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => (value ? openSettings() : close())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-[var(--bg-scrim)] backdrop-blur-[4px]" />
        <Dialog.Content className="modal-surface fixed left-1/2 top-1/2 z-50 flex h-[590px] w-[740px] max-w-[calc(100vw-48px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[16px] border hairline bg-[var(--bg-elevated)] shadow-[var(--shadow-modal)] outline-none">
          <Dialog.Title className="sr-only">Kip settings</Dialog.Title>
          <nav className="flex w-[172px] shrink-0 flex-col border-r hairline bg-[var(--bg-sidebar)] p-2.5">
            <p className="px-2 pb-3 pt-2 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">
              Settings
            </p>
            <div className="space-y-0.5">
              {TABS.map((item) => {
                const Icon = item.icon;
                const active = tab === item.id;
                return (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={active ? "page" : undefined}
                    onClick={() => openSettings(item.id)}
                    className={`flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-[12.5px] transition-colors ${
                      active
                        ? "bg-[var(--bg-active)] font-medium text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <Icon
                      size={13}
                      strokeWidth={1.5}
                      className={
                        active
                          ? "text-[var(--text-primary)]"
                          : "text-[var(--text-muted)]"
                      }
                    />
                    {item.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-auto px-2.5 pb-1 font-mono text-[11px] text-[var(--text-muted)]">
              {version ? `Kip ${version}` : "Kip"}
            </div>
          </nav>
          <div className="thin-scroll relative min-w-0 flex-1 overflow-y-auto p-6 pr-11">
            <Dialog.Close asChild>
              <button
                type="button"
                className="btn-icon absolute right-3.5 top-3.5 h-7 w-7 rounded-full"
                aria-label="Close settings"
                title="Close (Esc)"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
            {tab === "providers" && <ProvidersPanel providers={providers} />}
            {tab === "plugins" && <PluginsPanel />}
            {tab === "appearance" && (
              <div>
                <h2 className="text-[15px] font-semibold">Appearance</h2>
                <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                  Warm paper in daylight, obsidian after dark.
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2.5">
                  {(["light", "dark", "system"] as ThemeMode[]).map((theme) => {
                    const selected = settings?.theme === theme;
                    return (
                      <button
                        type="button"
                        key={theme}
                        aria-pressed={selected}
                        onClick={() => void setTheme(theme)}
                        className={`flex flex-col items-center gap-2 rounded-[11px] border p-3 text-[12px] capitalize transition-all active:scale-[0.98] ${
                          selected
                            ? "border-[var(--border-focus)] bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                            : "hairline text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
                        }`}
                      >
                        <ThemePreview theme={theme} />
                        <span className="flex items-center gap-1">
                          {theme}
                          {selected && <Check size={11} strokeWidth={1.8} />}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <h3 className="mt-6 text-[13px] font-medium">
                  Default reasoning
                </h3>
                <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                  Used for new threads. Existing threads keep their own level.
                </p>
                <div className="mt-2.5 inline-flex w-full rounded-[9px] border hairline bg-[var(--bg-sidebar)] p-0.5">
                  {(["off", "low", "medium", "high"] as ThinkingLevel[]).map(
                    (level) => {
                      const selected = settings?.defaultThinkingLevel === level;
                      return (
                        <button
                          type="button"
                          key={level}
                          aria-pressed={selected}
                          onClick={() => void setDefaultThinking(level)}
                          className={`h-7 flex-1 rounded-[7px] text-[12px] capitalize transition-all ${
                            selected
                              ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          {level}
                        </button>
                      );
                    },
                  )}
                </div>

                <div className="mt-6 flex items-center justify-between border-t hairline pt-4">
                  <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                    Tip: <span className="kbd">{modShortcut("B")}</span> toggles
                    the sidebar and{" "}
                    <span className="kbd">{modShortcut("K")}</span> opens the
                    command palette.
                  </p>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="btn-secondary h-7 shrink-0 rounded-[7px] px-2.5 text-[11.5px]"
                  >
                    <RotateCw size={11} strokeWidth={1.5} />
                    Reload
                  </button>
                </div>
              </div>
            )}
            {tab === "safety" && (
              <div>
                <h2 className="text-[15px] font-semibold">Safety</h2>
                <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                  Kip pauses before it changes files or runs commands. Choose
                  how much it asks.
                </p>
                <div className="mt-4 space-y-2">
                  {POLICIES.map((policy) => {
                    const active = settings?.approvalPolicy === policy.id;
                    return (
                      <button
                        type="button"
                        key={policy.id}
                        aria-pressed={active}
                        onClick={() => void setApprovalPolicy(policy.id)}
                        className={`w-full rounded-[11px] border px-3.5 py-2.5 text-left transition-all active:scale-[0.995] ${
                          active
                            ? "border-[var(--border-focus)] bg-[var(--bg-subtle)]"
                            : "hairline hover:bg-[var(--bg-subtle)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-[13px] font-medium ${
                              policy.id === "yolo"
                                ? "text-[var(--status-err)]"
                                : "text-[var(--text-primary)]"
                            }`}
                          >
                            {policy.title}
                          </span>
                          {active && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-active)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-primary)]">
                              <Check size={10} strokeWidth={1.8} />
                              Active
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                          {policy.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  Outside-workspace access still requires approval unless YOLO
                  is enabled. Paths under{" "}
                  <span className="font-mono">~/.ssh</span>,{" "}
                  <span className="font-mono">~/.aws</span>,{" "}
                  <span className="font-mono">~/.gnupg</span>, and the Kip
                  credential store are always blocked.
                </p>
              </div>
            )}
            {tab === "cli" && <CliPanel />}
            {tab === "sync" && <SyncPanel />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThemePreview({ theme }: { theme: ThemeMode }) {
  if (theme === "system") {
    return (
      <span className="relative flex h-9 w-16 overflow-hidden rounded-[6px] border hairline">
        <span className="flex w-1/2 bg-[#f0eee7] p-1">
          <span className="h-full w-full rounded-[3px] bg-[#fbfaf7]" />
        </span>
        <span className="flex w-1/2 bg-[#1b1a19] p-1">
          <span className="h-full w-full rounded-[3px] bg-[#232221]" />
        </span>
      </span>
    );
  }
  const dark = theme === "dark";
  return (
    <span
      className="flex h-9 w-16 gap-1 rounded-[6px] border hairline p-1"
      style={{ background: dark ? "#1b1a19" : "#f0eee7" }}
    >
      <span
        className="w-3.5 rounded-[3px]"
        style={{
          background: dark ? "rgba(250,249,245,0.06)" : "rgba(31,30,29,0.06)",
        }}
      />
      <span
        className="flex-1 rounded-[3px]"
        style={{ background: dark ? "#232221" : "#fbfaf7" }}
      />
    </span>
  );
}

const POLICIES: Array<{
  id: ApprovalPolicy;
  title: string;
  description: string;
}> = [
  {
    id: "strict",
    title: "Strict",
    description: "Every file read, edit, and command waits for your approval.",
  },
  {
    id: "read-only-auto",
    title: "Read-only auto",
    description:
      "Workspace reads and safe commands run automatically. Edits, other commands, and outside-workspace access ask.",
  },
  {
    id: "full-auto",
    title: "Full auto",
    description:
      "All reads, edits, and commands inside the workspace run automatically. Outside-workspace access still asks.",
  },
  {
    id: "yolo",
    title: "YOLO",
    description:
      "Never asks for approval — runs all edits, commands, and outside-workspace access automatically.",
  },
];
