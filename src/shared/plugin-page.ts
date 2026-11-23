/**
 * The wire between a plugin's own window and Kip.
 *
 * The host knows nothing about what a plugin page shows: it carries an opaque
 * `state` snapshot and forwards named actions. Everything else — what the page
 * looks like, which actions exist, what they do — belongs to the plugin.
 */
import type { ThemeMode } from "./types";

export interface PluginPageSnapshot {
  pluginId: string;
  /** The app's theme preference; pages resolve `system` themselves. */
  theme: ThemeMode;
  /** Plugin-defined. The host never reads inside. */
  state: unknown;
}

export interface PluginPageRPC {
  bun: {
    requests: {
      /** The current snapshot, fetched when the page opens. */
      pageState: { params: void; response: PluginPageSnapshot };
      /** Run one action the plugin declared in its page controller. */
      pageAction: {
        params: { action: string; input?: unknown };
        response: unknown;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      /** Pushed whenever the plugin's state or the app's theme changes. */
      pageSnapshot: PluginPageSnapshot;
    };
  };
}
