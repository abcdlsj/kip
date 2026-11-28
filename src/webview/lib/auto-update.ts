/**
 * Frontend Seamless Auto-Update coordinator with Smart Restart Gate.
 *
 * Keeps a single authoritative state across the sidebar pill, top-bar compact
 * pill, settings check button, and command palette.
 *
 * Smart Restart Gate pauses calmly at `↻ vX.Y.Z` if:
 *  1. An AI agent run / streaming response is active, OR
 *  2. The user typed within the last 2 seconds, OR
 *  3. Download + verification took longer than 8 seconds.
 */
import type { UpdateStatus } from "../../shared/types";
import { onUpdateStatus, request } from "../rpc-client";
import { useUiStore } from "../stores/ui-store";
import {
  captureUpdateHandoffState,
  hasActiveAgentRun,
} from "./update-handoff";

const SMART_AUTO_RESTART_WINDOW_MS = 8_000;
const RECENT_INPUT_GUARD_MS = 2_000;

let clickedAt: number | null = null;
let lastInputAt = 0;
let committing = false;

export function initAutoUpdateListeners(): () => void {
  const markInput = () => {
    lastInputAt = Date.now();
  };
  window.addEventListener("keydown", markInput, true);
  window.addEventListener("input", markInput, true);

  const offStatus = onUpdateStatus((next) => {
    handleIncomingStatus(next);
  });

  return () => {
    window.removeEventListener("keydown", markInput, true);
    window.removeEventListener("input", markInput, true);
    offStatus();
  };
}

function handleIncomingStatus(next: UpdateStatus): void {
  const ui = useUiStore.getState();
  ui.setUpdate(next);

  if (next.state === "ready_to_restart" && !committing) {
    const withinWindow =
      clickedAt !== null && Date.now() - clickedAt <= SMART_AUTO_RESTART_WINDOW_MS;
    const recentlyTyped = Date.now() - lastInputAt < RECENT_INPUT_GUARD_MS;
    const agentBusy = hasActiveAgentRun();

    if (withinWindow && !recentlyTyped && !agentBusy) {
      clickedAt = null;
      void commitUpdateRestart();
    }
  }
}

export async function commitUpdateRestart(): Promise<void> {
  if (committing) return;
  committing = true;
  const ui = useUiStore.getState();
  ui.setUpdateFlushing(true);
  ui.setUpdateNotice(null);

  try {
    const appState = captureUpdateHandoffState();
    await request("updaterCommitRestart", { appState });
  } catch (error) {
    committing = false;
    ui.setUpdateFlushing(false);
    const message = error instanceof Error ? error.message : String(error);
    ui.setUpdateNotice(`Update paused: ${message}`);
  }
}

export async function activateUpdate(): Promise<void> {
  const ui = useUiStore.getState();
  const status = ui.update;
  if (!status || ui.updateFlushing) return;

  if (
    status.state === "downloading" ||
    status.state === "verifying" ||
    status.state === "installing"
  ) {
    return;
  }

  if (status.state === "ready_to_restart") {
    let agentRunning = hasActiveAgentRun();
    if (!agentRunning) {
      try {
        agentRunning = (await request("getRunningThreadCount", undefined)) > 0;
      } catch {
        // Fall back to local store state if RPC fails.
      }
    }
    if (agentRunning) {
      ui.setUpdateNotice("Waiting for active agent run to finish before restarting");
      return;
    }
    await commitUpdateRestart();
    return;
  }

  if (!status.available) return;

  if (!status.can_apply) {
    await request("openUpdatePage", undefined);
    return;
  }

  ui.setUpdateNotice(null);
  clickedAt = Date.now();
  try {
    const next = await request("updaterDownloadUpdate", undefined);
    handleIncomingStatus(next);
  } catch (error) {
    clickedAt = null;
    const message = error instanceof Error ? error.message : String(error);
    ui.setUpdate({
      ...status,
      state: "error",
      progress: 0,
      error: message,
    });
  }
}

export async function checkForUpdatesNow(): Promise<UpdateStatus | null> {
  const ui = useUiStore.getState();
  ui.setUpdateNotice(null);
  try {
    const next = await request("updaterCheckNow", undefined);
    handleIncomingStatus(next);
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.setUpdateNotice(`Check failed: ${message}`);
    return null;
  }
}
