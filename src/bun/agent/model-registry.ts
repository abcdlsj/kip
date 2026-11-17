/**
 * Bridges providers stored by the app into Pi's model runtime. Only provider
 * metadata lives in SQLite; keys are resolved from the secure store at runtime.
 */
import type { Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelOption, ProviderModel, ProviderProtocol, ProviderRecord } from "../../shared/types";
import type { KipDatabase } from "../storage/db";
import { getApiKey } from "../storage/keychain";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function normalizeBaseUrl(baseUrl: string, protocol: ProviderProtocol): string {
  const trimmed = baseUrl.replace(/\/+$/g, "");
  if (protocol === "anthropic-messages" && trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}

export function displayModelName(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function mapProviderModels(
  models: ProviderModel[],
  protocol: ProviderProtocol,
  baseUrl: string,
): Array<Record<string, unknown>> {
  return models.map((model) => ({
    id: model.id,
    name: model.displayName || displayModelName(model.id),
    api: protocol,
    baseUrl: normalizeBaseUrl(modelContextBase(baseUrl), protocol),
    reasoning: model.supportsReasoning,
    input: model.supportsVision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: model.contextWindow || 200_000,
    maxTokens: model.maxOutputTokens || 65_536,
  }));
}

function modelContextBase(baseUrl: string): string {
  return baseUrl;
}

interface RawModelsResponse {
  data?: Array<{ id?: string; name?: string; context_window?: number; context_length?: number }>;
  models?: Array<{ id?: string; name?: string; context_window?: number }>;
}

export class ModelRegistry {
  readonly runtime: ModelRuntime;
  private readonly database: KipDatabase;
  private readonly registered = new Set<string>();

  private constructor(runtime: ModelRuntime, database: KipDatabase) {
    this.runtime = runtime;
    this.database = database;
  }

  static async create(database: KipDatabase): Promise<ModelRegistry> {
    const runtime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime, database);
    await registry.reloadProviders();
    return registry;
  }

  async reloadProviders(): Promise<void> {
    for (const providerId of this.registered) {
      this.runtime.unregisterProvider(providerId);
    }
    this.registered.clear();
    for (const provider of this.database.listProviders()) {
      const apiKey = await getApiKey(provider.id);
      if (!apiKey) continue;
      await this.register(provider, apiKey);
    }
  }

  private async register(provider: ProviderRecord, apiKey: string): Promise<void> {
    try {
      this.runtime.registerProvider(provider.id, {
        name: provider.displayName,
        baseUrl: normalizeBaseUrl(provider.baseUrl, provider.protocol),
        api: provider.protocol,
        headers: protocolHeaders(provider.protocol, provider.baseUrl),
        models: mapProviderModels(
          provider.models,
          provider.protocol,
          provider.baseUrl,
        ) as never,
      });
      await this.runtime.setRuntimeApiKey(provider.id, apiKey);
      this.registered.add(provider.id);
    } catch (error) {
      console.error(`Unable to register provider ${provider.id}:`, error);
    }
  }

  async addOrUpdateProvider(provider: ProviderRecord, apiKey?: string): Promise<void> {
    const key = apiKey ?? (await getApiKey(provider.id));
    if (!key) return;
    if (this.registered.has(provider.id)) {
      this.runtime.unregisterProvider(provider.id);
      this.registered.delete(provider.id);
    }
    await this.register(provider, key);
  }

  removeProvider(providerId: string): void {
    if (!this.registered.has(providerId)) return;
    this.runtime.unregisterProvider(providerId);
    this.registered.delete(providerId);
  }

  getModel(provider: string, modelId: string): Model<never> | undefined {
    return this.runtime.getModel(provider, modelId) as Model<never> | undefined;
  }

  listAvailable(): ModelOption[] {
    const options: ModelOption[] = [];
    for (const provider of this.database.listProviders()) {
      if (!this.registered.has(provider.id)) continue;
      for (const model of provider.models) {
        options.push({
          provider: provider.id,
          modelId: model.id,
          displayName: model.displayName || displayModelName(model.id),
          contextWindow: model.contextWindow || 200_000,
          supportsReasoning: model.supportsReasoning,
        });
      }
    }
    return options;
  }

  async ensureDefault(): Promise<{ provider: string; modelId: string } | null> {
    const available = this.listAvailable();
    const storedProvider = this.database.getSetting("defaultProvider", "");
    const storedModel = this.database.getSetting("defaultModelId", "");
    const exact = available.find(
      (option) => option.provider === storedProvider && option.modelId === storedModel,
    );
    if (exact) return { provider: exact.provider, modelId: exact.modelId };
    const first = available[0];
    if (!first) return null;
    this.database.setSetting("defaultProvider", first.provider);
    this.database.setSetting("defaultModelId", first.modelId);
    return { provider: first.provider, modelId: first.modelId };
  }

  async testProvider(
    providerId: string,
  ): Promise<{ connected: boolean; latencyMs?: number; error?: string }> {
    const provider = this.database.getProvider(providerId);
    const apiKey = await getApiKey(providerId);
    if (!provider) return { connected: false, error: "Provider not found" };
    if (!apiKey) return { connected: false, error: "No API key configured" };
    const modelId = provider.models[0]?.id;
    if (!modelId) return { connected: false, error: "No model configured" };
    const started = performance.now();
    try {
      const response = await probeProvider(provider, modelId, apiKey);
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 180);
        return { connected: false, error: `HTTP ${response.status} ${detail}`.trim() };
      }
      return { connected: true, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }
}

function protocolHeaders(protocol: ProviderProtocol, baseUrl: string): Record<string, string> | undefined {
  if (protocol === "anthropic-messages" && !baseUrl.includes("anthropic.com")) {
    return { "anthropic-version": "2023-06-01" };
  }
  return undefined;
}

export async function probeProvider(
  provider: ProviderRecord,
  modelId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const base = normalizeBaseUrl(provider.baseUrl, provider.protocol);
  const jsonHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (provider.protocol === "anthropic-messages") {
    return fetcher(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  if (provider.protocol === "openai-responses") {
    return fetcher(`${base}/responses`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: modelId, input: "ping", max_output_tokens: 16 }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  return fetcher(`${base}/chat/completions`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ models: ProviderModel[]; error?: string }> {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/g, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { models: [], error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as RawModelsResponse;
    const entries = body.data ?? body.models ?? [];
    const models: ProviderModel[] = entries
      .filter((entry): entry is { id: string; name?: string; context_window?: number } =>
        typeof entry.id === "string" && entry.id.length > 0,
      )
      .map((entry) => ({
        id: entry.id,
        displayName: entry.name || displayModelName(entry.id),
        contextWindow: entry.context_window ?? 200_000,
        maxOutputTokens: 65_536,
        supportsVision: false,
        supportsReasoning: false,
      }));
    if (models.length === 0) return { models, error: "No models returned" };
    return { models };
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : "Unable to fetch models" };
  }
}
