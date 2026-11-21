import * as Dialog from "@radix-ui/react-dialog";
import { Boxes, Cloud, Palette, ShieldCheck, X } from "lucide-react";
import type { ApprovalPolicy, ThemeMode, ThinkingLevel } from "../../../shared/types";
import { useUiStore } from "../../stores/ui-store";
import { GatewayPlugins } from "./GatewayPlugins";
import { ProvidersPanel } from "./ProvidersPanel";
import { SyncPanel } from "./SyncPanel";

const TABS = [
  { id: "providers", label: "Providers", icon: Boxes },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "safety", label: "Safety", icon: ShieldCheck },
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
    <Dialog.Root open={open} onOpenChange={(value) => (value ? openSettings() : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--bg-scrim)] backdrop-blur-[4px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[580px] w-[720px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[16px] border hairline bg-[var(--bg-elevated)] shadow-[var(--shadow-modal)]">
          <Dialog.Title className="sr-only">Kip settings</Dialog.Title>
          <nav className="flex w-[168px] shrink-0 flex-col border-r hairline bg-[var(--bg-sidebar)] p-2.5">
            <p className="px-2 pb-3 pt-2 text-[11.5px] font-medium text-[var(--text-muted)]">
              Settings
            </p>
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => openSettings(item.id)}
                  className={`mb-0.5 flex h-8 items-center gap-2 rounded-[7px] px-2 text-[12.5px] transition-colors ${
                    tab === item.id
                      ? "bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
                  }`}
                >
                  <Icon size={13} strokeWidth={1.5} />
                  {item.label}
                </button>
              );
            })}
            <div className="mt-auto px-2 pb-1 text-[11px] text-[var(--text-muted)]">
              {version ? `Kip ${version}` : "Kip"}
            </div>
          </nav>
          <div className="relative min-w-0 flex-1 overflow-y-auto p-5 pr-10 thin-scroll">
            <Dialog.Close asChild>
              <button
                className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
                aria-label="Close settings"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
            {tab === "providers" && (
              <>
                <ProvidersPanel providers={providers} />
                <GatewayPlugins />
              </>
            )}
            {tab === "appearance" && (
              <div>
                <h2 className="text-[15px] font-semibold">Appearance</h2>
                <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                  Warm paper in daylight, obsidian after dark.
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  {(["light", "dark", "system"] as ThemeMode[]).map((theme) => (
                    <button
                      key={theme}
                      onClick={() => void setTheme(theme)}
                      className={`flex h-[74px] flex-col items-center justify-center gap-2 rounded-[10px] border text-[12px] capitalize transition-colors ${
                        settings?.theme === theme
                          ? "border-[var(--border-focus)] bg-[var(--bg-subtle)] font-medium"
                          : "hairline hover:bg-[var(--bg-subtle)]"
                      }`}
                    >
                      <span
                        className="h-6 w-10 rounded-[4px] border hairline"
                        style={{
                          background:
                            theme === "dark"
                              ? "#111113"
                              : theme === "light"
                                ? "#FAF9F6"
                                : "linear-gradient(120deg,#FAF9F6 50%,#111113 50%)",
                        }}
                      />
                      {theme}
                    </button>
                  ))}
                </div>
                <h3 className="mt-6 text-[13px] font-medium">Default reasoning</h3>
                <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                  Used for new threads. Existing threads keep their own level.
                </p>
                <div className="mt-2 flex gap-1.5">
                  {(["off", "low", "medium", "high"] as ThinkingLevel[]).map((level) => (
                    <button
                      key={level}
                      onClick={() => void setDefaultThinking(level)}
                      className={`h-7 flex-1 rounded-[6px] text-[12px] capitalize transition-colors ${
                        settings?.defaultThinkingLevel === level
                          ? "bg-[var(--bg-subtle)] font-medium"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
                <p className="mt-6 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  Tip: use ⌘B to collapse the sidebar and ⌘K for the command palette.
                </p>
                <button
                  onClick={() => void refresh()}
                  className="mt-4 h-7 rounded-[8px] border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
                >
                  Reload preferences
                </button>
              </div>
            )}
            {tab === "safety" && (
              <div>
                <h2 className="text-[15px] font-semibold">Safety</h2>
                <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                  Kip pauses before it changes files or runs commands. Choose how much it asks.
                </p>
                <div className="mt-4 space-y-2">
                  {POLICIES.map((policy) => (
                    <button
                      key={policy.id}
                      onClick={() => void setApprovalPolicy(policy.id)}
                      className={`w-full rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                        settings?.approvalPolicy === policy.id
                          ? "border-[var(--border-focus)] bg-[var(--bg-subtle)]"
                          : "hairline hover:bg-[var(--bg-subtle)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[12.5px] font-medium ${
                            policy.id === "yolo" ? "text-[var(--status-err)]" : ""
                          }`}
                        >
                          {policy.title}
                        </span>
                        {settings?.approvalPolicy === policy.id && (
                          <span className="text-[11px] text-[var(--text-muted)]">active</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                        {policy.description}
                      </p>
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  Outside-workspace access still requires approval unless YOLO is enabled. Paths
                  under ~/.ssh, ~/.aws, ~/.gnupg, and the Kip credential store are always blocked.
                </p>
              </div>
            )}
            {tab === "sync" && <SyncPanel />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
