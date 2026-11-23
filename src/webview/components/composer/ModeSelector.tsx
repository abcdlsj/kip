import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Bot, Check, ChevronDown, MessageCircle } from "lucide-react";
import type { ThreadMode } from "../../../shared/types";

const MODE_OPTIONS: Array<{
  value: ThreadMode;
  label: string;
  description: string;
  icon: typeof Bot;
}> = [
  {
    value: "agent",
    label: "Agent",
    description:
      "Reads and edits the workspace with tools, under the current permission policy.",
    icon: Bot,
  },
  {
    value: "chat",
    label: "Chat",
    description:
      "Sends only the conversation: no tools, no system prompt, no workspace context.",
    icon: MessageCircle,
  },
];

interface ModeSelectorProps {
  mode: ThreadMode;
  onSelect: (mode: ThreadMode) => void;
  disabled?: boolean;
  /** Shown as the tooltip while the switch is disabled. */
  disabledReason?: string;
}

/**
 * Switches an empty thread between Agent and Chat. The option only exists where
 * the provider's plugin declares chat threads; the mode is fixed once a message
 * lands, because the request already recorded in the transcript cannot be
 * rebuilt with a different shape.
 */
export function ModeSelector({
  mode,
  onSelect,
  disabled,
  disabledReason,
}: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const current =
    MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[0]!;
  const CurrentIcon = current.icon;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)] data-[state=open]:bg-[var(--bg-subtle)] disabled:cursor-default disabled:hover:bg-transparent"
          title={
            disabled && disabledReason
              ? disabledReason
              : `Mode: ${current.label}`
          }
          aria-label="Thread mode"
        >
          <CurrentIcon
            size={13}
            strokeWidth={1.5}
            className="text-[var(--text-muted)]"
          />
          <span>{current.label}</span>
          <ChevronDown
            size={11}
            strokeWidth={1.5}
            className="shrink-0 text-[var(--text-muted)]"
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
          <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)]">
            Mode
          </p>
          <div className="space-y-0.5">
            {MODE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = option.value === mode;
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => {
                    onSelect(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors ${
                    selected
                      ? "bg-[var(--bg-subtle)]"
                      : "hover:bg-[var(--bg-subtle)]"
                  }`}
                >
                  <Icon
                    size={13}
                    strokeWidth={1.5}
                    className="mt-0.5 shrink-0 text-[var(--text-muted)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      {option.label}
                    </div>
                    <p className="text-[11.5px] leading-[1.4] text-[var(--text-muted)]">
                      {option.description}
                    </p>
                  </div>
                  {selected && (
                    <Check
                      size={12}
                      strokeWidth={1.7}
                      className="mt-0.5 shrink-0 text-[var(--text-primary)]"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
