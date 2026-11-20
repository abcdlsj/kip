import type {
  PluginField,
  PluginProbeResult,
  ProviderModel,
  ProviderProtocol,
} from "../../shared/types";

export interface PluginProbeContext {
  /** A key Kip already holds for this plugin's provider; tried before asking for another. */
  storedApiKey?: string;
}

/** What a successful probe hands to the app: a provider it can save as-is. */
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

/**
 * The contract every bundled plugin implements. A plugin owns exactly one provider record
 * (`providerId`), declares the fields its probe needs, and does all of its own talking: the app
 * only renders the fields, saves values, and stores the resulting provider and key.
 */
export interface KipPlugin {
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
