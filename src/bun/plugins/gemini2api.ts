/**
 * Local gemini2api gateway. It recognises the server from `/health`, reads its models, and
 * trades an existing key for one of Kip's own so no shared secret has to be kept twice.
 *
 * Everything here is plain HTTP against the server the user runs; nothing reaches Google.
 */
import type { ProviderModel } from "../../shared/types";
import { geminiModelName, stallTimeoutMs, DEFAULT_STALL_TIMEOUT_SECONDS } from "../../shared/plugins/gemini2api";
import type {
  GatewayPlugin,
  GatewayRequestPolicy,
  PluginProbeOutcome,
  PluginRuntimeContext,
} from "./types";
import { createGeminiPage } from "./gemini2api/page";
import { IdleGuard } from "./gemini2api/idle";
import { GatewayWatchdog } from "./gemini2api/watchdog";
import {
  apiKey,
  ensureRunning,
  health as readHealth,
  isStarting,
  log as logLine,
  resolveBinary,
  setExitListener,
  status as serviceStatus,
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
/** What the gateway leaves idle before it is stopped, in minutes. */
const DEFAULT_IDLE_MINUTES = 120;
/** Below this a pause would land in the middle of a run that is still starting. */
const MIN_IDLE_MINUTES = 5;

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

/** The port a managed instance should use, or null when the target is not loopback. */
function managedPort(values: Record<string, string>): number | null {
  const host = (values.host ?? "").trim() || DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
    return null;
  const port = Number((values.port ?? "").trim() || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

function idleMinutes(values: Record<string, string>): number {
  const parsed = Number((values.idlePauseMinutes ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IDLE_MINUTES;
  return Math.max(MIN_IDLE_MINUTES, Math.round(parsed));
}

/**
 * The plugin's own service state, held across page opens: the countdown has to
 * survive the window being closed and keeps running while Kip is in the background.
 */
let idleContext: PluginRuntimeContext | null = null;
/** Runs currently pointed at this provider; a pause waits for the last one to end. */
let inflight = 0;
/** True when `/health` answered on loopback from a server Kip did not start. */
let usingExternalServer = false;

function isLocallyManaged(
  dataDir: string,
  values: Record<string, string>,
): boolean {
  if (managedPort(values) === null) return false;
  if (serviceStatus(dataDir, values).running) return true;
  if (usingExternalServer) return false;
  return resolveBinary(dataDir, values) !== null;
}

async function checkManagedHealth(): Promise<boolean> {
  if (!idleContext) return false;
  const values = idleContext.values();
  const port = managedPort(values);
  if (port === null) return false;
  const key = (await getApiKey(PROVIDER_ID)) ?? apiKey(idleContext.dataDir);
  return (await readHealth(port, key)) !== null;
}

const watchdog = new GatewayWatchdog({
  label: "gemini2api",
  busy: () => inflight > 0,
  isProcessRunning: () =>
    idleContext !== null &&
    serviceStatus(idleContext.dataDir, idleContext.values()).running,
  checkHealth: checkManagedHealth,
  restartProcess: async () => {
    if (!idleContext) throw new Error("gemini2api context is not initialized.");
    const values = idleContext.values();
    await stop({
      dataDir: idleContext.dataDir,
      includeAdopted: true,
      values,
    });
    await ensureRunning(idleContext.dataDir, values);
  },
  log: (line) => logLine(line),
});

setExitListener((code) => {
  watchdog.handleUnexpectedExit(code);
});

/** Test helper: resets module-level watchdog state between isolated test cases. */
export function resetGeminiWatchdog(): void {
  usingExternalServer = false;
  inflight = 0;
  idle.cancel();
  watchdog.resetBudget();
  watchdog.markStopped();
}

const idle = new IdleGuard({
  delayMs: () => {
    const values = idleContext?.values() ?? {};
    if ((values.idlePause ?? "").trim() !== "true") return null;
    return idleMinutes(values) * 60_000;
  },
  busy: () => inflight > 0,
  running: () =>
    idleContext !== null &&
    serviceStatus(idleContext.dataDir, idleContext.values()).running,
  pause: async () => {
    // Mark intentionally stopped first so the watchdog does not treat an idle
    // pause as an unexpected crash.
    watchdog.markStopped();
    await stop({
      dataDir: idleContext?.dataDir,
      includeAdopted: true,
      values: idleContext?.values(),
    });
  },
  log: (line) => logLine(line),
});

function toProviderModel(
  model: RemoteModel,
  health: HealthBody,
): ProviderModel | null {
  const id = model.id?.trim();
  if (!id) return null;
  return {
    id,
    displayName: geminiModelName(id),
    contextWindow:
      model.context_window ||
      health.api?.context_window ||
      DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    supportsVision: model.supports_vision === true,
    supportsReasoning: model.supports_reasoning === true,
  };
}

/**
 * One entry per model, plus a temporary twin for each unless the server already
 * listed it. Keyed by id: a server that does not mark its `-temp` entries would
 * otherwise produce two entries with the same id.
 */
export function providerModelsFrom(
  remote: RemoteModel[],
  health: HealthBody,
): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  const isTemporary = (model: RemoteModel): boolean =>
    model.gemini?.temporary === true || model.id?.endsWith("-temp") === true;

  for (const model of remote) {
    const named = toProviderModel(model, health);
    if (!named || byId.has(named.id)) continue;
    if (isTemporary(model)) {
      byId.set(named.id, named);
      continue;
    }
    byId.set(named.id, named);
    const temporary = `${named.id}-temp`;
    if (!byId.has(temporary)) {
      byId.set(temporary, {
        ...named,
        id: temporary,
        displayName: geminiModelName(named.id, true),
      });
    }
  }
  return [...byId.values()];
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
  page: (context) =>
    createGeminiPage(context, {
      onAwake: () => {
        idleContext = context;
        usingExternalServer = false;
        watchdog.resetBudget();
        watchdog.markHealthy();
        idle.touch();
      },
      onStop: () => {
        watchdog.markStopped();
        idle.cancel();
      },
      watchdogState: () => watchdog.getSnapshot(),
      subscribeWatchdog: (listener) => watchdog.subscribe(listener),
    }),
  // Kip restarts the gateway at boot, so a provider saved earlier keeps working.
  start: async (context) => {
    idleContext = context;
    const current = context.values();
    if (!resolveBinary(context.dataDir, current)) return;
    const port = managedPort(current);
    if (port === null) return;
    const key = (await getApiKey(PROVIDER_ID)) ?? apiKey(context.dataDir);
    if (await readHealth(port, key)) {
      if (serviceStatus(context.dataDir, current).running) {
        usingExternalServer = false;
        watchdog.markHealthy();
      } else {
        usingExternalServer = true;
      }
    } else {
      usingExternalServer = false;
      watchdog.markStarting();
      try {
        await ensureRunning(context.dataDir, current);
        watchdog.markHealthy();
      } catch (error) {
        watchdog.markStopped();
        throw error;
      }
    }
    idle.touch();
  },
  dispose: () => {
    idle.cancel();
    watchdog.dispose();
    return stop();
  },
  /**
   * Ensures the gateway is actually ready before sending a request:
   * - Awaits any boot-time start or watchdog recovery still in flight
   * - Verifies `/health` so a crashed, hung, or idle-paused sidecar is brought back
   * - Fails early with a clear hint if all Gemini accounts are signed out
   */
  beforeRequest: async (context) => {
    idleContext = context;
    inflight += 1;
    try {
      const values = context.values();
      const port = managedPort(values);
      if (port === null) return;
      const key = (await getApiKey(PROVIDER_ID)) ?? apiKey(context.dataDir);
      if (watchdog.isRecovering()) {
        const result = await watchdog.waitForReady();
        if (result && !result.recovered && result.abortRetry) {
          throw new Error(
            result.message ??
              "gemini2api reached its automatic restart limit. Open Settings → Plugins → gemini2api to restart it.",
          );
        }
      }
      if (isStarting()) {
        await ensureRunning(context.dataDir, values);
      }
      let currentHealth = await readHealth(port, key);
      if (currentHealth) {
        if (serviceStatus(context.dataDir, values).running) {
          usingExternalServer = false;
          watchdog.markHealthy();
        } else {
          usingExternalServer = true;
        }
      } else {
        if (!resolveBinary(context.dataDir, values)) return;
        usingExternalServer = false;
        // A hung/stale process on this port must go through the watchdog so
        // restart limits and status notices apply consistently.
        if (
          serviceStatus(context.dataDir, values).running ||
          watchdog.isDesiredRunning()
        ) {
          const result = await watchdog.recover(
            "health check unresponsive before request",
            context.reportStatus,
          );
          if (!result.recovered) {
            throw new Error(
              result.message ??
                "gemini2api did not respond and could not be restarted.",
            );
          }
          currentHealth = await readHealth(port, key);
        } else {
          const snapshot = watchdog.getSnapshot();
          if (snapshot.state === "degraded") {
            throw new Error(
              `gemini2api failed after ${snapshot.maxRestarts} automatic restarts. Open Settings → Plugins → gemini2api to inspect logs and restart.`,
            );
          }
          watchdog.markStarting();
          try {
            const started = await ensureRunning(context.dataDir, values);
            watchdog.markHealthy();
            currentHealth = await readHealth(started.port, started.key);
          } catch (error) {
            watchdog.markStopped();
            throw error;
          }
        }
      }
      const accounts = Object.values(currentHealth?.accounts ?? {});
      if (
        accounts.length > 0 &&
        !accounts.some((account) => account.signed_in === true)
      ) {
        throw new Error(
          "gemini2api is running, but no Gemini account is signed in. Open Settings → Plugins → gemini2api and press “Use Firefox session”.",
        );
      }
    } finally {
      idle.touch();
    }
  },
  requestPolicy: (context): GatewayRequestPolicy | null => {
    idleContext = context;
    const values = context.values();
    if (!isLocallyManaged(context.dataDir, values)) return null;
    // Much tighter than Pi's five-minute remote default, but configurable:
    // Gemini Web can think for a while before the first byte arrives.
    return {
      firstByteTimeoutMs: stallTimeoutMs(values, "firstByteTimeoutSeconds"),
      streamIdleTimeoutMs: stallTimeoutMs(values, "streamIdleTimeoutSeconds"),
    };
  },
  beforeAttempt: async (context, signal) => {
    idleContext = context;
    const values = context.values();
    if (!isLocallyManaged(context.dataDir, values)) return;
    if (watchdog.isRecovering()) {
      const result = await watchdog.waitForReady(signal);
      if (result && !result.recovered && result.abortRetry) {
        throw new Error(
          result.message ??
            "gemini2api reached its automatic restart limit. Open Settings → Plugins → gemini2api to restart it.",
        );
      }
      return;
    }
    const snapshot = watchdog.getSnapshot();
    if (snapshot.state === "degraded") {
      throw new Error(
        `gemini2api failed after ${snapshot.maxRestarts} automatic restarts. Open Settings → Plugins → gemini2api to inspect logs and restart.`,
      );
    }
    if (
      !serviceStatus(context.dataDir, values).running &&
      watchdog.isDesiredRunning()
    ) {
      const result = await watchdog.recover(
        "managed process exited before retry",
        context.reportStatus,
      );
      if (!result.recovered && result.abortRetry) {
        throw new Error(
          result.message ??
            "gemini2api reached its automatic restart limit. Open Settings → Plugins → gemini2api to restart it.",
        );
      }
    }
  },
  onRequestFailure: async (context, failure) => {
    idleContext = context;
    if (!isLocallyManaged(context.dataDir, context.values())) {
      return { recovered: false };
    }
    return watchdog.handleRequestFailure(failure, context.reportStatus);
  },
  onRequestSuccess: (context) => {
    idleContext = context;
    if (isLocallyManaged(context.dataDir, context.values())) {
      watchdog.markHealthy();
    }
  },
  afterRequest: () => {
    inflight = Math.max(0, inflight - 1);
    idle.touch();
  },
  settingsChanged: (context) => {
    idleContext = context;
    idle.touch();
  },
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
      name: "idlePause",
      label: "Pause when idle",
      kind: "toggle",
      help: "Stop the gateway after it has been unused for a while, and start it again on the next run. Both are silent; the first run after a pause waits for the gateway to come up.",
    },
    {
      name: "idlePauseMinutes",
      label: "Idle minutes",
      kind: "text",
      placeholder: String(DEFAULT_IDLE_MINUTES),
      help: `Only used while pausing is on. Everything below ${MIN_IDLE_MINUTES} is treated as ${MIN_IDLE_MINUTES}.`,
    },
    {
      name: "firstByteTimeoutSeconds",
      label: "First byte timeout",
      kind: "text",
      placeholder: String(DEFAULT_STALL_TIMEOUT_SECONDS),
      help: `Seconds to wait for the gateway to start answering before Kip treats it as hung and restarts it. Raise it if long thinking turns get cut. Blank keeps ${DEFAULT_STALL_TIMEOUT_SECONDS}.`,
    },
    {
      name: "streamIdleTimeoutSeconds",
      label: "Stream idle timeout",
      kind: "text",
      placeholder: String(DEFAULT_STALL_TIMEOUT_SECONDS),
      help: `Seconds of silence allowed in the middle of a reply before the gateway counts as hung. Blank keeps ${DEFAULT_STALL_TIMEOUT_SECONDS}.`,
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
    // A window or a Detect can start the gateway without a run following; the
    // countdown needs to know about it either way.
    if (context.dataDir) {
      const dataDir = context.dataDir;
      idleContext = { pluginId: "gemini2api", dataDir, values: () => values };
    }
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
      const isLoopback =
        host === "127.0.0.1" || host === "localhost" || host === "::1";
      if (!isLoopback) {
        return { ok: false, error: `Could not reach ${root}/health.` };
      }
      if (!context.dataDir) {
        return {
          ok: false,
          error: "Kip has no data directory for this plugin.",
        };
      }
      try {
        const managed = await ensureRunning(context.dataDir, values);
        root = `http://127.0.0.1:${managed.port}`;
        managedKey = managed.key;
        health = await readHealth(managed.port, managed.key);
        idle.touch();
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
      read = await readModels(
        managedKey ?? (needsKey ? context.storedApiKey : undefined),
      );
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

    // Each model is offered twice: as-is, and temporary. Only the storage differs, so the
    // suffix is the whole difference between the two entries.
    const temporaryChosen = (values.temporaryChat ?? "").trim() === "true";
    const models = providerModelsFrom(read.models, health);
    if (models.length === 0) {
      return {
        ok: false,
        details,
        error: "The account lists no usable Gemini model.",
      };
    }

    // Only mint when this turn borrowed a key: a key Kip already holds is reused as-is.
    let apiKey: string | undefined;
    if (
      !managedKey &&
      needsKey &&
      read.key &&
      read.key !== context.storedApiKey
    ) {
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
