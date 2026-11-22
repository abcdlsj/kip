/**
 * Kip main process. Initializes local storage, the model registry, the Pi
 * session pool, and the single frameless application window.
 */
import { ApplicationMenu, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { KipDatabase } from "./storage/db";
import { ModelRegistry } from "./agent/model-registry";
import { KipOrchestrator } from "./agent/pi-orchestrator";
import { createKipRpc } from "./rpc-handler";
import type { AgentStreamEnvelope } from "../shared/types";
import { triggerSync } from "./sync/s3-sync";
import { NotchIndicator, type NotchState } from "./system/notch";
import { applyWindowsDpiAwareness } from "./system/windows-dpi";
import { UpdateChecker } from "./system/update-checker";
import { createUpdateInstaller } from "./system/update-installer";

// Must run before the first window exists, so it cannot move below.
applyWindowsDpiAwareness();

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
const updateChecker = new UpdateChecker({
  // Dev bundles carry a stale version.json, so local builds stay quiet unless
  // KIP_UPDATE_CURRENT_VERSION pins the version explicitly.
  currentVersion: process.env.KIP_UPDATE_CURRENT_VERSION ?? (await Updater.localInfo.version()),
  installer: createUpdateInstaller({
    // Restarting for an update stops any running agent; the view warns first.
    onQuit: () => {
      void shutdown().finally(() => Utils.quit());
    },
  }),
  onStatus: (status) => rpc.send.updateStatus(status),
});
const rpc = createKipRpc({ database, registry, orchestrator, updateChecker, windowRef });
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Background attention state for the notch indicator. Approvals outrank
 * finished runs, which outrank running ones. Finished runs count only while
 * the main window is in the background and clear when it comes forward.
 */
const attention = {
  awaiting: new Map<string, Set<string>>(),
  done: new Set<string>(),
  focused: true,
};
let notch: NotchIndicator | null = null;

function topThread(): { threadId: string | null; state: NotchState } {
  for (const [threadId, calls] of attention.awaiting) {
    if (calls.size > 0) return { threadId, state: "attention" };
  }
  const done = [...attention.done].pop();
  if (done) return { threadId: done, state: "done" };
  const running = orchestrator.runningThreadIds()[0];
  if (running) return { threadId: running, state: "working" };
  return { threadId: null, state: "idle" };
}

function refreshNotch(): void {
  if (!notch) return;
  if (process.env.KIP_NOTCH_PREVIEW) return notch.set(process.env.KIP_NOTCH_PREVIEW as NotchState);
  notch.set(attention.focused ? "idle" : topThread().state);
}

function trackAttention(payload: AgentStreamEnvelope): void {
  const { threadId, event } = payload;
  if (event.kind === "text_delta" || event.kind === "thinking_delta") return;
  const calls = attention.awaiting.get(threadId) ?? new Set<string>();
  attention.awaiting.set(threadId, calls);
  if (event.kind === "tool_approval_required") calls.add(event.approval.toolCallId);
  else if (event.kind === "tool_approved" || event.kind === "tool_end") calls.delete(event.toolCallId);
  else if (event.kind === "turn_complete" || event.kind === "turn_error") {
    calls.clear();
    if (!attention.focused) attention.done.add(threadId);
  } else if (event.kind === "turn_start") {
    attention.done.delete(threadId);
  }
  refreshNotch();
}

streamHolder.send = (payload) => {
  rpc.send.agentStreamEvent(payload);
  trackAttention(payload);
  if (payload.event.kind === "turn_complete" && database.getSetting("sync.enabled", false)) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      rpc.send.syncStatus({ state: "running" });
      void triggerSync(database)
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
  titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
  renderer: process.platform === "darwin" ? "cef" : "native",
  trafficLightOffset: { x: 16, y: 18 },
  frame: { x: 120, y: 90, width: 1180, height: 780 },
});
windowRef.current = window;
const updateChannel = await Updater.localInfo.channel();
if (updateChannel === "dev" && !process.env.KIP_UPDATE_CURRENT_VERSION) {
  console.log("Update checks are off for the dev channel.");
} else {
  updateChecker.start();
}
// Windows and Linux draw their own window buttons, so the view needs to know
// whether the window is maximized to pick the right icon.
const pushWindowState = (): void => {
  rpc.send.windowState({ maximized: window.isMaximized() });
};
window.on("resize", pushWindowState);
window.on("focus", () => {
  attention.focused = true;
  attention.done.clear();
  refreshNotch();
});
window.on("blur", () => {
  attention.focused = false;
  refreshNotch();
});
notch = new NotchIndicator(() => {
  const { threadId } = topThread();
  if (window.isMinimized()) window.unminimize();
  window.activate();
  if (threadId) rpc.send.focusThread({ threadId });
});
refreshNotch();
// Closing the window quits: a running instance with no window cannot be
// reopened from the Dock, so leaving the process alive would strand the user.
window.on("close", () => {
  void shutdown().finally(() => process.exit(0));
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    updateChecker.stop();
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
  })();
  return shutdownPromise;
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
