/**
 * Kip main process. Initializes local storage, the model registry, the Pi
 * session pool, and the single frameless application window.
 */
import { ApplicationMenu, BrowserWindow, Updater } from "electrobun/bun";
import { KipDatabase } from "./storage/db";
import { ModelRegistry } from "./agent/model-registry";
import { KipOrchestrator } from "./agent/pi-orchestrator";
import { createKipRpc } from "./rpc-handler";
import type { AgentStreamEnvelope } from "../shared/types";
import { triggerS3Sync } from "./sync/s3-sync";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error.message);
});

const database = new KipDatabase();
const registry = await ModelRegistry.create(database);

const streamHolder: { send: (payload: AgentStreamEnvelope) => void } = { send: () => {} };
const orchestrator = new KipOrchestrator(database, registry, (threadId, event) => {
  streamHolder.send({ threadId, event });
});

const windowRef: { current: BrowserWindow | null } = { current: null };
const rpc = createKipRpc({ database, registry, orchestrator, windowRef });
let syncTimer: ReturnType<typeof setTimeout> | null = null;
streamHolder.send = (payload) => {
  rpc.send.agentStreamEvent(payload);
  if (payload.event.kind === "turn_complete" && database.getSetting("sync.enabled", false)) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      rpc.send.syncStatus({ state: "running" });
      void triggerS3Sync(database)
        .then(() => rpc.send.syncStatus({ state: "idle" }))
        .catch((error: unknown) =>
          rpc.send.syncStatus({
            state: "error",
            message: error instanceof Error ? error.message : "Automatic sync failed",
          }),
        );
    }, 10_000);
  }
};

async function resolveViewUrl(): Promise<string> {
  if (process.env.KIP_DEV_SERVER === "1") {
    const channel = await Updater.localInfo.channel();
    if (channel === "dev") {
      try {
        const response = await fetch(DEV_SERVER_URL, { method: "HEAD" });
        if (response.ok) return DEV_SERVER_URL;
      } catch {
        console.log("Vite dev server is not running; loading the built view.");
      }
    }
  }
  return "views://mainview/index.html";
}

ApplicationMenu.setApplicationMenu([
  {
    label: "Kip",
    submenu: [
      { role: "about" },
      { type: "divider" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "divider" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "divider" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { role: "toggleFullScreen" },
      { type: "divider" },
      { role: "close" },
    ],
  },
]);

const window = new BrowserWindow({
  title: "Kip",
  url: await resolveViewUrl(),
  rpc,
  titleBarStyle: "hiddenInset",
  renderer: process.platform === "darwin" ? "cef" : "native",
  trafficLightOffset: { x: 16, y: 18 },
  frame: { x: 120, y: 90, width: 1180, height: 780 },
});
windowRef.current = window;
window.on("close", () => {
  void shutdown();
});

async function shutdown(): Promise<void> {
  try {
    await orchestrator.shutdown();
  } catch {
    // The process is exiting; shutdown is best-effort.
  }
  try {
    database.close();
  } catch {
    // Ignore a second close.
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("beforeExit", () => {
  void shutdown();
});

console.log("Kip is ready.");
