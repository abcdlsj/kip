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
  fields: PluginField[];
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
