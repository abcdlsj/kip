import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Check, ChevronDown, Zap } from "lucide-react";
import type { ModelOption, ThinkingLevel } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function ModelSelector() {
  const settings = useUiStore((state) => state.settings);
  const refreshSettings = useUiStore((state) => state.refresh);
  const thread = useWorkspaceStore((state) =>
    state.threads.find((item) => item.id === state.activeThreadId),
  );
  const updateThreadModel = useWorkspaceStore((state) => state.updateThreadModel);
  const setThreadThinking = useWorkspaceStore((state) => state.setThreadThinking);
  const [open, setOpen] = useState(false);

  if (!settings) return null;
  const models = settings.availableModels;
  const activeProvider = thread?.modelProvider || settings.defaultProvider;
  const activeModelId = thread?.modelId || settings.defaultModelId;
  const active = models.find(
    (model) => model.provider === activeProvider && model.modelId === activeModelId,
  );
  const thinking = thread?.thinkingLevel ?? settings.defaultThinkingLevel;
  const thinkingLabel = THINKING_LEVELS.find((item) => item.value === thinking)?.label ?? "Medium";

  const chooseModel = async (model: ModelOption) => {
    if (thread) await updateThreadModel(thread.id, model.provider, model.modelId);
    else {
      await request("updateSettings", {
        defaultProvider: model.provider,
        defaultModelId: model.modelId,
      });
      await refreshSettings();
    }
    setOpen(false);
  };

  const chooseThinking = async (level: ThinkingLevel) => {
    if (thread) await setThreadThinking(thread.id, level);
    else {
      await request("updateSettings", { defaultThinkingLevel: level });
      await refreshSettings();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex h-7 max-w-[240px] items-center gap-1.5 rounded-full border hairline px-2.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]">
          <span className="truncate">{active?.displayName ?? "Select model"}</span>
          <span className="text-[var(--text-muted)]">·</span>
          <span className="shrink-0 text-[var(--text-muted)]">{thinkingLabel}</span>
          <ChevronDown size={11} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-[300px] rounded-[12px] border hairline bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-modal)]"
        >
          <p className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-muted)]">
            Model
          </p>
          <div className="max-h-[220px] overflow-y-auto scrollbar-none">
            {models.map((model) => {
              const selected =
                model.provider === activeProvider && model.modelId === activeModelId;
              return (
                <button
                  key={`${model.provider}:${model.modelId}`}
                  onClick={() => void chooseModel(model)}
                  className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] transition-colors hover:bg-[var(--bg-subtle)]"
                >
                  <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">
                    {model.provider}
                  </span>
                  {selected && <Check size={12} strokeWidth={1.5} />}
                </button>
              );
            })}
            {models.length === 0 && (
              <p className="px-2 py-2 text-[12px] text-[var(--text-muted)]">
                Add a provider in Settings.
              </p>
            )}
          </div>
          <div className="my-1 border-t hairline" />
          <p className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-muted)]">
            Reasoning
          </p>
          <div className="flex gap-1 px-1 pb-1">
            {THINKING_LEVELS.map((level) => (
              <button
                key={level.value}
                onClick={() => void chooseThinking(level.value)}
                className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-[6px] text-[11.5px] transition-colors ${
                  thinking === level.value
                    ? "bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
                }`}
              >
                {level.value !== "off" && <Zap size={10} strokeWidth={1.5} />}
                {level.label}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
