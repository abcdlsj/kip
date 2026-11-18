import { useState, type ReactNode } from "react";
import { Check, CloudDownload, Loader2, Plus, Trash2, Zap } from "lucide-react";
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

export function ProvidersPanel({ providers }: ProvidersPanelProps) {
  const refreshProviders = useUiStore((state) => state.refreshProviders);
  const refreshSettings = useUiStore((state) => state.refresh);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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
    const modelIds = splitIds(form.modelIds);
    if (!id || !form.baseUrl.trim() || modelIds.length === 0) {
      setStatus("A name, base URL, and at least one model are required.");
      return;
    }
    setBusy("save");
    try {
      const existing = new Map(form.models.map((model) => [model.id, model]));
      const models: ProviderModel[] = modelIds.map((modelId) => {
        const current = existing.get(modelId);
        return (
          current ?? {
            id: modelId,
            displayName: displayModelName(modelId),
            contextWindow: 200_000,
            maxOutputTokens: 65_536,
            supportsVision: false,
            supportsReasoning: false,
          }
        );
      });
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
      setStatus("Provider saved.");
    } finally {
      setBusy(null);
    }
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
        setForm({
          ...form,
          models: result.models,
          modelIds: result.models.map((model) => model.id).join("\n"),
        });
        setStatus(`Found ${result.models.length} models.`);
      } else {
        setStatus(result.error || "No models returned.");
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: ProviderRecord) => {
    setBusy(provider.id);
    try {
      await request("deleteProvider", { provider: provider.id });
      await refreshProviders();
      await refreshSettings();
      setStatus(`${provider.displayName} removed.`);
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
          ? `${provider.displayName} connected · ${result.latencyMs}ms`
          : `${provider.displayName}: ${result.error ?? "Connection failed"}`,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">Model providers</h2>
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
            Any endpoint that speaks the OpenAI, Anthropic, or Google wire format.
          </p>
        </div>
        <button
          onClick={() => {
            setForm({ ...EMPTY });
            setStatus(null);
          }}
          className="flex h-8 items-center gap-1.5 rounded-full bg-[var(--accent-action)] px-3 text-[12px] font-medium text-[var(--accent-action-fg)]"
        >
          <Plus size={13} strokeWidth={1.5} />
          Add provider
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="flex items-center gap-3 rounded-[10px] border hairline px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{provider.displayName}</span>
                <span className="rounded-full bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                  {provider.protocol}
                </span>
                {provider.hasApiKey ? (
                  <span className="flex items-center gap-0.5 text-[11px] text-[var(--status-ok)]">
                    <Check size={10} strokeWidth={2} /> key
                  </span>
                ) : (
                  <span className="text-[11px] text-[var(--status-warn)]">no key</span>
                )}
              </div>
              <p className="mt-0.5 truncate font-[var(--font-mono)] text-[11.5px] text-[var(--text-muted)]">
                {provider.baseUrl} · {provider.models.length} models
              </p>
            </div>
            <button
              onClick={() => void test(provider)}
              disabled={busy === provider.id}
              className="flex h-7 items-center gap-1 rounded-full border hairline px-2.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
            >
              {busy === provider.id ? (
                <Loader2 size={11} strokeWidth={1.5} className="animate-spin" />
              ) : (
                <Zap size={11} strokeWidth={1.5} />
              )}
              Test
            </button>
            <button
              onClick={() => edit(provider)}
              className="h-7 rounded-full px-2.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
            >
              Edit
            </button>
            <button
              onClick={() => void remove(provider)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--status-err)]"
              aria-label="Delete provider"
            >
              <Trash2 size={12} strokeWidth={1.5} />
            </button>
          </div>
        ))}
        {providers.length === 0 && (
          <p className="rounded-[10px] border border-dashed hairline px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            No providers configured yet.
          </p>
        )}
      </div>

      {form && (
        <div className="mt-4 rounded-[12px] border hairline bg-[var(--bg-subtle)] p-3.5">
          <div className="grid grid-cols-2 gap-2.5">
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
                className="settings-input font-[var(--font-mono)]"
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
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <div className="col-span-2">
              <Field label="API key (stored in the system keychain)">
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  placeholder="Leave blank to keep the existing key"
                  className="settings-input font-[var(--font-mono)]"
                />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Model IDs (one per line)">
                <textarea
                  value={form.modelIds}
                  onChange={(event) => setForm({ ...form, modelIds: event.target.value })}
                  rows={3}
                  placeholder="gpt-4.1&#10;claude-sonnet-4-5"
                  className="settings-input resize-none font-[var(--font-mono)]"
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={busy === "save"}
              className="h-8 rounded-full bg-[var(--accent-action)] px-3.5 text-[12px] font-medium text-[var(--accent-action-fg)]"
            >
              {busy === "save" ? "Saving..." : "Save provider"}
            </button>
            <button
              onClick={() => void fetchModels()}
              disabled={busy === "fetch" || !form.baseUrl}
              className="flex h-8 items-center gap-1.5 rounded-full border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
            >
              {busy === "fetch" ? (
                <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
              ) : (
                <CloudDownload size={12} strokeWidth={1.5} />
              )}
              Fetch models
            </button>
            <button
              onClick={() => setForm(null)}
              className="h-8 rounded-full px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status && (
        <p className="mt-3 text-[12px] text-[var(--text-secondary)]">{status}</p>
      )}
    </div>
  );
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
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
