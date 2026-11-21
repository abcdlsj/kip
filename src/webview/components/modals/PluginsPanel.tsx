/**
 * Dedicated Plugins settings page. Renders both optional extensions (such as
 * AI Thread Titles, which users can freely enable or leave off) and local
 * model gateways from the same plugin registry without hardcoding each plugin.
 */
import { useEffect, useState } from "react";
import { Check, Loader2, Radar, Sparkles } from "lucide-react";
import type { PluginProbeResult, PluginSummary } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export function PluginsPanel() {
  const refreshProviders = useUiStore((state) => state.refreshProviders);
  const refreshSettings = useUiStore((state) => state.refresh);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, PluginProbeResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const list = await request("listPlugins", undefined);
      setPlugins(list);
      setValues(
        Object.fromEntries(
          list.map((plugin) => [plugin.id, { ...plugin.values }]),
        ),
      );
    })();
  }, []);

  const setValue = (pluginId: string, field: string, value: string) => {
    setValues((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [field]: value },
    }));
  };

  const togglePlugin = async (plugin: PluginSummary) => {
    const nextEnabled = !plugin.enabled;
    setSavingId(plugin.id);
    try {
      const updated = await request("updatePlugin", {
        plugin: plugin.id,
        enabled: nextEnabled,
        values: values[plugin.id] ?? {},
      });
      setPlugins((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } finally {
      setSavingId(null);
    }
  };

  const probe = async (plugin: PluginSummary) => {
    setBusy(plugin.id);
    try {
      const currentValues = values[plugin.id] ?? {};
      if (plugin.toggleable) {
        await request("updatePlugin", {
          plugin: plugin.id,
          values: currentValues,
        });
      }
      const result = await request("probePlugin", {
        plugin: plugin.id,
        values: currentValues,
      });
      setResults((current) => ({ ...current, [plugin.id]: result }));
      if (result.ok && plugin.kind === "gateway") {
        await refreshProviders();
        await refreshSettings();
        await refreshThreads();
      }
    } catch (error) {
      setResults((current) => ({
        ...current,
        [plugin.id]: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setBusy(null);
    }
  };

  const extensions = plugins.filter((plugin) => plugin.kind !== "gateway");
  const gateways = plugins.filter((plugin) => plugin.kind === "gateway");

  return (
    <div>
      <h2 className="text-[15px] font-semibold">Plugins</h2>
      <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
        Optional extensions and local gateways. Everything here is opt-in and
        can be turned off at any time.
      </p>

      {extensions.length > 0 && (
        <section className="mt-5">
          <h3 className="text-[12px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">
            Extensions
          </h3>
          <div className="mt-2.5 space-y-2.5">
            {extensions.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                values={values[plugin.id] ?? {}}
                result={results[plugin.id]}
                busy={busy === plugin.id}
                saving={savingId === plugin.id}
                onChange={(field, value) => setValue(plugin.id, field, value)}
                onToggle={() => void togglePlugin(plugin)}
                onAction={() => void probe(plugin)}
              />
            ))}
          </div>
        </section>
      )}

      {gateways.length > 0 && (
        <section className={extensions.length > 0 ? "mt-6 border-t hairline pt-5" : "mt-5"}>
          <h3 className="text-[12px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">
            Local gateways
          </h3>
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
            Servers running on this machine. Kip detects the service, reads its
            models, and keeps a key of its own in the keychain.
          </p>
          <div className="mt-2.5 space-y-2.5">
            {gateways.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                values={values[plugin.id] ?? {}}
                result={results[plugin.id]}
                busy={busy === plugin.id}
                saving={false}
                onChange={(field, value) => setValue(plugin.id, field, value)}
                onAction={() => void probe(plugin)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface PluginCardProps {
  plugin: PluginSummary;
  values: Record<string, string>;
  result?: PluginProbeResult;
  busy: boolean;
  saving: boolean;
  onChange: (field: string, value: string) => void;
  onToggle?: () => void;
  onAction: () => void;
}

function PluginCard({
  plugin,
  values,
  result,
  busy,
  saving,
  onChange,
  onToggle,
  onAction,
}: PluginCardProps) {
  const missing = new Map(
    (result?.missing ?? []).map((item) => [item.field, item.message]),
  );
  const isGateway = plugin.kind === "gateway";

  return (
    <div
      className={`rounded-[11px] border px-3.5 py-3 transition-colors ${
        plugin.toggleable && plugin.enabled
          ? "border-[var(--border-focus)] bg-[var(--bg-subtle)]"
          : "hairline"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-[var(--text-primary)]">
              {plugin.label}
            </span>
            {result?.ok && (
              <span className="flex items-center gap-0.5 text-[11px] text-[var(--status-ok)]">
                <Check size={10} strokeWidth={2} />
                {isGateway ? "registered" : "connected"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            {plugin.description}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {plugin.toggleable && onToggle && (
            <button
              type="button"
              role="switch"
              aria-checked={plugin.enabled}
              aria-label={`Enable ${plugin.label}`}
              disabled={saving}
              onClick={onToggle}
              className={`flex h-8 items-center gap-2 rounded-[8px] border px-2.5 text-[12px] transition-colors ${
                plugin.enabled
                  ? "border-[var(--border-focus)] bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                  : "hairline text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              <span>{plugin.enabled ? "On" : "Off"}</span>
              <span
                className={`h-3 w-3 rounded-full transition-colors ${
                  plugin.enabled
                    ? "bg-[var(--status-ok)]"
                    : "bg-[var(--border-focus)]"
                }`}
              />
            </button>
          )}
          <button
            type="button"
            onClick={onAction}
            disabled={busy}
            className="btn-secondary h-8 shrink-0 rounded-[8px] px-3 text-[12px]"
          >
            {busy ? (
              <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
            ) : isGateway ? (
              <Radar size={12} strokeWidth={1.5} />
            ) : (
              <Sparkles size={12} strokeWidth={1.5} />
            )}
            {isGateway ? "Detect" : "Save & Test"}
          </button>
        </div>
      </div>

      {plugin.fields.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {plugin.fields.map((field) => (
            <label key={field.name} className="min-w-[120px] flex-1">
              <span className="mb-1 block text-[11.5px] font-medium text-[var(--text-secondary)]">
                {field.label}
                {field.optional && (
                  <span className="ml-1 font-normal text-[var(--text-muted)]">
                    optional
                  </span>
                )}
              </span>
              {field.kind === "select" ? (
                <select
                  value={values[field.name] ?? ""}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  className="settings-input"
                >
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.kind === "toggle" ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={values[field.name] === "true"}
                  onClick={() =>
                    onChange(
                      field.name,
                      values[field.name] === "true" ? "false" : "true",
                    )
                  }
                  className={`flex h-8 w-full items-center justify-between rounded-[8px] border px-2.5 text-[12px] transition-colors ${
                    values[field.name] === "true"
                      ? "border-[var(--border-focus)] bg-[var(--bg-subtle)] font-medium text-[var(--text-primary)]"
                      : "hairline text-[var(--text-muted)]"
                  }`}
                >
                  <span>{values[field.name] === "true" ? "On" : "Off"}</span>
                  <span
                    className={`h-3.5 w-3.5 rounded-full ${
                      values[field.name] === "true"
                        ? "bg-[var(--status-ok)]"
                        : "bg-[var(--border-focus)]"
                    }`}
                  />
                </button>
              ) : (
                <input
                  type={field.kind === "secret" ? "password" : "text"}
                  inputMode={field.kind === "port" ? "numeric" : undefined}
                  value={values[field.name] ?? ""}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  placeholder={field.placeholder}
                  className="settings-input font-mono"
                />
              )}
              {(missing.get(field.name) ?? field.help) && (
                <span
                  className={`mt-1 block text-[11px] ${
                    missing.has(field.name)
                      ? "text-[var(--status-warn)]"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  {missing.get(field.name) ?? field.help}
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      {result && !result.ok && result.error && (
        <p className="mt-2 text-[11.5px] text-[var(--status-err)]">
          {result.error}
        </p>
      )}
      {result?.ok && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          <span className="text-[var(--text-secondary)]">{result.summary}</span>
          {(result.details ?? []).map((detail) => (
            <span key={detail.label} className="text-[var(--text-muted)]">
              {detail.label}:{" "}
              <span className="font-mono text-[var(--text-secondary)]">
                {detail.value}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
