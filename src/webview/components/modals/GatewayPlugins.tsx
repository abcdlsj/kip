/**
 * Local gateway plugins. The view renders whatever fields a plugin declares, so a new plugin
 * appears here without a change to this file.
 */
import { useEffect, useState } from "react";
import { Check, Loader2, Radar } from "lucide-react";
import type { PluginProbeResult, PluginSummary } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export function GatewayPlugins() {
  const refreshProviders = useUiStore((state) => state.refreshProviders);
  const refreshSettings = useUiStore((state) => state.refresh);
  const refreshThreads = useWorkspaceStore((state) => state.refreshThreads);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [results, setResults] = useState<Record<string, PluginProbeResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const list = await request("listGatewayPlugins", undefined);
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

  const detect = async (plugin: PluginSummary) => {
    setBusy(plugin.id);
    try {
      const result = await request("probeGatewayPlugin", {
        plugin: plugin.id,
        values: values[plugin.id] ?? {},
      });
      setResults((current) => ({ ...current, [plugin.id]: result }));
      if (result.ok) {
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

  if (plugins.length === 0) return null;

  return (
    <div className="mt-6 border-t hairline pt-5">
      <h2 className="text-[15px] font-semibold">Local gateways</h2>
      <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
        Servers running on this machine. Kip finds the service, reads its
        models, and keeps a key of its own in the keychain.
      </p>

      <div className="mt-3 space-y-2">
        {plugins.map((plugin) => {
          const result = results[plugin.id];
          const missing = new Map(
            (result?.missing ?? []).map((item) => [item.field, item.message]),
          );
          return (
            <div
              key={plugin.id}
              className="rounded-[10px] border hairline px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">
                      {plugin.label}
                    </span>
                    {result?.ok && (
                      <span className="flex items-center gap-0.5 text-[11px] text-[var(--status-ok)]">
                        <Check size={10} strokeWidth={2} /> registered
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                    {plugin.description}
                  </p>
                </div>
                <button
                  onClick={() => void detect(plugin)}
                  disabled={busy === plugin.id}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
                >
                  {busy === plugin.id ? (
                    <Loader2
                      size={12}
                      strokeWidth={1.5}
                      className="animate-spin"
                    />
                  ) : (
                    <Radar size={12} strokeWidth={1.5} />
                  )}
                  Detect
                </button>
              </div>

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
                    <input
                      type={field.kind === "secret" ? "password" : "text"}
                      inputMode={field.kind === "port" ? "numeric" : undefined}
                      value={values[plugin.id]?.[field.name] ?? ""}
                      onChange={(event) =>
                        setValue(plugin.id, field.name, event.target.value)
                      }
                      placeholder={field.placeholder}
                      className="settings-input font-[var(--font-mono)]"
                    />
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

              {result && !result.ok && result.error && (
                <p className="mt-2 text-[11.5px] text-[var(--status-err)]">
                  {result.error}
                </p>
              )}
              {result?.ok && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                  <span className="text-[var(--text-secondary)]">
                    {result.summary}
                  </span>
                  {(result.details ?? []).map((detail) => (
                    <span
                      key={detail.label}
                      className="text-[var(--text-muted)]"
                    >
                      {detail.label}:{" "}
                      <span className="font-[var(--font-mono)] text-[var(--text-secondary)]">
                        {detail.value}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
