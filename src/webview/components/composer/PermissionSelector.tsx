import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import {
  Check,
  ChevronDown,
  Flame,
  ShieldCheck,
  ShieldHalf,
  ShieldOff,
} from "lucide-react";
import type { ApprovalPolicy } from "../../../shared/types";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

const POLICY_OPTIONS: Array<{
  value: ApprovalPolicy;
  shortLabel: string;
  label: string;
  description: string;
  icon: typeof ShieldHalf;
}> = [
  {
    value: "strict",
    shortLabel: "Strict",
    label: "Strict",
    description: "Every file read, edit, and command waits for your approval.",
    icon: ShieldCheck,
  },
  {
    value: "read-only-auto",
    shortLabel: "Ask",
    label: "Read-only auto",
    description:
      "Workspace reads and safe commands run automatically. Edits, other commands, and outside-workspace access ask.",
    icon: ShieldHalf,
  },
  {
    value: "full-auto",
    shortLabel: "Full auto",
    label: "Full auto",
    description:
      "All reads, edits, and commands inside the workspace run automatically. Outside-workspace access still asks.",
    icon: ShieldOff,
  },
  {
    value: "yolo",
    shortLabel: "YOLO",
    label: "YOLO",
    description:
      "Never asks for approval — runs all edits, commands, and outside-workspace access automatically.",
    icon: Flame,
  },
];

export function PermissionSelector() {
  const settings = useUiStore((state) => state.settings);
  const setGlobalPolicy = useUiStore((state) => state.setApprovalPolicy);
  const thread = useWorkspaceStore((state) =>
    state.threads.find((item) => item.id === state.activeThreadId),
  );
  const setThreadApprovalPolicy = useWorkspaceStore(
    (state) => state.setThreadApprovalPolicy,
  );
  const [open, setOpen] = useState(false);

  if (!settings) return null;

  const globalPolicy = settings.approvalPolicy;
  const sessionOverride = thread?.approvalPolicy ?? null;
  const effectivePolicy: ApprovalPolicy = sessionOverride ?? globalPolicy;
  const current =
    POLICY_OPTIONS.find((item) => item.value === effectivePolicy) ??
    POLICY_OPTIONS[0]!;
  const globalOption =
    POLICY_OPTIONS.find((item) => item.value === globalPolicy) ??
    POLICY_OPTIONS[0]!;
  const CurrentIcon = current.icon;

  const choose = async (policy: ApprovalPolicy) => {
    if (thread) {
      await setThreadApprovalPolicy(thread.id, policy);
    } else {
      await setGlobalPolicy(policy);
    }
    setOpen(false);
  };

  const resetToGlobal = async () => {
    if (!thread) return;
    await setThreadApprovalPolicy(thread.id, null);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] data-[state=open]:bg-[var(--bg-subtle)]"
          title={
            sessionOverride
              ? `Session permission: ${current.label} (overrides global)`
              : `Permission: ${current.label} (global default)`
          }
          aria-label="Session permission"
        >
          <CurrentIcon
            size={13}
            strokeWidth={1.5}
            className={
              effectivePolicy === "yolo"
                ? "text-[var(--status-err)]"
                : effectivePolicy === "full-auto"
                  ? "text-[var(--status-warn)]"
                  : "text-[var(--text-muted)]"
            }
          />
          <span
            className={
              effectivePolicy === "yolo"
                ? "font-medium text-[var(--status-err)]"
                : undefined
            }
          >
            {current.shortLabel}
          </span>
          {sessionOverride && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                effectivePolicy === "yolo"
                  ? "bg-[var(--status-err)]"
                  : "bg-[var(--text-secondary)]"
              }`}
              aria-hidden="true"
            />
          )}
          <ChevronDown
            size={11}
            strokeWidth={1.5}
            className={`shrink-0 ${
              effectivePolicy === "yolo"
                ? "text-[var(--status-err)]"
                : "text-[var(--text-muted)]"
            }`}
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="popover-surface z-50 w-[308px] rounded-[14px] border hairline bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-modal)] outline-none"
        >
          <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)]">
              {thread ? "Session permission" : "Permission"}
            </p>
            {thread && (
              <span className="text-[11px] text-[var(--text-muted)]">
                {sessionOverride ? "Overrides global" : "Using global"}
              </span>
            )}
          </div>
          <div className="space-y-0.5">
            {POLICY_OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = effectivePolicy === option.value;
              const isYolo = option.value === "yolo";
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => void choose(option.value)}
                  className={`flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors ${
                    selected
                      ? "bg-[var(--bg-subtle)]"
                      : "hover:bg-[var(--bg-subtle)]"
                  }`}
                >
                  <Icon
                    size={13}
                    strokeWidth={1.5}
                    className={`mt-0.5 shrink-0 ${
                      isYolo
                        ? "text-[var(--status-err)]"
                        : option.value === "full-auto"
                          ? "text-[var(--status-warn)]"
                          : "text-[var(--text-muted)]"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`flex items-center gap-1.5 text-[12.5px] font-medium ${
                        isYolo
                          ? "text-[var(--status-err)]"
                          : "text-[var(--text-primary)]"
                      }`}
                    >
                      <span>{option.label}</span>
                    </div>
                    <p className="text-[11.5px] leading-[1.4] text-[var(--text-muted)]">
                      {option.description}
                    </p>
                  </div>
                  {selected && (
                    <Check
                      size={12}
                      strokeWidth={1.7}
                      className={`mt-0.5 shrink-0 ${
                        isYolo
                          ? "text-[var(--status-err)]"
                          : "text-[var(--text-primary)]"
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
          {thread && sessionOverride && (
            <>
              <div className="my-1 border-t hairline" />
              <button
                onClick={() => void resetToGlobal()}
                className="flex h-7 w-full items-center justify-between rounded-[7px] px-2 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
              >
                <span>Use global default</span>
                <span
                  className={
                    globalPolicy === "yolo"
                      ? "font-medium text-[var(--status-err)]"
                      : undefined
                  }
                >
                  {globalOption.shortLabel}
                </span>
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
