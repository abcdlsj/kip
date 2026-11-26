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

export type GatewayStatusPhase =
  | "restarting"
  | "recovered"
  | "degraded"
  | "unhealthy";

export interface GatewayStatusNotice {
  phase: GatewayStatusPhase;
  message: string;
  attempt?: number;
  maxAttempts?: number;
}

/**
 * Per-request timeout guardrails for a local managed gateway. Remote API
 * providers (and plugins that omit this hook or return null) keep Pi's default
 * timeout behavior untouched.
 */
export interface GatewayRequestPolicy {
  /** Max time to wait for response headers / first stream event from the local process. */
  firstByteTimeoutMs: number;
  /** Max silence between consecutive stream events before treating the local stream as stalled. */
  streamIdleTimeoutMs: number;
}

export type GatewayFailureKind =
  | "stall"
  | "timeout"
  | "transport"
  | "server_error"
  | "unknown";

export interface GatewayRequestFailure {
  kind: GatewayFailureKind;
  message: string;
  /** True when Pi is about to retry this request automatically. */
  willRetry: boolean;
  attempt?: number;
  maxAttempts?: number;
}

export interface GatewayRecoveryResult {
  /** True when the gateway was restarted (or is now healthy) and the retry should proceed. */
  recovered: boolean;
  /** True when automatic recovery is exhausted so Pi should stop retrying immediately. */
  abortRetry?: boolean;
  /** Human-readable status or failure reason. */
  message?: string;
}

/** What the host hands a plugin that needs its own directory or settings. */
export interface PluginRuntimeContext {
  pluginId: string;
  /** A writable directory for this plugin: binaries, config, logs, state. */
  dataDir: string;
  /** The plugin's saved form values, read fresh on each call. */
  values: () => Record<string, string>;
  /** Optional status sink wired during an active run (GUI & CLI). */
  reportStatus?: (notice: GatewayStatusNotice) => void;
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
  /**
   * Called before a run sends anything to this provider, for a plugin whose
   * service may have been stopped while it was unused. Throwing here fails the
   * run with the reason instead of a bare connection error.
   */
  beforeRequest?(context: PluginRuntimeContext): void | Promise<void>;
  /** Called when that run ends, whether it worked or not. */
  afterRequest?(context: PluginRuntimeContext): void;
  /**
   * Returns tighter first-byte / stream-idle timeouts when this plugin is actively
   * managing a local process, or null when pointing at a remote/external server.
   */
  requestPolicy?(context: PluginRuntimeContext): GatewayRequestPolicy | null;
  /**
   * Called before each individual HTTP attempt (including Pi retries). Awaits any
   * in-flight recovery so retries hit the fresh process instead of racing.
   */
  beforeAttempt?(
    context: PluginRuntimeContext,
    signal?: AbortSignal,
  ): void | Promise<void>;
  /**
   * Called when a request to this provider fails (stall, timeout, transport error,
   * 5xx). A managed local gateway can classify the failure and restart its sidecar.
   */
  onRequestFailure?(
    context: PluginRuntimeContext,
    failure: GatewayRequestFailure,
  ): Promise<GatewayRecoveryResult | void> | GatewayRecoveryResult | void;
  /** Called when a request produces a healthy response, resetting failure pressure. */
  onRequestSuccess?(context: PluginRuntimeContext): void;
  /** Called after the user saves this plugin's form, so copied-out settings can be re-read. */
  settingsChanged?(context: PluginRuntimeContext): void;
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
