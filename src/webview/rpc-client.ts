/**
 * Single Electrobun RPC client for the webview. Stream frames are forwarded
 * through a tiny event bridge so stores stay free of transport details.
 */
import { Electroview } from "electrobun/view";
import type { KipRPCSchema } from "../shared/rpc-schema";
import type { AgentStreamEnvelope } from "../shared/types";

type StreamListener = (payload: AgentStreamEnvelope) => void;
type SyncListener = (payload: { state: "idle" | "running" | "error"; message?: string }) => void;

type FocusListener = (payload: { threadId: string }) => void;

const streamListeners = new Set<StreamListener>();
const focusListeners = new Set<FocusListener>();

/** The Bun side asks the view to open a thread (from the notch indicator). */
export function onFocusThread(listener: FocusListener): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}
const syncListeners = new Set<SyncListener>();

export function onAgentStream(listener: StreamListener): () => void {
  streamListeners.add(listener);
  return () => streamListeners.delete(listener);
}

export function onSyncStatus(listener: SyncListener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

const rpc = Electroview.defineRPC<KipRPCSchema>({
  maxRequestTime: 60_000,
  handlers: {
    requests: {},
    messages: {
      agentStreamEvent: (payload) => {
        for (const listener of streamListeners) listener(payload);
      },
      syncStatus: (payload) => {
        for (const listener of syncListeners) listener(payload);
      },
      focusThread: (payload) => {
        for (const listener of focusListeners) listener(payload);
      },
    },
  },
});

export const kip = new Electroview({ rpc });

export function request<K extends keyof KipRPCSchema["bun"]["requests"]>(
  method: K,
  params: KipRPCSchema["bun"]["requests"][K]["params"],
): Promise<KipRPCSchema["bun"]["requests"][K]["response"]> {
  const client = kip.rpc;
  if (!client) throw new Error("RPC client is not connected");
  const fn = client.request[method] as (
    value: KipRPCSchema["bun"]["requests"][K]["params"],
  ) => Promise<KipRPCSchema["bun"]["requests"][K]["response"]>;
  return fn(params);
}
