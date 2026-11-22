import type {
  PluginField,
  PluginProbeResult,
  ProviderModel,
  ProviderProtocol,
} from "../../shared/types";

export interface PluginProbeContext {
  /** A key Kip already holds for this plugin's provider; tried before asking for another. */
  storedApiKey?: string;
  /** Persistent per-device identifier for rate-limited hosted plugins. */
  deviceId?: string;
  /** A writable directory for this plugin, created before the call. */
  dataDir?: string;
}

/** What a successful gateway probe hands to the app: a provider it can save as-is. */
export interface PluginProposal {
  providerId: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: ProviderModel[];
  /** A key minted for Kip. Goes to the keychain; never written to SQLite or logs. */
  apiKey?: string;
}

export interface PluginProbeOutcome extends PluginProbeResult {
  proposal?: PluginProposal;
}

export interface TitleMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TitleGenerationInput {
  mode: "initial" | "conversation";
  messages: TitleMessage[];
}

export interface TitlePluginContext {
  deviceId: string;
}

/**
 * Where a plugin's own window lives in the app bundle. `page` is relative to
 * the bundle's views folder, e.g. `plugins/gemini2api/index.html`.
 */
export interface PluginWindowSpec {
  page: string;
  title?: string;
  width?: number;
  height?: number;
}

/** What the host hands a plugin that needs its own directory or settings. */
export interface PluginRuntimeContext {
  pluginId: string;
  /** A writable directory for this plugin: binaries, config, logs, state. */
  dataDir: string;
  /** The plugin's saved form values, read fresh on each call. */
  values: () => Record<string, string>;
}

/** What the host hands a plugin that wants a window of its own. */
export interface PluginPageContext extends PluginRuntimeContext {
  /** Ask the host to push a fresh snapshot to the open page. */
  emit: () => void;
}

/**
 * A plugin page is a state getter plus named actions. The page speaks the same
 * names; the host only forwards them, so no host code knows what an action does.
 */
export interface PluginPageController {
  state(): unknown | Promise<unknown>;
  act(action: string, input?: unknown): unknown | Promise<unknown>;
  /** Called once when the page closes. Release processes here, not in `act`. */
  dispose?(): void | Promise<void>;
}

/**
 * A local gateway plugin owns one provider record (`providerId`) and discovers
 * models from a service running on the user's machine.
 */
export interface GatewayPlugin {
  id: string;
  kind: "gateway";
  label: string;
  description: string;
  /** The provider record this plugin owns; its key is fetched from the keychain by this id. */
  providerId: string;
  /**
   * Offers Chat threads for this provider: a switch in the composer, plus a
   * chat-by-default mode for new threads. The capability lives in the core; only
   * a plugin that opts in gets the switch, because it only makes sense where the
   * conversation is the product.
   */
  chatThreads?: boolean;
  fields: PluginField[];
  /** Declared only by plugins that ship a page in the app bundle. */
  window?: PluginWindowSpec;
  /** Built alongside `window`: the state and actions that page talks to. */
  page?: (context: PluginPageContext) => PluginPageController;
  /**
   * Called once at startup, before any page exists, for a plugin whose provider
   * the user has registered. Starting a background service here is what makes a
   * saved provider usable again after a restart.
   */
  start?(context: PluginRuntimeContext): void | Promise<void>;
  /** Called on app shutdown so plugins that started background processes can stop them. */
  dispose?(): void | Promise<void>;
  probe(
    values: Record<string, string>,
    context: PluginProbeContext,
  ): Promise<PluginProbeOutcome>;
}

/**
 * A title plugin names threads asynchronously when enabled by the user.
 * Failing or hitting a quota returns `null` so Kip keeps its instant local title.
 */
export interface TitlePlugin {
  id: string;
  kind: "title";
  label: string;
  description: string;
  defaultEnabled?: boolean;
  fields: PluginField[];
  probe(
    values: Record<string, string>,
    context: PluginProbeContext,
  ): Promise<PluginProbeResult>;
  generateTitle(
    input: TitleGenerationInput,
    values: Record<string, string>,
    context: TitlePluginContext,
  ): Promise<string | null>;
}

export type KipPlugin = GatewayPlugin | TitlePlugin;
