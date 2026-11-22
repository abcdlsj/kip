/**
 * Hosts a plugin's own window.
 *
 * The host supplies three things and nothing else: the page URL from the app
 * bundle, a snapshot of whatever the plugin's controller returns, and a forward
 * for named actions. It never reads inside `state` and never knows an action's
 * meaning, so a new plugin page needs no code here.
 */
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { PluginPageRPC, PluginPageSnapshot } from "../../shared/plugin-page";
import type { ThemeMode } from "../../shared/types";
import type { KipDatabase } from "../storage/db";
import { pluginDataDir, readPluginValues } from "./registry";
import type { GatewayPlugin } from "./types";

interface OpenWindow {
  pluginId: string;
  window: BrowserWindow;
  /** Sends a fresh snapshot once the page has loaded. */
  push: () => void;
  /** Marks the window closed and disposes its controller at most once. */
  dispose: () => Promise<void>;
}

export class PluginWindows {
  private readonly open = new Map<string, OpenWindow>();

  constructor(
    private readonly database: KipDatabase,
    private readonly defaultRenderer: "native" | "cef" = "native",
  ) {}

  isOpen(pluginId: string): boolean {
    return this.open.has(pluginId);
  }

  openPlugin(plugin: GatewayPlugin): boolean {
    if (!plugin.window || !plugin.page) return false;
    const existing = this.open.get(plugin.id);
    if (existing) {
      if (existing.window.isMinimized()) existing.window.unminimize();
      existing.window.activate();
      return true;
    }

    let closed = false;
    let pushSeq = 0;
    let disposePromise: Promise<void> | null = null;

    const snapshot = async (): Promise<PluginPageSnapshot> => ({
      pluginId: plugin.id,
      theme: this.database.getSetting<ThemeMode>("theme", "system"),
      state: await controller.state(),
    });

    let push = () => {};
    const controller = plugin.page({
      pluginId: plugin.id,
      dataDir: pluginDataDir(plugin.id),
      values: () => readPluginValues(this.database, plugin),
      emit: () => push(),
    });

    const disposeOnce = (): Promise<void> => {
      closed = true;
      if (!disposePromise) {
        disposePromise = Promise.resolve(controller.dispose?.()).catch((error: unknown) => {
          console.error(`Plugin ${plugin.id}: dispose failed`, error);
        });
      }
      return disposePromise;
    };

    const rpc = BrowserView.defineRPC<PluginPageRPC>({
      maxRequestTime: 180_000,
      handlers: {
        requests: {
          pageState: () => snapshot(),
          pageAction: async ({ action, input }) => controller.act(action, input),
        },
        messages: {},
      },
    });

    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        title: plugin.window.title ?? plugin.label,
        url: `views://${plugin.window.page.replace(/^\/+/, "")}`,
        rpc,
        renderer: this.defaultRenderer,
        titleBarStyle: "default",
        frame: {
          x: 160,
          y: 120,
          width: plugin.window.width ?? 720,
          height: plugin.window.height ?? 600,
        },
      });
    } catch (error) {
      void disposeOnce();
      throw error;
    }

    push = () => {
      if (closed) return;
      const seq = ++pushSeq;
      void snapshot()
        .then((next) => {
          if (closed || seq !== pushSeq) return;
          rpc.send.pageSnapshot(next);
        })
        .catch((error: unknown) => {
          if (!closed) console.error(`Plugin ${plugin.id}: state failed`, error);
        });
    };

    const entry: OpenWindow = { pluginId: plugin.id, window, push, dispose: disposeOnce };
    this.open.set(plugin.id, entry);
    window.on("close", () => {
      if (this.open.get(plugin.id) === entry) this.open.delete(plugin.id);
      void disposeOnce();
    });
    return true;
  }

  /** Re-push every open page, e.g. after the theme setting changes. */
  refreshAll(): void {
    for (const entry of this.open.values()) entry.push();
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.open.values()];
    this.open.clear();
    for (const entry of entries) {
      try {
        entry.window.close();
      } catch {
        // The window may already be gone.
      }
      await entry.dispose();
    }
  }
}
