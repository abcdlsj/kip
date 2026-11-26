/**
 * Kip main process. Initializes local storage, the model registry, the Pi
 * session pool, and the single frameless application window.
 */
import Electrobun, {
  ApplicationMenu,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/bun";
import { join } from "node:path";
import { KipDatabase } from "./storage/db";
import { ModelRegistry } from "./agent/model-registry";
import { KipOrchestrator } from "./agent/pi-orchestrator";
import { createKipRpc } from "./rpc-handler";
import type { AgentStreamEnvelope } from "../shared/types";
import { triggerSync } from "./sync/s3-sync";
import { prepareCefUserDataDir } from "./system/cef-guard";
import { NotchIndicator, type NotchState } from "./system/notch";
import { applyWindowsDpiAwareness } from "./system/windows-dpi";
import { UpdateChecker } from "./system/update-checker";
import { createUpdateInstaller } from "./system/update-installer";
import { PluginWindows } from "./plugins/windows";
import {
  disposePlugins,
  startPlugins,
  afterGatewayRequest,
  beforeGatewayRequest,
} from "./plugins/registry";

// Must run before the first window exists, so it cannot move below.
applyWindowsDpiAwareness();

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const SHUTDOWN_TIMEOUT_MS = 2_500;
const APP_IDENTIFIER = "ai.kip.desktop";

process.on("unhandledRejection", (reason) => {
  console.error(
    "Unhandled rejection:",
    reason instanceof Error ? reason.message : reason,
  );
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error.message);
});

async function readLocalVersion(): Promise<string> {
  try {
    const version = await Updater.localInfo.version();
    return version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function readLocalChannel(): Promise<string> {
  try {
    const channel = await Updater.localInfo.channel();
    return channel || "stable";
  } catch {
    return "stable";
  }
}

function resolveCefDir(channel: string): string | null {
  try {
    const userData = Utils.paths.userData;
    if (userData && userData.includes(APP_IDENTIFIER)) {
      return join(userData, "CEF");
    }
  } catch {
    // Fall back to explicit identifier/channel path below.
  }
  try {
    return join(Utils.paths.appData, APP_IDENTIFIER, channel, "CEF");
  } catch {
    return null;
  }
}

async function prepareCefProfile(channel: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const cefDir = resolveCefDir(channel);
  if (!cefDir) return;
  const result = await prepareCefUserDataDir(cefDir);
  if (result.status === "cleaned") {
    console.warn(
      `Removed stale CEF lock (${result.removed.join(", ")}) from exited process ${result.pid ?? "unknown"}.`,
    );
  } else if (result.status === "live") {
    console.warn(
      `Another Kip process (pid ${result.pid}) already holds the CEF profile lock.`,
    );
  }
}

const database = new KipDatabase();
const [registry, localVersion, updateChannel] = await Promise.all([
  ModelRegistry.create(database),
  readLocalVersion(),
  readLocalChannel(),
]);

const streamHolder: { send: (payload: AgentStreamEnvelope) => void } = {
  send: () => {},
};
const orchestrator = new KipOrchestrator(
  database,
  registry,
  (threadId, event) => {
    streamHolder.send({ threadId, event });
  },
  {
    // A local gateway can stop itself when unused and come back on the next run.
    providerActivity: {
      before: (providerId) => beforeGatewayRequest(database, providerId),
      after: (providerId) => afterGatewayRequest(database, providerId),
    },
  },
);

const windowRef: { current: BrowserWindow | null } = { current: null };
const updateChecker = new UpdateChecker({
  // Dev bundles carry a stale version.json, so local builds stay quiet unless
  // KIP_UPDATE_CURRENT_VERSION pins the version explicitly.
  currentVersion: process.env.KIP_UPDATE_CURRENT_VERSION ?? localVersion,
  installer: createUpdateInstaller({
    // Restarting for an update stops any running agent; the view warns first.
    onQuit: () => {
      quitCleanly();
    },
  }),
  onStatus: (status) => rpc.send.updateStatus(status),
});
const pluginWindows = new PluginWindows(
  database,
  process.platform === "darwin" ? "cef" : "native",
);
const rpc = createKipRpc({
  database,
  registry,
  orchestrator,
  updateChecker,
  pluginWindows,
  windowRef,
});
// Background services a plugin owns, only for providers the user already added.
startPlugins(database);
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
let isShuttingDown = false;
let readyToQuit = false;
let quitScheduled = false;

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
  if (process.env.KIP_NOTCH_PREVIEW)
    return notch.set(process.env.KIP_NOTCH_PREVIEW as NotchState);
  notch.set(attention.focused ? "idle" : topThread().state);
}

function trackAttention(payload: AgentStreamEnvelope): void {
  const { threadId, event } = payload;
  if (event.kind === "text_delta" || event.kind === "thinking_delta") return;
  const calls = attention.awaiting.get(threadId) ?? new Set<string>();
  attention.awaiting.set(threadId, calls);
  if (event.kind === "tool_approval_required")
    calls.add(event.approval.toolCallId);
  else if (event.kind === "tool_approved" || event.kind === "tool_end")
    calls.delete(event.toolCallId);
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
  if (
    payload.event.kind === "turn_complete" &&
    database.getSetting("sync.enabled", false)
  ) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      rpc.send.syncStatus({ state: "running" });
      void triggerSync(database)
        .then(() => rpc.send.syncStatus({ state: "idle" }))
        .catch((error: unknown) =>
          rpc.send.syncStatus({
            state: "error",
            message:
              error instanceof Error ? error.message : "Automatic sync failed",
          }),
        );
    }, 10_000);
  }
};

async function resolveViewUrl(channel: string): Promise<string> {
  if (process.env.KIP_DEV_SERVER === "1" && channel === "dev") {
    try {
      const response = await fetch(DEV_SERVER_URL, {
        method: "HEAD",
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server is not running; loading the built view.");
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

await prepareCefProfile(updateChannel);
const viewUrl = await resolveViewUrl(updateChannel);

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "Kip",
    url: viewUrl,
    rpc,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    renderer: process.platform === "darwin" ? "cef" : "native",
    trafficLightOffset: { x: 16, y: 18 },
    frame: { x: 120, y: 90, width: 1180, height: 780 },
  });
  windowRef.current = win;

  // Wire close immediately so an early close cannot strand a windowless process.
  win.on("close", () => {
    if (windowRef.current === win) windowRef.current = null;
    quitCleanly();
  });

  // Windows and Linux draw their own window buttons, so the view needs to know
  // whether the window is maximized to pick the right icon.
  const pushWindowState = (): void => {
    rpc.send.windowState({ maximized: win.isMaximized() });
  };
  win.on("resize", pushWindowState);
  win.on("focus", () => {
    attention.focused = true;
    attention.done.clear();
    refreshNotch();
  });
  win.on("blur", () => {
    attention.focused = false;
    refreshNotch();
  });

  try {
    win.show();
    win.activate();
  } catch {
    // Best-effort foreground activation.
  }
  return win;
}

function focusMainWindow(): void {
  if (isShuttingDown) return;
  const win = windowRef.current;
  if (!win) {
    createMainWindow();
    return;
  }
  try {
    if (win.isMinimized()) win.unminimize();
  } catch {
    // Ignore if the native window cannot report minimized state.
  }
  try {
    win.show();
    win.activate();
  } catch {
    // If the native handle is gone, fall back to a fresh window.
    windowRef.current = null;
    createMainWindow();
  }
}

createMainWindow();

// macOS Dock / Spotlight / `open -a Kip` sends reopen when Kip is already running
// (for example hidden with Cmd+H, minimized, or on another Space).
Electrobun.events.on("reopen", () => {
  focusMainWindow();
});

// Run bounded cleanup before native Cmd+Q exits so sidecars, notch window,
// and SQLite are released cleanly without leaving a zombie holding CEF locks.
Electrobun.events.on(
  "before-quit",
  (event: { response?: { allow: boolean } }) => {
    if (readyToQuit) return;
    event.response = { allow: false };
    quitCleanly();
  },
);

if (updateChannel === "dev" && !process.env.KIP_UPDATE_CURRENT_VERSION) {
  console.log("Update checks are off for the dev channel.");
} else {
  updateChecker.start();
}

notch = new NotchIndicator(() => {
  const { threadId } = topThread();
  focusMainWindow();
  if (threadId) rpc.send.focusThread({ threadId });
});
refreshNotch();

let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  isShuttingDown = true;
  shutdownPromise = (async () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    updateChecker.stop();
    if (notch) {
      notch.dispose();
      notch = null;
    }
    try {
      await pluginWindows.disposeAll();
    } catch {
      // Plugin windows are best-effort on the way out.
    }
    try {
      await disposePlugins();
    } catch {
      // Background plugin processes are best-effort on the way out.
    }
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

function quitCleanly(): void {
  if (quitScheduled) return;
  quitScheduled = true;
  // Bound shutdown so a hung plugin or session cannot strand a windowless process.
  const failsafe = setTimeout(() => {
    readyToQuit = true;
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS + 6_000);
  failsafe.unref();

  void Promise.race([shutdown(), Bun.sleep(SHUTDOWN_TIMEOUT_MS)]).finally(
    () => {
      readyToQuit = true;
      Utils.quit();
    },
  );
}

process.on("SIGINT", () => {
  quitCleanly();
});
process.on("SIGTERM", () => {
  quitCleanly();
});
process.on("beforeExit", () => {
  void shutdown();
});

console.log("Kip is ready.");
