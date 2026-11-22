/**
 * The plugin catalog and its settings. Everything a plugin declares is rendered
 * here — form fields, the window it can open, and the catalog entry that names
 * its author, version, and what it may touch. Nothing in this file knows what a
 * particular plugin does.
 */
import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Radar, ShieldAlert, Sparkles, SquareArrowOutUpRight } from "lucide-react";
import type { PluginMarketplace, PluginProbeResult, PluginSummary } from "../../../shared/types";
import { permissionLabel } from "../../../shared/marketplace";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export function PluginsPanel() {
  const refreshProviders = useUiStore((state) => state.refreshProviders);
  const refreshSettings = useUiStore((state) => state.refresh);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const [market, setMarket] = useState<PluginMarketplace | null>(null);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, PluginProbeResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  /** The plugin whose permission sheet is open. */
  const [reviewing, setReviewing] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [catalog, list] = await Promise.all([
        request("getMarketplace", undefined),
        request("listPlugins", undefined),
      ]);
      setMarket(catalog);
      setPlugins(list);
      setValues(
        Object.fromEntries(list.map((plugin) => [plugin.id, { ...plugin.values }])),
      );
    })();
  }, []);

  const setValue = (pluginId: string, field: string, value: string) => {
    setValues((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [field]: value },
    }));
  };

  /**
   * Gateway field edits take effect without pressing Detect: the default thread
   * mode, for example, is read as soon as it changes. Secrets are skipped by
   * `savePluginValues`, so nothing sensitive is written here.
   */
  const commitValues = async (plugin: PluginSummary, next: Record<string, string>) => {
    if (plugin.kind !== "gateway") return;
    try {
      const updated = await request("updatePlugin", {
        plugin: plugin.id,
        values: next,
      });
      setPlugins((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await refreshSettings();
    } catch {
      // A failed save must not interrupt editing; the next Detect retries it.
    }
  };

  const accept = async (plugin: PluginSummary) => {
    const updated = await request("updatePlugin", { plugin: plugin.id, accepted: true });
    setPlugins((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setReviewing(null);
  };

  const togglePlugin = async (plugin: PluginSummary) => {
    if (!plugin.accepted) {
      setReviewing(plugin.id);
      return;
    }
    const nextEnabled = !plugin.enabled;
    setSavingId(plugin.id);
    try {
      const updated = await request("updatePlugin", {
        plugin: plugin.id,
        enabled: nextEnabled,
        values: values[plugin.id] ?? {},
      });
      setPlugins((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } finally {
      setSavingId(null);
    }
  };

  const probe = async (plugin: PluginSummary) => {
    setBusy(plugin.id);
    try {
      const currentValues = values[plugin.id] ?? {};
      if (plugin.toggleable) {
        await request("updatePlugin", { plugin: plugin.id, values: currentValues });
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

  const openWindow = async (plugin: PluginSummary) => {
    try {
      await request("openPluginWindow", { plugin: plugin.id });
    } catch (error) {
      setResults((current) => ({
        ...current,
        [plugin.id]: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const extensions = plugins.filter((plugin) => plugin.kind !== "gateway");
  const gateways = plugins.filter((plugin) => plugin.kind === "gateway");

  return (
    <div>
      <h2 className="text-[15px] font-semibold">Plugins</h2>
      <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
        Optional extensions and local gateways. Everything here is opt-in and can be turned off
        at any time.
      </p>

      {market && (
        <div className="mt-4 rounded-[11px] border border-[color-mix(in_srgb,var(--status-warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--status-warn)_7%,transparent)] px-3.5 py-2.5">
          <div className="flex items-start gap-2">
            <ShieldAlert
              size={13}
              strokeWidth={1.6}
              className="mt-[2px] shrink-0 text-[var(--status-warn)]"
            />
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-[var(--text-primary)]">
                You are responsible for the plugins you enable
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                {market.notice}
              </p>
            </div>
          </div>
        </div>
      )}

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
                reviewing={reviewing === plugin.id}
                onChange={(field, value) => setValue(plugin.id, field, value)}
                onToggle={() => void togglePlugin(plugin)}
                onAction={() => void probe(plugin)}
                onReview={() => setReviewing(plugin.id)}
                onAccept={() => void accept(plugin)}
                onOpen={() => void openWindow(plugin)}
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
            Servers running on this machine. A gateway runs its own program; its window shows
            what it is doing and owns its settings.
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
                reviewing={reviewing === plugin.id}
                onChange={(field, value) => setValue(plugin.id, field, value)}
                onCommit={(next) => void commitValues(plugin, next)}
                onAction={() => void probe(plugin)}
                onReview={() => setReviewing(plugin.id)}
                onAccept={() => void accept(plugin)}
                onOpen={() => void openWindow(plugin)}
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
  reviewing: boolean;
  onChange: (field: string, value: string) => void;
  onCommit?: (values: Record<string, string>) => void;
  onToggle?: () => void;
  onAction: () => void;
  onReview: () => void;
  onAccept: () => void;
  onOpen: () => void;
}

function PluginCard({
  plugin,
  values,
  result,
  busy,
  saving,
  reviewing,
  onChange,
  onCommit,
  onToggle,
  onAction,
  onReview,
  onAccept,
  onOpen,
}: PluginCardProps) {
  const missing = new Map((result?.missing ?? []).map((item) => [item.field, item.message]));
  const isGateway = plugin.kind === "gateway";
  const market = plugin.market;

  return (
    <div
      className={`rounded-[11px] border px-3.5 py-3 transition-colors ${
        (plugin.toggleable && plugin.enabled) || plugin.hasWindow
          ? "border-[var(--border-focus)] bg-[var(--bg-subtle)]"
          : "hairline"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-[var(--text-primary)]">
              {market.name}
            </span>
            <span className="text-[10.5px] text-[var(--text-muted)]">v{market.version}</span>
            {result?.ok && (
              <span className="flex items-center gap-0.5 text-[11px] text-[var(--status-ok)]">
                <Check size={10} strokeWidth={2} />
                {isGateway ? "registered" : "connected"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            {market.summary}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {market.permissions.map((permission) => (
              <span
                key={permission}
                className="rounded-full bg-[var(--bg-sidebar)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
              >
                {permissionLabel(permission)}
              </span>
            ))}
            <span className="text-[10.5px] text-[var(--text-muted)]">
              by {market.author} · not audited by Kip
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {market.homepage && (
            <a
              href={market.homepage}
              target="_blank"
              rel="noreferrer"
              title={market.homepage}
              className="btn-ghost h-8 w-8 justify-center rounded-[8px] p-0 text-[var(--text-muted)]"
            >
              <ExternalLink size={12} strokeWidth={1.5} />
            </a>
          )}
          {plugin.hasWindow && (
            <button
              type="button"
              onClick={plugin.accepted ? onOpen : onReview}
              className="btn-secondary h-8 shrink-0 rounded-[8px] px-3 text-[12px]"
              title="Open this plugin's own window"
            >
              <SquareArrowOutUpRight size={12} strokeWidth={1.5} />
              Open
            </button>
          )}
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
                  plugin.enabled ? "bg-[var(--status-ok)]" : "bg-[var(--border-focus)]"
                }`}
              />
            </button>
          )}
          {plugin.accepted ? (
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
          ) : (
            <button
              type="button"
              onClick={onReview}
              className="btn-secondary h-8 shrink-0 rounded-[8px] px-3 text-[12px]"
            >
              <ShieldAlert size={12} strokeWidth={1.5} />
              Review
            </button>
          )}
        </div>
      </div>

      {reviewing && (
        <div className="mt-3 rounded-[9px] border border-[color-mix(in_srgb,var(--status-warn)_30%,transparent)] bg-[var(--bg-elevated)] px-3 py-2.5">
          <p className="text-[12px] font-medium text-[var(--text-primary)]">
            Allow {market.name}?
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            {market.summary}
          </p>
          <ul className="mt-2 space-y-1">
            {market.permissions.map((permission) => (
              <li
                key={permission}
                className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]"
              >
                <span className="h-1 w-1 rounded-full bg-[var(--status-warn)]" aria-hidden />
                {permissionLabel(permission)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {market.name} runs with Kip's own privileges. Its author is responsible for what it
            does; Kip does not audit it. You can revoke this by clearing the plugin's settings.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onAccept}
              className="btn-secondary h-7 rounded-[7px] px-2.5 text-[11.5px]"
            >
              I understand, allow
            </button>
          </div>
        </div>
      )}

      {plugin.fields.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {plugin.fields.map((field) => (
            <label key={field.name} className="min-w-[120px] flex-1">
              <span className="mb-1 block text-[11.5px] font-medium text-[var(--text-secondary)]">
                {field.label}
                {field.optional && (
                  <span className="ml-1 font-normal text-[var(--text-muted)]">optional</span>
                )}
              </span>
              {field.kind === "select" ? (
                <select
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    onChange(field.name, event.target.value);
                    onCommit?.({ ...values, [field.name]: event.target.value });
                  }}
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
                  onClick={() => {
                    const next = values[field.name] === "true" ? "false" : "true";
                    onChange(field.name, next);
                    onCommit?.({ ...values, [field.name]: next });
                  }}
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
                  onBlur={() => onCommit?.(values)}
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
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--status-err)]">
          {result.error}
        </p>
      )}
    </div>
  );
}
