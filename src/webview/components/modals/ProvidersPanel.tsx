import { useEffect, useState, type ReactNode } from "react";
import { Check, CloudDownload, Eye, Loader2, Plus, Sparkles, Trash2, Zap } from "lucide-react";
import type { ProviderModel, ProviderProtocol, ProviderRecord } from "../../../shared/types";
import { displayModelName } from "../../lib/model-name";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

interface ProvidersPanelProps {
  providers: ProviderRecord[];
}

interface FormState {
  key: string;
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  modelIds: string;
  models: ProviderModel[];
}

interface StatusMessage {
  text: string;
  tone: "ok" | "error" | "info";
}

const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  "openai-completions": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic",
  "google-generative-ai": "Google Gemini",
};

const EMPTY: FormState = {
  key: "",
  id: "",
  displayName: "",
  protocol: "openai-completions",
  baseUrl: "",
  apiKey: "",
  modelIds: "",
  models: [],
};

function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(baseUrl);
}

export function ProvidersPanel({ providers }: ProvidersPanelProps) {
  const refreshProviders = useUiStore((state) => state.refreshProviders);
  const refreshSettings = useUiStore((state) => state.refresh);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  const edit = (provider: ProviderRecord) => {
    setForm({
      key: provider.id,
      id: provider.id,
      displayName: provider.displayName,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: "",
      modelIds: provider.models.map((model) => model.id).join("\n"),
      models: provider.models,
    });
    setStatus(null);
  };

  const save = async () => {
    if (!form) return;
    const id = (form.id || form.displayName).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const models = resolveFormModels(form.modelIds, form.models);
    if (!id || !form.baseUrl.trim() || models.length === 0) {
      setStatus({
        text: "A name, base URL, and at least one model are required.",
        tone: "error",
      });
      return;
    }
    setBusy("save");
    try {
      await request("saveProvider", {
        id,
        displayName: form.displayName.trim() || id,
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        models,
      });
      await refreshProviders();
      await refreshSettings();
      await refreshThreads();
      setForm(null);
      setStatus({ text: "Provider saved.", tone: "ok" });
    } catch (error) {
      setStatus({
        text: error instanceof Error ? error.message : "Could not save provider.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleCapability = (
    modelId: string,
    field: "supportsVision" | "supportsReasoning",
  ) => {
    if (!form) return;
    const resolved = resolveFormModels(form.modelIds, form.models);
    const nextModels = resolved.map((model) =>
      model.id === modelId ? { ...model, [field]: !model[field] } : model,
    );
    setForm({ ...form, models: nextModels });
  };

  const fetchModels = async () => {
    if (!form) return;
    setBusy("fetch");
    try {
      const result = await request("fetchProviderModels", {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
      });
      if (result.models.length) {
        // The server tends to know a display name the id does not spell out
        // ("gemini-neon" is "Deeper analysis"); keep it rather than let
        // `resolveFormModels` fall back to title-casing the id.
        const named = result.models.filter((model) => model.displayName).length;
        setForm({
          ...form,
          models: result.models,
          modelIds: result.models.map((model) => model.id).join("\n"),
        });
        setStatus({
          text: `Found ${result.models.length} ${
            result.models.length === 1 ? "model" : "models"
          }${named > 0 ? " with names and capabilities" : ""}.`,
          tone: "ok",
        });
      } else {
        setStatus({ text: result.error || "No models returned.", tone: "error" });
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: ProviderRecord) => {
    if (confirmDeleteId !== provider.id) {
      setConfirmDeleteId(provider.id);
      return;
    }
    setConfirmDeleteId(null);
    setBusy(provider.id);
    try {
      await request("deleteProvider", { provider: provider.id });
      await refreshProviders();
      await refreshSettings();
      setStatus({ text: `${provider.displayName} removed.`, tone: "info" });
    } finally {
      setBusy(null);
    }
  };

  const test = async (provider: ProviderRecord) => {
    setBusy(provider.id);
    try {
      const result = await request("testProvider", { provider: provider.id });
      setStatus(
        result.connected
          ? { text: `${provider.displayName} connected · ${result.latencyMs}ms`, tone: "ok" }
          : {
              text: `${provider.displayName}: ${result.error ?? "Connection failed"}`,
              tone: "error",
            },
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Model providers</h2>
          <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
            Any endpoint that speaks the OpenAI, Anthropic, or Google wire format.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setForm({ ...EMPTY });
            setStatus(null);
          }}
          className="btn-primary h-8 shrink-0 whitespace-nowrap rounded-[8px] px-3 text-[12px]"
        >
          <Plus size={13} strokeWidth={1.5} />
          Add provider
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {providers.map((provider) => {
          const armed = confirmDeleteId === provider.id;
          const local = isLocalEndpoint(provider.baseUrl);
          return (
            <div
              key={provider.id}
              className="flex items-center gap-2.5 rounded-[11px] border hairline px-3.5 py-2.5 transition-colors hover:border-[var(--border-focus)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                    {provider.displayName}
                  </span>
                  <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-muted)]">
                    {PROTOCOL_LABELS[provider.protocol] ?? provider.protocol}
                  </span>
                  {provider.hasApiKey ? (
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--status-ok)]">
                      <Check size={10} strokeWidth={2} /> key
                    </span>
                  ) : (
                    <span
                      className={`text-[11px] ${
                        local ? "text-[var(--text-muted)]" : "text-[var(--status-warn)]"
                      }`}
                    >
                      {local ? "keyless" : "no key"}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--text-muted)]">
                  {provider.baseUrl} · {provider.models.length}{" "}
                  {provider.models.length === 1 ? "model" : "models"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void test(provider)}
                disabled={busy === provider.id}
                className="btn-secondary h-7 shrink-0 rounded-[7px] px-2.5 text-[12px]"
              >
                {busy === provider.id ? (
                  <Loader2 size={11} strokeWidth={1.5} className="animate-spin" />
                ) : (
                  <Zap size={11} strokeWidth={1.5} />
                )}
                Test
              </button>
              <button
                type="button"
                onClick={() => edit(provider)}
                className="btn-ghost h-7 shrink-0 rounded-[7px] px-2.5 text-[12px] font-medium"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void remove(provider)}
                className={`flex h-7 shrink-0 items-center justify-center rounded-[7px] transition-all ${
                  armed
                    ? "bg-[color-mix(in_srgb,var(--status-err)_12%,transparent)] px-2 text-[11.5px] font-medium text-[var(--status-err)]"
                    : "btn-icon w-7 rounded-full hover:text-[var(--status-err)]"
                }`}
                aria-label={armed ? "Confirm delete provider" : "Delete provider"}
                title={armed ? "Click again to delete" : "Delete provider"}
              >
                {armed ? "Delete?" : <Trash2 size={13} strokeWidth={1.5} />}
              </button>
            </div>
          );
        })}
        {providers.length === 0 && (
          <p className="rounded-[11px] border border-dashed hairline px-3 py-6 text-center text-[12.5px] text-[var(--text-muted)]">
            No providers configured yet.
          </p>
        )}
      </div>

      {form && (
        <div className="mt-4 rounded-[12px] border hairline bg-[var(--bg-subtle)] p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                placeholder="OpenRouter"
                className="settings-input"
              />
            </Field>
            <Field label="Identifier">
              <input
                value={form.id}
                onChange={(event) => setForm({ ...form, id: event.target.value })}
                placeholder="openrouter"
                className="settings-input font-mono"
              />
            </Field>
            <Field label="Protocol">
              <select
                value={form.protocol}
                onChange={(event) =>
                  setForm({ ...form, protocol: event.target.value as ProviderProtocol })
                }
                className="settings-input"
              >
                <option value="openai-completions">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generative-ai">Google Generative AI</option>
              </select>
            </Field>
            <Field label="Base URL">
              <input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
                className="settings-input font-mono"
              />
            </Field>
            <div className="col-span-2">
              <Field label="API key (stored in the system keychain)">
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  placeholder={
                    form.key
                      ? "Leave blank to keep the existing key"
                      : "Optional for local gateways like Ollama"
                  }
                  className="settings-input font-mono"
                />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Model IDs (one per line)">
                <textarea
                  value={form.modelIds}
                  onChange={(event) => setForm({ ...form, modelIds: event.target.value })}
                  rows={3}
                  placeholder={"gpt-4.1\nclaude-sonnet-4-5"}
                  className="settings-input resize-none font-mono"
                />
              </Field>
            </div>
            {(() => {
              const resolvedModels = resolveFormModels(form.modelIds, form.models);
              if (resolvedModels.length === 0) return null;
              return (
                <div className="col-span-2">
                  <span className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">
                    Model capabilities
                  </span>
                  <div className="thin-scroll max-h-36 space-y-1 overflow-y-auto rounded-[8px] border hairline bg-[var(--bg-canvas)] p-2">
                    {resolvedModels.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between gap-2 rounded-[6px] px-1.5 py-1"
                      >
                        <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--text-primary)]">
                          {model.id}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            aria-pressed={model.supportsVision}
                            onClick={() => toggleCapability(model.id, "supportsVision")}
                            className={`flex h-6 items-center gap-1 rounded-[6px] border px-2 text-[11px] transition-colors ${
                              model.supportsVision
                                ? "border-[var(--border-focus)] bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                                : "hairline text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                            }`}
                          >
                            <Eye size={11} strokeWidth={1.5} />
                            Vision
                          </button>
                          <button
                            type="button"
                            aria-pressed={model.supportsReasoning}
                            onClick={() => toggleCapability(model.id, "supportsReasoning")}
                            className={`flex h-6 items-center gap-1 rounded-[6px] border px-2 text-[11px] transition-colors ${
                              model.supportsReasoning
                                ? "border-[var(--border-focus)] bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                                : "hairline text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                            }`}
                          >
                            <Sparkles size={11} strokeWidth={1.5} />
                            Reasoning
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="mt-3.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy === "save"}
              className="btn-primary h-8 rounded-[8px] px-3.5 text-[12px]"
            >
              {busy === "save" ? "Saving…" : "Save provider"}
            </button>
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={busy === "fetch" || !form.baseUrl.trim()}
              className="btn-secondary h-8 rounded-[8px] px-3 text-[12px]"
            >
              {busy === "fetch" ? (
                <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
              ) : (
                <CloudDownload size={12} strokeWidth={1.5} />
              )}
              Fetch models
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="btn-ghost h-8 rounded-[8px] px-3 text-[12px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status && (
        <p
          className={`mt-3 text-[12px] ${
            status.tone === "error"
              ? "text-[var(--status-err)]"
              : status.tone === "ok"
                ? "text-[var(--status-ok)]"
                : "text-[var(--text-secondary)]"
          }`}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

function resolveFormModels(modelIdsText: string, existingModels: ProviderModel[]): ProviderModel[] {
  const existing = new Map(existingModels.map((model) => [model.id, model]));
  return splitIds(modelIdsText).map((modelId) => {
    const current = existing.get(modelId);
    return (
      current ?? {
        id: modelId,
        displayName: displayModelName(modelId),
        contextWindow: 200_000,
        maxOutputTokens: 65_536,
        supportsVision: true,
        supportsReasoning: false,
      }
    );
  });
}

function splitIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      {children}
    </label>
  );
}
