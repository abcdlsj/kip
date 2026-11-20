/**
 * The bundled plugin list. Adding a plugin means writing a module that implements `KipPlugin`
 * and adding it here; the Settings panel renders whatever fields it declares, so no view change
 * is needed.
 */
import type { KipDatabase } from "../storage/db";
import type { PluginSummary } from "../../shared/types";
import { gemini2apiPlugin } from "./gemini2api";
import type { KipPlugin } from "./types";

const PLUGINS: KipPlugin[] = [gemini2apiPlugin];

/** Saved values live under `plugin.<plugin>.<field>`. */
const SETTING_PREFIX = "plugin.";

function settingKey(plugin: KipPlugin, field: string): string {
  return `${SETTING_PREFIX}${plugin.id}.${field}`;
}

export function listPlugins(): KipPlugin[] {
  return PLUGINS;
}

export function findPlugin(id: string): KipPlugin | undefined {
  return PLUGINS.find((plugin) => plugin.id === id);
}

/** Secret fields are never stored, so they never appear here. */
export function readPluginValues(
  database: KipDatabase,
  plugin: KipPlugin,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of plugin.fields) {
    if (field.kind === "secret") continue;
    const stored = database.getSetting<string>(
      settingKey(plugin, field.name),
      "",
    );
    if (typeof stored === "string" && stored) values[field.name] = stored;
  }
  return values;
}

export function savePluginValues(
  database: KipDatabase,
  plugin: KipPlugin,
  values: Record<string, string>,
): void {
  for (const field of plugin.fields) {
    if (field.kind === "secret") continue;
    database.setSetting(
      settingKey(plugin, field.name),
      (values[field.name] ?? "").trim(),
    );
  }
}

export function pluginSummaries(database: KipDatabase): PluginSummary[] {
  return PLUGINS.map((plugin) => ({
    id: plugin.id,
    kind: plugin.kind,
    label: plugin.label,
    description: plugin.description,
    fields: plugin.fields,
    values: readPluginValues(database, plugin),
  }));
}
