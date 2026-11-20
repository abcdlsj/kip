/**
 * Local gemini2api gateway. It recognises the server from `/health`, reads its models, and
 * trades an existing key for one of Kip's own so no shared secret has to be kept twice.
 *
 * Everything here is plain HTTP against the server the user runs; nothing reaches Google.
 */
import type { ProviderModel } from "../../shared/types";
import type { KipPlugin, PluginProbeOutcome } from "./types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "8790";
const TIMEOUT_MS = 8_000;
/** The web app reports no output cap, so this mirrors the default every other provider uses. */
const DEFAULT_MAX_OUTPUT = 65_536;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const PROVIDER_ID = "gemini2api";

interface HealthBody {
  server?: string;
  version?: string;
  key_required?: boolean;
  api?: {
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
  };
  accounts?: Record<string, { signed_in?: boolean; status?: string }>;
}

interface RemoteModel {
  id?: string;
  context_window?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  gemini?: { display_name?: string };
}

interface RemoteResponse {
  status: number;
  body: unknown;
}

async function callJson(
  url: string,
  init?: RequestInit,
): Promise<RemoteResponse> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function authHeaders(key: string | undefined): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const name =
      error.name === "TimeoutError"
        ? `no answer within ${TIMEOUT_MS / 1000}s`
        : "";
    return name || error.message || error.name;
  }
  return String(error);
}

function toProviderModel(
  model: RemoteModel,
  health: HealthBody,
): ProviderModel | null {
  const id = model.id?.trim();
  if (!id) return null;
  return {
    id,
    displayName: model.gemini?.display_name?.trim() || id,
    contextWindow:
      model.context_window ||
      health.api?.context_window ||
      DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    supportsVision: model.supports_vision === true,
    supportsReasoning: model.supports_reasoning === true,
  };
}

export const gemini2apiPlugin: KipPlugin = {
  id: "gemini2api",
  kind: "gateway",
  label: "gemini2api",
  description:
    "The Gemini web app behind an OpenAI-compatible API. Runs on this machine; Kip finds it, reads its models, and mints a key of its own.",
  providerId: PROVIDER_ID,
  fields: [
    { name: "host", label: "Host", kind: "text", placeholder: DEFAULT_HOST },
    { name: "port", label: "Port", kind: "port", placeholder: DEFAULT_PORT },
    {
      name: "operatorKey",
      label: "Existing key",
      kind: "secret",
      optional: true,
      help: "Used once to mint Kip's own key. Leave empty when the server was started without one.",
    },
  ],

  async probe(values, context): Promise<PluginProbeOutcome> {
    const host = (values.host ?? "").trim() || DEFAULT_HOST;
    const portText = (values.port ?? "").trim() || DEFAULT_PORT;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return {
        ok: false,
        error: `Port must be a whole number from 1 to 65535, not "${portText}".`,
      };
    }
    const root = `http://${host}:${port}`;

    let health: HealthBody | null = null;
    try {
      health = (await callJson(`${root}/health`)).body as HealthBody | null;
    } catch (error) {
      return {
        ok: false,
        error: `Nothing answers at ${root} (${describe(error)}). Start gemini2api, or check the port.`,
      };
    }
    if (health?.server !== "gemini2api") {
      return { ok: false, error: `${root} answers, but it is not gemini2api.` };
    }

    const accounts = Object.entries(health.accounts ?? {});
    const signedIn = accounts.filter(([, state]) => state.signed_in === true);
    const details = [
      {
        label: "Server",
        value: `gemini2api${health.version ? ` ${health.version}` : ""}`,
      },
      {
        label: "Accounts",
        value: accounts.length
          ? accounts
              .map(
                ([id, state]) =>
                  `${id} ${state.signed_in ? "signed in" : (state.status ?? "signed out")}`,
              )
              .join(", ")
          : "none",
      },
    ];
    if (signedIn.length === 0) {
      return {
        ok: false,
        details,
        error:
          "The server is up but no Gemini account is signed in. Run gemini2api's doctor.",
      };
    }

    const operatorKey = (values.operatorKey ?? "").trim() || undefined;
    const needsKey = health.key_required === true;
    if (needsKey && !operatorKey && !context.storedApiKey) {
      return {
        ok: false,
        details,
        missing: [
          {
            field: "operatorKey",
            message:
              "This server needs a key. Paste it once; Kip mints its own from it.",
          },
        ],
      };
    }

    const readModels = async (key: string | undefined) => {
      const { status, body } = await callJson(`${root}/v1/models`, {
        headers: authHeaders(key),
      });
      if (status === 200) {
        return {
          key,
          models: (body as { data?: RemoteModel[] } | null)?.data ?? [],
        };
      }
      if (status === 401 || status === 403) return { rejected: true as const };
      return { error: `/v1/models answered ${status}.` };
    };

    // What Kip already holds first, then the key the user just typed.
    let read: Awaited<ReturnType<typeof readModels>>;
    try {
      read = await readModels(needsKey ? context.storedApiKey : undefined);
      if ("rejected" in read && operatorKey)
        read = await readModels(operatorKey);
    } catch (error) {
      return {
        ok: false,
        details,
        error: `Could not read /v1/models (${describe(error)}).`,
      };
    }
    if ("error" in read) return { ok: false, details, error: read.error };
    if ("rejected" in read) {
      return {
        ok: false,
        details,
        missing: [
          {
            field: "operatorKey",
            message:
              "That key was rejected. Paste the key gemini2api was started with.",
          },
        ],
      };
    }

    const models = read.models
      .map((model) => toProviderModel(model, health))
      .filter((model): model is ProviderModel => model !== null);
    if (models.length === 0) {
      return {
        ok: false,
        details,
        error: "The account lists no usable Gemini model.",
      };
    }

    // Only mint when this turn borrowed a key: a key Kip already holds is reused as-is.
    let apiKey: string | undefined;
    if (needsKey && read.key && read.key !== context.storedApiKey) {
      try {
        const minted = await callJson(`${root}/v1/keys`, {
          method: "POST",
          headers: {
            ...authHeaders(read.key),
            "content-type": "application/json",
          },
          body: JSON.stringify({ label: "kip" }),
        });
        const key = (minted.body as { key?: unknown } | null)?.key;
        if (minted.status !== 201 || typeof key !== "string" || !key) {
          return {
            ok: false,
            details,
            error: `gemini2api refused to mint a key for Kip (HTTP ${minted.status}).`,
          };
        }
        apiKey = key;
      } catch (error) {
        return {
          ok: false,
          details,
          error: `Could not mint a key (${describe(error)}).`,
        };
      }
    }

    return {
      ok: true,
      summary: `${models.length} models · ${signedIn.length} account${signedIn.length === 1 ? "" : "s"} signed in`,
      details: [
        ...details,
        {
          label: "Key",
          value: !needsKey
            ? "not required"
            : apiKey
              ? "minted for Kip"
              : "reused from the keychain",
        },
      ],
      proposal: {
        providerId: PROVIDER_ID,
        displayName: "gemini2api",
        protocol: "openai-completions",
        baseUrl: `${root}/v1`,
        models,
        apiKey,
      },
    };
  },
};
