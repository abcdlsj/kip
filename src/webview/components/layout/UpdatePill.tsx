import type { UpdateStatus } from "../../../shared/types";
import { activateUpdate } from "../../lib/auto-update";
import { useUiStore } from "../../stores/ui-store";

interface UpdatePillProps {
  compact?: boolean;
}

/**
 * Ultra-minimal, zero-interruption update pill.
 * Completely hidden when idle or checking; shows compact progress while
 * downloading, a calm restart cue if deferred by the Smart Restart Gate,
 * or a one-click trigger when an update is available.
 */
export function UpdatePill({ compact = false }: UpdatePillProps) {
  const rawStatus = useUiStore((state) => state.update);
  const flushing = useUiStore((state) => state.updateFlushing);
  const notice = useUiStore((state) => state.updateNotice);

  if (!rawStatus) return null;

  const status: UpdateStatus = flushing
    ? { ...rawStatus, state: "flushing" }
    : rawStatus;

  const visible =
    status.available ||
    status.state === "downloading" ||
    status.state === "verifying" ||
    status.state === "ready_to_restart" ||
    status.state === "flushing" ||
    status.state === "installing";

  if (!visible) return null;

  const busy =
    status.state === "downloading" ||
    status.state === "verifying" ||
    status.state === "flushing" ||
    status.state === "installing";

  const versionLabel = status.latest ?? "";
  let label: string;
  let title: string;

  switch (status.state) {
    case "downloading": {
      const pct = Math.max(0, Math.min(99, status.progress || 0));
      label = `↓ ${pct}%`;
      title = `Downloading v${versionLabel} (${pct}%)`;
      break;
    }
    case "verifying":
      label = "↓ 99%";
      title = `Verifying signature for v${versionLabel}…`;
      break;
    case "ready_to_restart":
      label = `↻ v${versionLabel}`;
      title =
        notice ??
        `v${versionLabel} ready — click to save state & restart cleanly`;
      break;
    case "flushing":
    case "installing":
      label = "↻ …";
      title = `Saving state & restarting into v${versionLabel}…`;
      break;
    case "error":
      label = `↑ v${versionLabel} !`;
      title = status.error
        ? `Update failed: ${status.error} — click to retry`
        : "Update failed — click to retry";
      break;
    default:
      label = `↑ v${versionLabel}`;
      title = status.can_apply
        ? `Update to v${versionLabel} — click to download & restart`
        : `v${versionLabel} available — click to open GitHub release`;
      break;
  }

  return (
    <button
      type="button"
      className={[
        "update-pill",
        "no-drag",
        "tabular-nums",
        compact ? "update-pill--compact" : "",
        busy ? "update-pill--busy" : "",
        status.state === "ready_to_restart" ? "update-pill--ready" : "",
        status.state === "error" ? "update-pill--error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={title}
      title={title}
      onClick={() => void activateUpdate()}
    >
      {label}
    </button>
  );
}
