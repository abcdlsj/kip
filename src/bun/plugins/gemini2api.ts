/**
 * Local gemini2api gateway. It recognises the server from `/health`, reads its models, and
 * trades an existing key for one of Kip's own so no shared secret has to be kept twice.
 *
 * Everything here is plain HTTP against the server the user runs; nothing reaches Google.
 */
import type { ProviderModel } from "../../shared/types";
import type { GatewayPlugin, PluginProbeOutcome } from "./types";
import { createGeminiPage } from "./gemini2api/page";
import {
  apiKey,
  ensureRunning,
  health as readHealth,
  resolveBinary,
  stop,
  type HealthBody,
} from "./gemini2api/service";
import { getApiKey } from "../storage/keychain";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "8790";
const TIMEOUT_MS = 8_000;
/** The web app reports no output cap, so this mirrors the default every other provider uses. */
const DEFAULT_MAX_OUTPUT = 65_536;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const PROVIDER_ID = "gemini2api";

interface RemoteModel {
  id?: string;
  context_window?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  gemini?: { display_name?: string; temporary?: boolean };
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

export const gemini2apiPlugin: GatewayPlugin = {
  id: "gemini2api",
  kind: "gateway",
  label: "gemini2api",
  description:
    "The Gemini web app behind an OpenAI-compatible API. Runs on this machine; Kip finds it, reads its models, and mints a key of its own.",
  providerId: PROVIDER_ID,
  // Gemini web answers one prompt at a time, so a chat thread is the useful shape.
  chatThreads: true,
  // The gateway ships separately; this window installs it and shows its state.
  window: {
    page: "plugins/gemini2api/index.html",
    title: "gemini2api",
    width: 780,
    height: 660,
  },
  page: createGeminiPage,
  // Kip restarts the gateway at boot, so a provider saved earlier keeps working.
  start: async ({ dataDir, values }) => {
    const current = values();
    if (!resolveBinary(dataDir, current)) return;
    const host = (current.host ?? "").trim() || DEFAULT_HOST;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return;
    const portText = (current.port ?? "").trim() || DEFAULT_PORT;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
    const key = (await getApiKey(PROVIDER_ID)) ?? apiKey(dataDir);
    if (await readHealth(port, key)) return;
    await ensureRunning(dataDir, current);
  },
  dispose: () => stop(),
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
    {
      name: "temporaryChat",
      label: "Temporary chats",
      kind: "toggle",
      help: "Off: chats stay in the Gemini account so the context survives. On: nothing is kept in the account, and long conversations lose context because Google may close a temporary chat at any time.",
    },
    {
      name: "binaryPath",
      label: "Local binary",
      kind: "text",
      optional: true,
      placeholder: "/path/to/gemini2api",
      help: "Use a build you already have instead of the downloaded one. Leave empty to let Kip install it.",
    },
    {
      name: "threadMode",
      label: "New threads",
      kind: "select",
      options: [
        { value: "chat", label: "Chat" },
        { value: "agent", label: "Agent" },
      ],
      help: "Chat sends only the conversation: no tools, no system prompt, no workspace context. Agent runs the usual tool loop. The composer switches an empty thread either way.",
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
    let root = `http://${host}:${port}`;
    let health: HealthBody | null = null;
    let managedKey: string | undefined;
    try {
      health = (await callJson(`${root}/health`)).body as HealthBody | null;
    } catch {
      health = null;
    }

    // Nothing on the configured port: start the instance Kip manages, if the
    // target is local and it is installed. A server the user runs is never duplicated.
    if (!health) {
      const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
      if (!isLoopback) {
        return { ok: false, error: `Could not reach ${root}/health.` };
      }
      if (!context.dataDir) {
        return { ok: false, error: "Kip has no data directory for this plugin." };
      }
      try {
        const managed = await ensureRunning(context.dataDir, values);
        root = `http://127.0.0.1:${managed.port}`;
        managedKey = managed.key;
        health = await readHealth(managed.port, managed.key);
      } catch (error) {
        return {
          ok: false,
          error: describe(error),
        };
      }
    }
    if (!health || health.server !== "gemini2api") {
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
    // A managed instance already has the key Kip wrote into its config.
    if (!managedKey && needsKey && !operatorKey && !context.storedApiKey) {
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
      read = await readModels(managedKey ?? (needsKey ? context.storedApiKey : undefined));
      if ("rejected" in read && operatorKey) read = await readModels(operatorKey);
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

    // Each model is offered twice: as-is, and temporary. Only the storage differs, so the
    // suffix is the whole difference between the two entries.
    const temporaryChosen = (values.temporaryChat ?? "").trim() === "true";
    const models = read.models
      .flatMap((model) => {
        const named = toProviderModel(model, health);
        if (!named || model.gemini?.temporary) return named ? [named] : [];
        const temporary: ProviderModel = {
          ...named,
          id: `${named.id}-temp`,
          displayName: `${named.displayName} (temporary)`,
        };
        return [named, temporary];
      })
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
    if (!managedKey && needsKey && read.key && read.key !== context.storedApiKey) {
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
            : managedKey
              ? "managed by Kip"
              : apiKey
                ? "minted for Kip"
                : "reused from the keychain",
        },
        {
          label: "Temporary",
          value: temporaryChosen
            ? "default on; every model also has a plain variant"
            : "off by default; pick the (temporary) variant to opt in",
        },
      ],
      proposal: {
        providerId: PROVIDER_ID,
        displayName: "gemini2api",
        protocol: "openai-completions",
        baseUrl: `${root}/v1`,
        models,
        apiKey: managedKey ?? apiKey,
      },
    };
  },
};
