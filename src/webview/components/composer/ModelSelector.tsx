import * as Popover from "@radix-ui/react-popover";
import { useMemo, useState } from "react";
import { Check, ChevronDown, Search, Sparkles, Zap } from "lucide-react";
import type { ModelOption, ThinkingLevel } from "../../../shared/types";
import { formatTokens } from "../../lib/format";
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
  const updateThreadModel = useWorkspaceStore(
    (state) => state.updateThreadModel,
  );
  const setThreadThinking = useWorkspaceStore(
    (state) => state.setThreadThinking,
  );
  const providers = useUiStore((state) => state.providers);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // The model list is fetched at startup; reload it whenever the picker opens
  // so providers added since then show up.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setFilter("");
      void refreshSettings();
    }
  };

  const models = settings?.availableModels ?? [];
  const providerNames = useMemo(
    () => new Map(providers.map((p) => [p.id, p.displayName])),
    [providers],
  );

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? models.filter(
          (model) =>
            model.displayName.toLowerCase().includes(needle) ||
            model.modelId.toLowerCase().includes(needle) ||
            model.provider.toLowerCase().includes(needle),
        )
      : models;
    const map = new Map<string, ModelOption[]>();
    for (const model of filtered) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()];
  }, [models, filter]);

  if (!settings) return null;
  const activeProvider = thread?.modelProvider || settings.defaultProvider;
  const activeModelId = thread?.modelId || settings.defaultModelId;
  const active = models.find(
    (model) =>
      model.provider === activeProvider && model.modelId === activeModelId,
  );
  const thinking = thread?.thinkingLevel ?? settings.defaultThinkingLevel;
  const thinkingLabel =
    THINKING_LEVELS.find((item) => item.value === thinking)?.label ?? "Medium";

  const chooseModel = async (model: ModelOption) => {
    if (thread)
      await updateThreadModel(thread.id, model.provider, model.modelId);
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

  const multipleProviders = grouped.length > 1;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="btn-ghost -ml-1 h-7 max-w-[260px] gap-1.5 rounded-[8px] px-2 text-[12.5px] data-[state=open]:bg-[var(--bg-subtle)]"
        >
          <span className="truncate font-medium text-[var(--text-primary)]">
            {active?.displayName ?? "Select model"}
          </span>
          <span className="text-[var(--text-muted)]">·</span>
          <span className="shrink-0 text-[var(--text-muted)]">
            {thinkingLabel}
          </span>
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
          className="popover-surface z-50 w-[312px] rounded-[14px] border hairline bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-modal)] outline-none"
        >
          <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)]">
            Model
          </p>
          {models.length > 6 && (
            <div className="relative mx-1 mb-1.5">
              <Search
                size={12}
                strokeWidth={1.5}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter models…"
                className="h-7 w-full rounded-[7px] border hairline bg-[var(--bg-canvas)] pl-7 pr-2.5 text-[12px] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
              />
            </div>
          )}
          <div className="thin-scroll max-h-[240px] overflow-y-auto">
            {grouped.map(([providerId, items], groupIndex) => (
              <div key={providerId}>
                {multipleProviders && (
                  <p
                    className={`px-2 pb-0.5 text-[10.5px] font-medium text-[var(--text-muted)] ${
                      groupIndex === 0 ? "pt-0.5" : "pt-2"
                    }`}
                  >
                    {providerNames.get(providerId) ?? providerId}
                  </p>
                )}
                {items.map((model) => {
                  const selected =
                    model.provider === activeProvider &&
                    model.modelId === activeModelId;
                  return (
                    <button
                      type="button"
                      key={`${model.provider}:${model.modelId}`}
                      onClick={() => void chooseModel(model)}
                      className={`flex h-8 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] transition-colors ${
                        selected
                          ? "bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {model.displayName}
                      </span>
                      {model.supportsReasoning && (
                        <Sparkles
                          size={11}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--text-muted)]"
                          aria-label="Supports reasoning"
                        />
                      )}
                      {model.contextWindow > 0 && (
                        <span className="text-meta shrink-0 text-[10.5px] text-[var(--text-muted)]">
                          {formatTokens(model.contextWindow)}
                        </span>
                      )}
                      {!multipleProviders && (
                        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                          {providerNames.get(model.provider) ?? model.provider}
                        </span>
                      )}
                      {selected && (
                        <Check
                          size={12}
                          strokeWidth={1.7}
                          className="shrink-0"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {grouped.length === 0 && (
              <p className="px-2 py-2.5 text-[12px] leading-[1.5] text-[var(--text-muted)]">
                {models.length > 0
                  ? "No matching models."
                  : providers.length > 0
                    ? "No usable models. Check that each provider in Settings has at least one model ID."
                    : "Add a provider in Settings."}
              </p>
            )}
          </div>
          <div className="my-1.5 border-t hairline" />
          <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--text-muted)]">
            Reasoning
          </p>
          <div className="flex gap-1 px-1 pb-1">
            {THINKING_LEVELS.map((level) => (
              <button
                type="button"
                key={level.value}
                onClick={() => void chooseThinking(level.value)}
                className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-[7px] text-[12px] transition-colors ${
                  thinking === level.value
                    ? "bg-[var(--bg-active)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
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
