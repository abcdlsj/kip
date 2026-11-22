/**
 * The plugin catalog Kip ships with.
 *
 * This is not an app store you install from: every entry is a module under
 * `src/bun/plugins/` that already ships in this repository. The catalog exists
 * so the Plugins page can state, in one place, who wrote a plugin, what it may
 * touch, and that its author — not Kip — is responsible for it.
 *
 * A remote catalog can be added later behind the same shape; nothing here reads
 * the network.
 */
import type { MarketplaceEntry, PluginPermission } from "./types";

/** Shown above the catalog. Keep it blunt: plugins run with Kip's own privileges. */
export const MARKETPLACE_NOTICE = [
  "Plugins are third-party code. They run inside Kip's main process, so a plugin can use the network, start local programs, read and write files, and read the credentials Kip stores.",
  "Kip only loads them; it does not audit them. Each plugin's author is responsible for what it does. Enable a plugin only if you trust its author and its source.",
].join(" ");

const PERMISSION_LABELS: Record<PluginPermission, string> = {
  network: "Network access",
  process: "Starts local programs",
  files: "Reads and writes files",
  credentials: "Uses credentials",
};

export function permissionLabel(permission: PluginPermission): string {
  return PERMISSION_LABELS[permission];
}

export const MARKETPLACE: MarketplaceEntry[] = [
  {
    id: "gemini2api",
    kind: "gateway",
    name: "gemini2api",
    summary:
      "Puts the Gemini web app behind an OpenAI-compatible API on this machine, so a Gemini subscription can answer in Kip without an API key.",
    version: "0.1",
    author: "abcdlsj (author of Kip)",
    homepage: "https://github.com/abcdlsj/gemini2api",
    providerId: "gemini2api",
    permissions: ["network", "process", "files", "credentials"],
    window: true,
    builtin: true,
  },
  {
    id: "warren-title",
    kind: "title",
    name: "AI Thread Titles",
    summary:
      "Names new threads through a hosted title service or a self-hosted worker. Sends only a clipped conversation excerpt and a random device id.",
    version: "0.1",
    author: "abcdlsj (author of Kip)",
    homepage: "https://github.com/abcdlsj/warren",
    permissions: ["network"],
    window: false,
    builtin: true,
  },
];

export function findMarketplaceEntry(id: string): MarketplaceEntry | undefined {
  return MARKETPLACE.find((entry) => entry.id === id);
}
