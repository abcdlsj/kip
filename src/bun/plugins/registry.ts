/**
 * Extensible plugin registry. Adding a plugin means implementing `GatewayPlugin`
 * or `TitlePlugin` and registering it here; the Settings -> Plugins panel renders
 * whatever fields and toggles each plugin declares without view edits.
 */
import type { KipDatabase } from "../storage/db";
import { getDataDir } from "../storage/db";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MarketplaceEntry, PluginSummary, ThreadMode } from "../../shared/types";
import { findMarketplaceEntry } from "../../shared/marketplace";
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

function acceptedKey(plugin: KipPlugin): string {
  return `${SETTING_PREFIX}${plugin.id}.acceptedAt`;
}

/** Each plugin owns a writable directory under Kip's data dir. */
export function pluginDataDir(pluginId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${pluginId}`);
  }
  const dir = join(getDataDir(), "plugins", pluginId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The catalog entry, synthesized for a plugin the catalog forgot. */
export function marketEntryFor(plugin: KipPlugin): MarketplaceEntry {
  return (
    findMarketplaceEntry(plugin.id) ?? {
      id: plugin.id,
      kind: plugin.kind,
      name: plugin.label,
      summary: plugin.description,
      version: "0",
      author: "unknown",
      permissions: [],
      window: plugin.kind === "gateway" && plugin.window !== undefined,
      builtin: true,
    }
  );
}

/**
 * A plugin that declares permissions must be accepted before it is started,
 * probed, or opened. A plugin that declares none (a pure form) needs no gate.
 */
export function isPluginAccepted(database: KipDatabase, plugin: KipPlugin): boolean {
  if (marketEntryFor(plugin).permissions.length === 0) return true;
  const accepted = database.getSetting<string>(acceptedKey(plugin), "");
  return typeof accepted === "string" && accepted.length > 0;
}

export function acceptPlugin(database: KipDatabase, plugin: KipPlugin): void {
  database.setSetting(acceptedKey(plugin), new Date().toISOString());
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
  const market = marketEntryFor(plugin);
  return {
    id: plugin.id,
    kind: plugin.kind,
    label: plugin.label,
    description: plugin.description,
    toggleable: plugin.kind === "title",
    enabled: isPluginEnabled(database, plugin),
    fields: plugin.fields,
    values: readPluginValues(database, plugin),
    market,
    accepted: isPluginAccepted(database, plugin),
    hasWindow: plugin.kind === "gateway" && plugin.window !== undefined && plugin.page !== undefined,
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
    if (!isPluginEnabled(database, plugin) || !isPluginAccepted(database, plugin)) continue;
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

/**
 * Gives accepted gateway plugins a chance to start background work at boot,
 * but only once their provider is registered — a plugin the user never used
 * must not spawn anything.
 */
export function startPlugins(database: KipDatabase): void {
  for (const plugin of defaultPluginRegistry.list()) {
    if (plugin.kind !== "gateway" || !plugin.start) continue;
    if (!isPluginAccepted(database, plugin)) continue;
    if (!database.getProvider(plugin.providerId)) continue;
    try {
      void Promise.resolve(
        plugin.start({
          pluginId: plugin.id,
          dataDir: pluginDataDir(plugin.id),
          values: () => readPluginValues(database, plugin),
        }),
      ).catch((error: unknown) => {
        console.error(`Plugin ${plugin.id}: start failed`, error);
      });
    } catch (error) {
      console.error(`Plugin ${plugin.id}: start failed`, error);
    }
  }
}

/** Releases any resources held by registered plugins during app shutdown. */
export async function disposePlugins(
  registry: PluginRegistry = defaultPluginRegistry,
): Promise<void> {
  for (const plugin of registry.list()) {
    if (plugin.kind !== "gateway" || !plugin.dispose) continue;
    try {
      await plugin.dispose();
    } catch {
      // Shutdown is best-effort.
    }
  }
}
