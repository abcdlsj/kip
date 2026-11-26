/**
 * The gemini2api window. A plugin page: it renders whatever state its
 * controller returns and forwards clicks as named actions, using Kip's own
 * stylesheet so it looks like the rest of the app.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Download,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import "../../styles/globals.css";
import type { GeminiPageState } from "../../../shared/plugins/gemini2api";
import { connectPluginPage } from "../../lib/plugin-page-client";

function StatusDot({ state }: { state: GeminiPageState }) {
  const watchdogState = state.external ? undefined : state.watchdog?.state;
  const { label, color } = !state.installed
    ? { label: "Not installed", color: "var(--text-muted)" }
    : watchdogState === "restarting"
      ? { label: "Restarting…", color: "var(--status-warn)" }
      : watchdogState === "degraded"
        ? { label: "Degraded", color: "var(--status-err)" }
        : watchdogState === "unhealthy"
          ? { label: "Unhealthy", color: "var(--status-err)" }
          : state.running
            ? { label: "Running", color: "var(--status-ok)" }
            : { label: "Stopped", color: "var(--status-warn)" };
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      {label}
      {state.running && state.port !== null && (
        <span className="font-mono text-[11.5px] text-[var(--text-muted)]">
          127.0.0.1:{state.port}
          {state.external ? " · your server" : ""}
        </span>
      )}
    </span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
        {label}
      </span>
      <span className="min-w-0 break-words text-right font-mono text-[11.5px] text-[var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

function App() {
  const [state, setState] = useState<GeminiPageState | null>(null);
  const [action, setAction] = useState<ReturnType<
    typeof connectPluginPage
  > | null>(null);

  useEffect(() => {
    setAction(connectPluginPage<GeminiPageState>((next) => setState(next)));
  }, []);

  const run = useCallback(
    (name: string) => {
      void action?.action(name).catch(() => undefined);
    },
    [action],
  );

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  const busy = state.busy !== null;
  const installed = state.installed || state.binaryPath !== null;

  return (
    <div className="thin-scroll h-full overflow-y-auto bg-[var(--bg-window)] px-7 py-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-[-0.01em]">
            gemini2api
          </h1>
          <p className="mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            The Gemini web app behind an OpenAI-compatible API, running on this
            machine. Kip installs it, points it at your Firefox session, and
            starts it on loopback.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <StatusDot state={state} />
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            {state.version ? `v${state.version}` : "no binary"} ·{" "}
            {state.platform}
          </p>
        </div>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary h-8 rounded-[8px] px-3 text-[12px]"
          disabled={busy}
          onClick={() => run("install")}
        >
          {busy && state.busy === "install" ? (
            <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <Download size={12} strokeWidth={1.5} />
          )}
          {state.installed ? "Update" : "Install"}
        </button>
        <button
          type="button"
          className="btn-secondary h-8 rounded-[8px] px-3 text-[12px]"
          disabled={busy || !installed || state.running}
          onClick={() => run("start")}
        >
          {busy && state.busy === "start" ? (
            <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <Play size={12} strokeWidth={1.5} />
          )}
          Start
        </button>
        <button
          type="button"
          className="btn-secondary h-8 rounded-[8px] px-3 text-[12px]"
          disabled={busy || !state.running}
          onClick={() => run("stop")}
        >
          <Square size={11} strokeWidth={1.5} />
          Stop
        </button>
        {!state.external && installed && (
          <button
            type="button"
            className="btn-secondary h-8 rounded-[8px] px-3 text-[12px]"
            disabled={
              busy ||
              (!state.running &&
                state.watchdog?.state !== "degraded" &&
                state.watchdog?.state !== "unhealthy")
            }
            onClick={() => run("restart")}
          >
            {busy && state.busy === "restart" ? (
              <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
            ) : (
              <RotateCcw size={11} strokeWidth={1.5} />
            )}
            Restart
          </button>
        )}
        <button
          type="button"
          className="btn-secondary h-8 rounded-[8px] px-3 text-[12px]"
          disabled={busy}
          onClick={() => run("import-cookies")}
        >
          <UserRoundCheck size={12} strokeWidth={1.5} />
          Use Firefox session
        </button>
        <button
          type="button"
          className="btn-ghost h-8 rounded-[8px] px-2.5 text-[12px]"
          disabled={busy}
          onClick={() => run("refresh")}
          title="Refresh this page"
        >
          <RefreshCw
            size={12}
            strokeWidth={1.5}
            className={busy ? "animate-spin" : undefined}
          />
        </button>
        <button
          type="button"
          className="btn-ghost ml-auto h-8 rounded-[8px] px-2.5 text-[12px] text-[var(--text-muted)]"
          disabled={busy || !state.installed}
          onClick={() => run("uninstall")}
          title="Remove the downloaded binary"
        >
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </div>

      {state.error && (
        <div className="mt-3 rounded-[9px] border border-[color-mix(in_srgb,var(--status-err)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-err)_8%,transparent)] px-3 py-2">
          <p className="text-[12px] leading-relaxed text-[var(--status-err)]">
            {state.error.message}
          </p>
          {state.error.hint && (
            <p className="mt-1.5 whitespace-pre-line text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
              {state.error.hint}
            </p>
          )}
        </div>
      )}

      <section className="mt-5 rounded-[11px] border hairline px-3.5 py-2.5">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">
          Gateway
        </h2>
        <div className="mt-1">
          <Row
            label="Binary"
            value={state.binaryPath ?? "not downloaded — press Install"}
          />
          <Row
            label="Account"
            value={
              state.health
                ? state.health.accounts.length
                  ? state.health.accounts
                      .map((account) => `${account.id} · ${account.status}`)
                      .join("  ")
                  : "none signed in"
                : "—"
            }
          />
          <Row
            label="Cookies"
            value={
              state.cookieCount
                ? `${state.cookieCount} from ${state.cookieProfile ?? "Firefox"}`
                : "none — press Use Firefox session"
            }
          />
          <Row
            label="Models"
            value={
              state.models.length
                ? `${state.models.length} · ${state.models
                    .slice(0, 4)
                    .map((model) => model.id)
                    .join(", ")}${state.models.length > 4 ? "…" : ""}`
                : "—"
            }
          />
          {!state.external && state.watchdog && (
            <Row
              label="Watchdog"
              value={
                state.watchdog.state === "degraded"
                  ? `degraded · ${state.watchdog.restartCount}/${state.watchdog.maxRestarts} restarts`
                  : state.watchdog.state === "restarting"
                    ? `restarting (${state.watchdog.restartCount}/${state.watchdog.maxRestarts})`
                    : state.watchdog.restartCount > 0
                      ? `${state.watchdog.state} · ${state.watchdog.restartCount}/${state.watchdog.maxRestarts} restarts`
                      : state.watchdog.state
              }
            />
          )}
          {!state.external && state.watchdog?.lastFailure && (
            <Row label="Last issue" value={state.watchdog.lastFailure} />
          )}
        </div>
      </section>

      <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        Kip writes <span className="font-mono">config.yaml</span> and a random
        key in this plugin's data directory; cookies come from the Firefox
        profile where you signed in to gemini.google.com. The gateway keeps
        running until you press Stop or quit Kip.{" "}
        <span className="font-mono">
          {state.homepage.replace("https://", "")}
        </span>
      </p>

      {state.logs.length > 0 && (
        <section className="mt-4 rounded-[11px] border hairline">
          <h2 className="border-b hairline px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">
            Log · {state.logs.length}{" "}
            {state.logs.length === 1 ? "line" : "lines"}
          </h2>
          <pre className="thin-scroll max-h-[190px] overflow-auto px-3.5 py-2 font-mono text-[11px] leading-[1.55] text-[var(--text-secondary)]">
            {state.logs.join("\n")}
          </pre>
        </section>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
