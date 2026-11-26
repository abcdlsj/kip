/**
 * The state and actions behind the gemini2api window.
 *
 * Nothing here reaches into Kip: the page asks for a snapshot, calls a named
 * action, and the plugin decides what that means.
 */
import {
  GEMINI_HOMEPAGE,
  geminiModelName,
  type GeminiAction,
  type GeminiHealth,
  type GeminiModel,
  type GeminiPageState,
  type GeminiWatchdogState,
} from "../../../shared/plugins/gemini2api";
import { getApiKey } from "../../storage/keychain";
import type { PluginPageContext, PluginPageController } from "../types";
import * as service from "./service";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;

interface Endpoint {
  host: string;
  port: number;
  loopback: boolean;
}

/**
 * A failure the user can act on, phrased as what happened plus what to do.
 * Raw process output stays in the log; this is the part that goes in the box.
 */
function hintFor(message: string): string | null {
  if (/no account signed in|guest session|UNAUTHENTICATED/i.test(message)) {
    return [
      "Firefox's Gemini session is not valid any more — usually because another gemini2api client already rotated its cookies.",
      "1. If a gemini2api server is already running on port " +
        `${DEFAULT_PORT}, press Detect on the plugin card and use that one instead of starting a second client.`,
      "2. Otherwise open gemini.google.com in Firefox, confirm you are signed in, then press “Use Firefox session”, then Start.",
      "Two clients cannot share one Google session: each refresh invalidates the other's cookies.",
    ].join("\n");
  }
  if (/No Firefox profile has a Gemini session/i.test(message)) {
    return "Sign in to gemini.google.com in Firefox (the profile Kip reads is listed under Cookies), then press “Use Firefox session”.";
  }
  if (/not installed/i.test(message)) {
    return "Press Install to download the standalone binary (about 20 MB).";
  }
  if (/did not answer|exited during startup/i.test(message)) {
    return "Check the log below. The configured port may be taken by another program, or the binary may not be able to start on this machine.";
  }
  return null;
}

export interface GeminiPageHooks {
  /** Called after this window brings the managed gateway up, so idle/watchdog activate. */
  onAwake?: () => void;
  /** Called before an intentional stop/uninstall so the watchdog does not auto-restart. */
  onStop?: () => void;
  /** Reads the live watchdog state for display in the window. */
  watchdogState?: () => GeminiWatchdogState;
  /** Subscribes to watchdog transitions so the open page repaints live. */
  subscribeWatchdog?: (listener: () => void) => () => void;
}

export function createGeminiPage(
  context: PluginPageContext,
  /** Callback or hook bundle wired by the plugin. */
  hooksOrOnAwake?: (() => void) | GeminiPageHooks,
): PluginPageController {
  const hooks: GeminiPageHooks =
    typeof hooksOrOnAwake === "function"
      ? { onAwake: hooksOrOnAwake }
      : (hooksOrOnAwake ?? {});
  const { dataDir } = context;
  const values = () => context.values();
  let busy: string | null = null;
  let error: GeminiPageState["error"] = null;
  let emitQueued = false;
  const scheduleEmit = () => {
    if (emitQueued) return;
    emitQueued = true;
    setTimeout(() => {
      emitQueued = false;
      context.emit();
    }, 300);
  };
  // New log lines and watchdog transitions arrive while the gateway runs; repaint without polling.
  service.setLogListener(scheduleEmit);
  const unsubscribeWatchdog = hooks.subscribeWatchdog?.(scheduleEmit) ?? null;

  function configured(): Endpoint | null {
    const current = values();
    const host = (current.host ?? "").trim() || DEFAULT_HOST;
    const port = Number((current.port ?? "").trim() || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return {
      host,
      port,
      loopback: host === "127.0.0.1" || host === "localhost" || host === "::1",
    };
  }

  function healthOf(body: service.HealthBody | null): GeminiHealth | null {
    if (!body) return null;
    return {
      version: body.version ?? null,
      keyRequired: body.key_required === true,
      chats: typeof body.chats === "number" ? body.chats : null,
      accounts: Object.entries(body.accounts ?? {}).map(([id, state]) => ({
        id,
        status: state.status ?? (state.signed_in ? "signed in" : "signed out"),
        signedIn: state.signed_in === true,
      })),
    };
  }

  /** The instance Kip started (including one adopted across a restart), if any. */
  async function managed(): Promise<{
    port: number;
    key: string;
    health: service.HealthBody;
  } | null> {
    const status = service.status(dataDir, values());
    if (!status.running || !status.port) return null;
    const key =
      (await getApiKey(service.PROVIDER_ID)) ?? service.apiKey(dataDir);
    const health = await service.health(status.port, key);
    return health ? { port: status.port, key, health } : null;
  }

  /** A server the user runs themselves at the configured address. */
  async function external(): Promise<{
    port: number;
    key: string;
    health: service.HealthBody;
  } | null> {
    const endpoint = configured();
    if (!endpoint?.loopback) return null;
    const key =
      (await getApiKey(service.PROVIDER_ID)) ?? service.apiKey(dataDir);
    const health = await service.health(endpoint.port, key);
    return health ? { port: endpoint.port, key, health } : null;
  }

  async function readModels(
    instance: { port: number; key: string } | null,
  ): Promise<GeminiModel[]> {
    if (!instance) return [];
    try {
      const response = await fetch(
        `http://127.0.0.1:${instance.port}/v1/models`,
        {
          headers: { authorization: `Bearer ${instance.key}` },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        data?: Array<{
          id?: string;
          name?: string;
          gemini?: { display_name?: string };
        }>;
      };
      return (payload.data ?? [])
        .filter((model) => typeof model.id === "string" && model.id.length > 0)
        .filter((model) => !model.id!.endsWith("-temp"))
        .map((model) => ({
          id: model.id!,
          displayName: geminiModelName(model.id!, model.id!.endsWith("-temp")),
        }));
    } catch {
      return [];
    }
  }

  async function state(): Promise<GeminiPageState> {
    const status = service.status(dataDir, values());
    const instance = (await managed()) ?? (await external());
    const jar = service.savedCookies(dataDir);
    const surfacedError =
      error ??
      (instance === null && status.lastError
        ? { message: status.lastError, hint: hintFor(status.lastError) }
        : null);
    return {
      platform: service.platformKey(),
      installed: status.installed,
      version: status.version,
      binaryPath: status.binaryPath,
      running: instance !== null,
      external: instance !== null && status.running === false,
      port: instance?.port ?? status.port,
      pid: status.pid,
      health: healthOf(instance?.health ?? null),
      models: await readModels(instance),
      cookieProfile: jar?.profile ?? null,
      cookieCount: jar ? Object.keys(jar.cookies).length : 0,
      homepage: GEMINI_HOMEPAGE,
      logs: service.readLogs(),
      busy,
      error: surfacedError,
      watchdog: hooks.watchdogState?.(),
    };
  }

  function fail(caught: unknown): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    error = { message, hint: hintFor(message) };
  }

  async function act(action: string): Promise<void> {
    if (busy !== null) return;
    error = null;
    busy = action;
    context.emit();
    try {
      switch (action as GeminiAction) {
        case "install": {
          await service.install(dataDir, values());
          break;
        }
        case "uninstall": {
          hooks.onStop?.();
          await service.stop({ dataDir, includeAdopted: true, values: values() });
          service.uninstall(dataDir);
          break;
        }
        case "start": {
          // Never race a server the user already runs: a second client with the
          // same Google session would rotate cookies for both.
          if (!service.status(dataDir, values()).running) {
            const running = await external();
            if (running) {
              error = {
                message: `A gemini2api server is already running at 127.0.0.1:${running.port}.`,
                hint: `Kip is using it as-is. Press Detect on the plugin card to register its models. Starting a second instance would rotate cookies for both.`,
              };
              break;
            }
          }
          await service.ensureRunning(dataDir, values());
          hooks.onAwake?.();
          break;
        }
        case "stop": {
          if (!service.status(dataDir, values()).running) {
            const running = await external();
            if (running) {
              error = {
                message: `The server on 127.0.0.1:${running.port} was not started by Kip.`,
                hint: "Stop it where you started it (for example the terminal running gemini2api).",
              };
              break;
            }
          }
          hooks.onStop?.();
          await service.stop({ dataDir, includeAdopted: true, values: values() });
          break;
        }
        case "restart": {
          if (!service.status(dataDir, values()).running) {
            const running = await external();
            if (running) {
              error = {
                message: `The server on 127.0.0.1:${running.port} was not started by Kip.`,
                hint: "Restart it where you started it (for example the terminal running gemini2api).",
              };
              break;
            }
          }
          hooks.onStop?.();
          await service.restart(dataDir, values());
          hooks.onAwake?.();
          break;
        }
        case "import-cookies": {
          service.importFirefoxCookies(dataDir);
          if (service.status(dataDir, values()).running) {
            hooks.onStop?.();
            await service.restart(dataDir, values());
            hooks.onAwake?.();
          }
          break;
        }
        case "refresh":
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (caught) {
      fail(caught);
    } finally {
      busy = null;
      context.emit();
    }
  }

  return {
    state,
    act: (action) => act(action),
    async dispose() {
      // The gateway belongs to Kip, not to this window: closing it only stops
      // watching. It ends on Stop, or with the app.
      service.setLogListener(null);
      unsubscribeWatchdog?.();
    },
  };
}
