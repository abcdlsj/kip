/**
 * Extensible gateway plugin registry. Adding a plugin means implementing
 * `KipPlugin` and registering it here (or dynamically via `PluginRegistry`);
 * the Settings panel renders whatever fields it declares without view edits.
 */
import type { KipDatabase } from "../storage/db";
import type { PluginSummary } from "../../shared/types";
import { gemini2apiPlugin } from "./gemini2api";
import type { KipPlugin } from "./types";

/** Saved values live under `plugin.<plugin>.<field>`. */
const SETTING_PREFIX = "plugin.";

function settingKey(plugin: KipPlugin, field: string): string {
  return `${SETTING_PREFIX}${plugin.id}.${field}`;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, KipPlugin>();

  constructor(initial: KipPlugin[] = []) {
    for (const plugin of initial) {
      this.plugins.set(plugin.id, plugin);
    }
  }

  register(plugin: KipPlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): void {
    this.plugins.delete(id);
  }

  list(): KipPlugin[] {
    return [...this.plugins.values()];
  }

  find(id: string): KipPlugin | undefined {
    return this.plugins.get(id);
  }

  summaries(database: KipDatabase): PluginSummary[] {
    return this.list().map((plugin) => ({
      id: plugin.id,
      kind: plugin.kind,
      label: plugin.label,
      description: plugin.description,
      fields: plugin.fields,
      values: readPluginValues(database, plugin),
    }));
  }
}

export const defaultPluginRegistry = new PluginRegistry([gemini2apiPlugin]);

export function listPlugins(): KipPlugin[] {
  return defaultPluginRegistry.list();
}

export function findPlugin(id: string): KipPlugin | undefined {
  return defaultPluginRegistry.find(id);
}

/** Secret fields are never stored, so they never appear here. */
export function readPluginValues(
  database: KipDatabase,
  plugin: KipPlugin,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of plugin.fields) {
    if (field.kind === "secret") continue;
    const stored = database.getSetting<string>(settingKey(plugin, field.name), "");
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
    database.setSetting(settingKey(plugin, field.name), (values[field.name] ?? "").trim());
  }
}

export function pluginSummaries(database: KipDatabase): PluginSummary[] {
  return defaultPluginRegistry.summaries(database);
}
