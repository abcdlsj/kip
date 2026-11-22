/**
 * Extensible plugin registry. Adding a plugin means implementing `GatewayPlugin`
 * or `TitlePlugin` and registering it here; the Settings -> Plugins panel renders
 * whatever fields and toggles each plugin declares without view edits.
 */
import type { KipDatabase } from "../storage/db";
import type { PluginSummary, ThreadMode } from "../../shared/types";
import { gemini2apiPlugin } from "./gemini2api";
import type { KipPlugin, GatewayPlugin, TitleGenerationInput, TitlePlugin } from "./types";
import { warrenTitlePlugin } from "./warren-title";

/** Saved values live under `plugin.<plugin>.<field>`. */
const SETTING_PREFIX = "plugin.";

function settingKey(plugin: KipPlugin, field: string): string {
  return `${SETTING_PREFIX}${plugin.id}.${field}`;
}

function enabledKey(plugin: KipPlugin): string {
  return `${SETTING_PREFIX}${plugin.id}.enabled`;
}

function deviceIdKey(plugin: KipPlugin): string {
  return `${SETTING_PREFIX}${plugin.id}.deviceId`;
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
    return this.list().map((plugin) => toPluginSummary(database, plugin));
  }
}

export const defaultPluginRegistry = new PluginRegistry([
  warrenTitlePlugin,
  gemini2apiPlugin,
]);

export function listPlugins(): KipPlugin[] {
  return defaultPluginRegistry.list();
}

export function findPlugin(id: string): KipPlugin | undefined {
  return defaultPluginRegistry.find(id);
}

/**
 * Providers whose plugin offers Chat threads, with the mode their new threads
 * start in. Every other provider only ever creates agent threads.
 */
export interface ChatModeSupport {
  providerId: string;
  defaultMode: ThreadMode;
}

/** The plugin field that holds a gateway's default thread mode. */
export const PLUGIN_THREAD_MODE_FIELD = "threadMode";

function gatewayPluginsOfferingChat(): GatewayPlugin[] {
  return defaultPluginRegistry
    .list()
    .filter(
      (plugin): plugin is GatewayPlugin =>
        plugin.kind === "gateway" && plugin.chatThreads === true,
    );
}

function readDefaultThreadMode(database: KipDatabase, plugin: GatewayPlugin): ThreadMode {
  const stored = database.getSetting<string>(settingKey(plugin, PLUGIN_THREAD_MODE_FIELD), "");
  return stored === "agent" ? "agent" : "chat";
}

export function chatModeSupport(database: KipDatabase): ChatModeSupport[] {
  return gatewayPluginsOfferingChat().map((plugin) => ({
    providerId: plugin.providerId,
    defaultMode: readDefaultThreadMode(database, plugin),
  }));
}

/**
 * The mode a new thread starts in: the plugin's saved default where the provider
 * offers Chat, Agent everywhere else. A per-thread request wins; asking for Chat
 * from a provider without the capability falls back to Agent.
 */
export function resolveNewThreadMode(
  database: KipDatabase,
  providerId: string,
  requested?: ThreadMode,
): ThreadMode {
  const support = chatModeSupport(database).find((item) => item.providerId === providerId);
  if (!support) return "agent";
  if (requested === "agent" || requested === "chat") return requested;
  return support.defaultMode;
}

export function isPluginEnabled(database: KipDatabase, plugin: KipPlugin): boolean {
  if (plugin.kind !== "title") return true;
  return database.getSetting<boolean>(enabledKey(plugin), plugin.defaultEnabled ?? false) === true;
}

export function setPluginEnabled(
  database: KipDatabase,
  plugin: KipPlugin,
  enabled: boolean,
): void {
  database.setSetting(enabledKey(plugin), enabled);
}

export function getOrCreatePluginDeviceId(database: KipDatabase, plugin: KipPlugin): string {
  const existing = database.getSetting<string>(deviceIdKey(plugin), "");
  if (typeof existing === "string" && existing.trim().length >= 8) {
    return existing.trim();
  }
  const created = `kip-${crypto.randomUUID()}`;
  database.setSetting(deviceIdKey(plugin), created);
  return created;
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
    if (!(field.name in values)) continue;
    database.setSetting(settingKey(plugin, field.name), (values[field.name] ?? "").trim());
  }
}

export function toPluginSummary(database: KipDatabase, plugin: KipPlugin): PluginSummary {
  return {
    id: plugin.id,
    kind: plugin.kind,
    label: plugin.label,
    description: plugin.description,
    toggleable: plugin.kind === "title",
    enabled: isPluginEnabled(database, plugin),
    fields: plugin.fields,
    values: readPluginValues(database, plugin),
  };
}

export function pluginSummaries(database: KipDatabase): PluginSummary[] {
  return defaultPluginRegistry.summaries(database);
}

/**
 * Runs the first enabled title plugin and returns its title, or `null` when
 * no title plugin is enabled or the request fails. Never throws.
 */
export async function generateTitleWithPlugins(
  database: KipDatabase,
  input: TitleGenerationInput,
  registry: PluginRegistry = defaultPluginRegistry,
): Promise<string | null> {
  const titlePlugins = registry
    .list()
    .filter((plugin): plugin is TitlePlugin => plugin.kind === "title");
  for (const plugin of titlePlugins) {
    if (!isPluginEnabled(database, plugin)) continue;
    const values = readPluginValues(database, plugin);
    const deviceId = getOrCreatePluginDeviceId(database, plugin);
    try {
      const title = await plugin.generateTitle(input, values, { deviceId });
      if (title) return title;
    } catch {
      // Best-effort: a failing plugin never breaks thread execution.
    }
  }
  return null;
}
