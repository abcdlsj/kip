/**
 * The client half of a plugin window. A plugin page imports this, renders
 * whatever state it wants, and forwards clicks as named actions — the same
 * names its `page()` controller answers in the main process.
 */
import { Electroview } from "electrobun/view";
import type {
  PluginPageRPC,
  PluginPageSnapshot,
} from "../../shared/plugin-page";
import { applyPlatform } from "./platform";
import { applyTheme, watchSystemTheme } from "./theme";

export interface PluginPageClient {
  /** Invoke an action the plugin declared; the host only forwards it. */
  action: (action: string, input?: unknown) => Promise<unknown>;
  /** The last snapshot, for handlers that need it outside a render. */
  current: () => PluginPageSnapshot | null;
}

export function connectPluginPage<TState>(
  onSnapshot: (state: TState, snapshot: PluginPageSnapshot) => void,
): PluginPageClient {
  applyPlatform();
  let last: PluginPageSnapshot | null = null;
  const deliver = (snapshot: PluginPageSnapshot) => {
    last = snapshot;
    applyTheme(snapshot.theme);
    onSnapshot(snapshot.state as TState, snapshot);
  };

  const rpc = Electroview.defineRPC<PluginPageRPC>({
    maxRequestTime: 180_000,
    handlers: {
      requests: {},
      messages: {
        pageSnapshot: deliver,
      },
    },
  });
  const view = new Electroview({ rpc });

  const client: PluginPageClient = {
    action: async (action, input) => {
      const request = view.rpc?.request.pageAction;
      if (!request) throw new Error("RPC client is not connected");
      return request({ action, input });
    },
    current: () => last,
  };

  // The page may open before or after the first push; ask once either way.
  void view.rpc?.request
    .pageState()
    .then((snapshot) => {
      if (!last) deliver(snapshot);
    })
    .catch(() => undefined);

  watchSystemTheme(() => last?.theme ?? "system");
  return client;
}
