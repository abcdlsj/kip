/**
 * The state and actions behind the gemini2api window.
 *
 * Nothing here reaches into Kip: the page asks for a snapshot, calls a named
 * action, and the plugin decides what that means.
 */
import {
  GEMINI_HOMEPAGE,
  type GeminiAction,
  type GeminiHealth,
  type GeminiModel,
  type GeminiPageState,
} from "../../../shared/plugins/gemini2api";
import type { PluginPageContext, PluginPageController } from "../types";
import * as service from "./service";

export function createGeminiPage(context: PluginPageContext): PluginPageController {
  const { dataDir } = context;
  const values = () => context.values();
  let busy: string | null = null;
  let error: string | null = null;

  function healthOf(body: service.HealthBody | null): GeminiHealth | null {
    if (!body) return null;
    return {
      version: body.version ?? null,
      keyRequired: body.key_required === true,
      accounts: Object.entries(body.accounts ?? {}).map(([id, state]) => ({
        id,
        status: state.status ?? (state.signed_in ? "signed in" : "signed out"),
        signedIn: state.signed_in === true,
      })),
    };
  }

  async function readHealth(): Promise<service.HealthBody | null> {
    const status = service.status(dataDir, values());
    if (!status.running || !status.port) return null;
    return service.health(status.port, service.apiKey(dataDir));
  }

  async function readModels(body: service.HealthBody | null): Promise<GeminiModel[]> {
    const status = service.status(dataDir, values());
    if (!body || !status.port) return [];
    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/v1/models`, {
        headers: { authorization: `Bearer ${service.apiKey(dataDir)}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        data?: Array<{ id?: string; name?: string; gemini?: { display_name?: string } }>;
      };
      return (payload.data ?? [])
        .filter((model) => typeof model.id === "string" && model.id.length > 0)
        .filter((model) => !model.id!.endsWith("-temp"))
        .map((model) => ({
          id: model.id!,
          displayName: model.gemini?.display_name || model.name || model.id!,
        }));
    } catch {
      return [];
    }
  }

  async function state(): Promise<GeminiPageState> {
    const status = service.status(dataDir, values());
    const health = await readHealth();
    const jar = service.savedCookies(dataDir);
    return {
      platform: service.platformKey(),
      installed: status.installed,
      version: status.version,
      binaryPath: status.binaryPath,
      running: health !== null,
      port: status.port,
      pid: status.pid,
      health: healthOf(health),
      models: await readModels(health),
      cookieProfile: jar?.profile ?? null,
      cookieCount: jar ? Object.keys(jar.cookies).length : 0,
      homepage: GEMINI_HOMEPAGE,
      logs: service.readLogs(),
      busy,
      error,
    };
  }

  async function act(action: string): Promise<void> {
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
          await service.stop();
          service.uninstall(dataDir);
          break;
        }
        case "start": {
          await service.ensureRunning(dataDir, values());
          break;
        }
        case "stop": {
          await service.stop();
          break;
        }
        case "import-cookies": {
          service.importFirefoxCookies(dataDir);
          if (service.status(dataDir, values()).running) await service.restart(dataDir, values());
          break;
        }
        case "refresh":
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy = null;
      context.emit();
    }
  }

  return {
    state,
    act: (action) => act(action),
    async dispose() {
      // The gateway belongs to this window: closing it stops the process Kip started.
      await service.stop();
    },
  };
}
