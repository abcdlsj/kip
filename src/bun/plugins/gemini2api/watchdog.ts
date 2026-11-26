/**
 * Process health supervisor for a locally managed gateway sidecar.
 *
 * Detects unhealthy states from request failures (stream stalls, timeouts,
 * transport drops, 502/503/504), unexpected process exits, and periodic
 * `/health` probes when idle. Restarts are deduplicated (single-flight) and
 * bounded by a sliding-window budget with backoff to prevent restart storms.
 */
import type {
  GeminiWatchdogHealthState,
  GeminiWatchdogState,
} from "../../../shared/plugins/gemini2api";
import type {
  GatewayFailureKind,
  GatewayRecoveryResult,
  GatewayRequestFailure,
  GatewayStatusNotice,
} from "../types";

export interface WatchdogTimer {
  cancel(): void;
}

export interface GatewayWatchdogOptions {
  /** Human label used in status messages and logs (e.g. "gemini2api"). */
  label: string;
  /** True while at least one request is actively in flight against this gateway. */
  busy: () => boolean;
  /** True when a Kip-owned process handle or adopted PID is currently alive. */
  isProcessRunning: () => boolean;
  /** Probes `/health` on the managed loopback port. */
  checkHealth: () => Promise<boolean>;
  /** Stops the hung/stale process group and starts a clean instance. */
  restartProcess: () => Promise<void>;
  /** Writes a diagnostic line to the plugin log. */
  log: (line: string) => void;
  /** Maximum automatic restarts allowed within `windowMs`. Default: 3. */
  maxRestarts?: number;
  /** Sliding window length in ms for `maxRestarts`. Default: 5 minutes. */
  windowMs?: number;
  /** Delays before attempt 1, 2, 3... in ms. Default: [0, 2000, 5000]. */
  backoffMs?: readonly number[];
  /** Active `/health` probe interval while running & idle. 0 disables probing. Default: 60s. */
  probeIntervalMs?: number;
  /** Consecutive `/health` failures while process is alive before restarting. Default: 2. */
  probeFailureThreshold?: number;
  /** Clock function; injected for deterministic tests. */
  now?: () => number;
  /** Timer scheduler; injected for deterministic tests. */
  schedule?: (run: () => void, ms: number) => WatchdogTimer;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS: readonly number[] = [0, 2_000, 5_000];
const DEFAULT_PROBE_INTERVAL_MS = 60_000;
const DEFAULT_PROBE_FAILURE_THRESHOLD = 2;

const defaultSchedule = (run: () => void, ms: number): WatchdogTimer => {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
};

export type FailureAction = "ignore" | "restart" | "check_health";

const IGNORE_PATTERN =
  /\b(?:400|401|403|404|422|429)\b|retry cancelled|request (?:was )?aborted|signed out|no gemini account|guest session|unauthenticated|unauthorized|forbidden|invalid api key|rate.?limit|too many requests|quota|billing|context.?length|context overflow/i;

const RESTART_PATTERN =
  /timed? out|timeout|stalled|no data|etimedout|esockettimedout|econnrefused|econnreset|epipe|econnaborted|connection.?refused|connection.?reset|connection.?error|connection.?lost|socket hang up|socket connection was closed|other side closed|fetch failed|unable to connect|reset before headers|stream ended without|stream disconnected|premature close|cut short|\b(?:502|503|504)\b|bad gateway|service unavailable|gateway timeout/i;

const SERVER_ERROR_PATTERN =
  /\b500\b|internal.?server.?error|server.?error|internal.?error/i;

/**
 * Classifies a request failure into:
 * - `ignore`: auth, 4xx, rate limit, or user abort — never restart the sidecar
 * - `restart`: stall, timeout, transport error, or 502/503/504 — restart sidecar
 * - `check_health`: 500 or unrecognized error — restart only if `/health` fails
 */
export function classifyGatewayFailure(
  message: string,
  hintKind?: GatewayFailureKind,
): FailureAction {
  if (IGNORE_PATTERN.test(message)) return "ignore";
  if (
    hintKind === "stall" ||
    hintKind === "timeout" ||
    hintKind === "transport"
  ) {
    return "restart";
  }
  if (RESTART_PATTERN.test(message)) return "restart";
  if (hintKind === "server_error" || SERVER_ERROR_PATTERN.test(message)) {
    return "check_health";
  }
  return "ignore";
}

function formatWindow(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1 && ms % 60_000 === 0) return `${minutes}m`;
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return `${seconds}s`;
}

export class GatewayWatchdog {
  private readonly maxRestarts: number;
  private readonly windowMs: number;
  private readonly backoffMs: readonly number[];
  private readonly probeIntervalMs: number;
  private readonly probeFailureThreshold: number;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => WatchdogTimer;

  private state: GeminiWatchdogHealthState = "stopped";
  private desiredRunning = false;
  private restartTimestamps: number[] = [];
  private lastRestartAt: number | null = null;
  private lastFailure: string | null = null;
  private nextRetryAt: number | null = null;
  private consecutiveFailures = 0;
  private consecutiveProbeFailures = 0;

  private inFlightRecovery: Promise<GatewayRecoveryResult> | null = null;
  private activeReporters = new Set<(notice: GatewayStatusNotice) => void>();
  private probeTimer: WatchdogTimer | null = null;
  private backoffCancel: (() => void) | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly options: GatewayWatchdogOptions) {
    this.maxRestarts = Math.max(1, options.maxRestarts ?? DEFAULT_MAX_RESTARTS);
    this.windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.backoffMs = options.backoffMs?.length
      ? options.backoffMs
      : DEFAULT_BACKOFF_MS;
    this.probeIntervalMs = Math.max(
      0,
      options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    );
    this.probeFailureThreshold = Math.max(
      1,
      options.probeFailureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD,
    );
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must never disrupt supervision.
      }
    }
  }

  private emitStatus(
    notice: GatewayStatusNotice,
    direct?: (notice: GatewayStatusNotice) => void,
  ): void {
    const targets = new Set(this.activeReporters);
    if (direct) targets.add(direct);
    for (const reporter of targets) {
      try {
        reporter(notice);
      } catch {
        // Best-effort status reporting.
      }
    }
  }

  private pruneWindow(currentTime = this.now()): void {
    const cutoff = currentTime - this.windowMs;
    this.restartTimestamps = this.restartTimestamps.filter((ts) => ts > cutoff);
    if (this.restartTimestamps.length < this.maxRestarts) {
      this.nextRetryAt = null;
      if (this.state === "degraded") {
        this.state = this.desiredRunning ? "unhealthy" : "stopped";
      }
    } else {
      this.nextRetryAt = this.restartTimestamps[0]! + this.windowMs;
    }
  }

  getSnapshot(): GeminiWatchdogState {
    this.pruneWindow();
    return {
      state: this.state,
      restartCount: this.restartTimestamps.length,
      maxRestarts: this.maxRestarts,
      windowMs: this.windowMs,
      lastRestartAt: this.lastRestartAt,
      lastFailure: this.lastFailure,
      nextRetryAt: this.nextRetryAt,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  isRecovering(): boolean {
    return this.inFlightRecovery !== null;
  }

  isDesiredRunning(): boolean {
    return this.desiredRunning;
  }

  markStarting(): void {
    this.desiredRunning = true;
    this.state = "starting";
    this.notify();
  }

  markHealthy(): void {
    this.desiredRunning = true;
    this.consecutiveFailures = 0;
    this.consecutiveProbeFailures = 0;
    this.lastFailure = null;
    this.state = "healthy";
    this.armProbe();
    this.notify();
  }

  /** Marks an intentional stop (Stop button, idle pause, or app shutdown). */
  markStopped(): void {
    this.desiredRunning = false;
    this.consecutiveProbeFailures = 0;
    this.cancelProbe();
    this.backoffCancel?.();
    this.backoffCancel = null;
    this.state = "stopped";
    this.notify();
  }

  /** Clears restart budget and degraded state (e.g. after manual user Start/Restart). */
  resetBudget(): void {
    this.restartTimestamps = [];
    this.consecutiveFailures = 0;
    this.consecutiveProbeFailures = 0;
    this.lastFailure = null;
    this.nextRetryAt = null;
    if (this.state === "degraded" || this.state === "unhealthy") {
      this.state = this.desiredRunning ? "starting" : "stopped";
    }
    this.notify();
  }

  dispose(): void {
    this.markStopped();
    this.activeReporters.clear();
    this.listeners.clear();
  }

  /**
   * Awaits any in-flight restart/recovery, abortable by `signal` so a user
   * cancelling a run never blocks on sidecar startup.
   */
  async waitForReady(signal?: AbortSignal): Promise<GatewayRecoveryResult | null> {
    const pending = this.inFlightRecovery;
    if (!pending) return null;
    if (!signal) return pending;
    if (signal.aborted) {
      throw new Error("Request was aborted");
    }
    return new Promise<GatewayRecoveryResult>((resolve, reject) => {
      const onAbort = () => reject(new Error("Request was aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** Handles an unexpected process exit reported by the service layer. */
  handleUnexpectedExit(code: number | null): void {
    if (!this.desiredRunning) return;
    const reason = `process exited unexpectedly (code ${code ?? "unknown"})`;
    this.lastFailure = reason;
    this.consecutiveFailures += 1;
    if (this.state !== "restarting" && this.state !== "degraded") {
      this.state = "unhealthy";
    }
    this.options.log(`watchdog: ${reason}`);
    this.notify();
    if (!this.inFlightRecovery) {
      void this.recover(reason);
    }
  }

  /** Handles a request failure reported by the orchestrator during a run. */
  async handleRequestFailure(
    failure: GatewayRequestFailure,
    reportStatus?: (notice: GatewayStatusNotice) => void,
  ): Promise<GatewayRecoveryResult> {
    const action = classifyGatewayFailure(failure.message, failure.kind);
    if (action === "ignore") {
      return { recovered: false };
    }
    if (action === "check_health") {
      const alive =
        this.options.isProcessRunning() && (await this.options.checkHealth());
      if (alive) {
        return { recovered: false };
      }
    }
    return this.recover(failure.message, reportStatus);
  }

  /**
   * Single-flight supervised restart with sliding-window budget and backoff.
   * Concurrent callers share the same recovery promise.
   */
  async recover(
    reason: string,
    reportStatus?: (notice: GatewayStatusNotice) => void,
  ): Promise<GatewayRecoveryResult> {
    if (reportStatus) this.activeReporters.add(reportStatus);
    if (this.inFlightRecovery) {
      if (this.state === "restarting") {
        reportStatus?.({
          phase: "restarting",
          message: `Restarting ${this.options.label} (${this.restartTimestamps.length}/${this.maxRestarts})…`,
          attempt: this.restartTimestamps.length,
          maxAttempts: this.maxRestarts,
        });
      }
      return this.inFlightRecovery;
    }

    const run = this.runRecovery(reason, reportStatus).finally(() => {
      if (this.inFlightRecovery === run) {
        this.inFlightRecovery = null;
      }
      this.activeReporters.clear();
    });
    this.inFlightRecovery = run;
    return run;
  }

  private async runRecovery(
    reason: string,
    directReporter?: (notice: GatewayStatusNotice) => void,
  ): Promise<GatewayRecoveryResult> {
    this.desiredRunning = true;
    const now = this.now();
    this.pruneWindow(now);
    this.lastFailure = reason;
    this.consecutiveFailures += 1;

    if (this.restartTimestamps.length >= this.maxRestarts) {
      this.state = "degraded";
      this.nextRetryAt = this.restartTimestamps[0]! + this.windowMs;
      // Deliberately phrased without words matching Pi's retryable transport
      // pattern so retries stop immediately when automatic restarts are spent.
      const degradedMessage = `${this.options.label} failed after ${this.maxRestarts} automatic restarts in ${formatWindow(this.windowMs)}. Open Settings → Plugins → ${this.options.label} to inspect logs and restart.`;
      this.options.log(`watchdog: ${degradedMessage}`);
      this.notify();
      this.emitStatus(
        {
          phase: "degraded",
          message: degradedMessage,
          attempt: this.maxRestarts,
          maxAttempts: this.maxRestarts,
        },
        directReporter,
      );
      return {
        recovered: false,
        abortRetry: true,
        message: degradedMessage,
      };
    }

    const attempt = this.restartTimestamps.length + 1;
    const delayMs =
      this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0;

    this.restartTimestamps.push(now);
    this.lastRestartAt = now;
    this.state = "restarting";
    this.cancelProbe();
    this.notify();

    const shortReason =
      reason.length > 120 ? `${reason.slice(0, 117)}…` : reason;
    const startMessage = `Restarting ${this.options.label} (${attempt}/${this.maxRestarts}) · ${shortReason}`;
    this.options.log(`watchdog: ${startMessage}`);
    this.emitStatus(
      {
        phase: "restarting",
        message: startMessage,
        attempt,
        maxAttempts: this.maxRestarts,
      },
      directReporter,
    );

    if (delayMs > 0) {
      const completed = await this.sleep(delayMs);
      if (!completed || !this.desiredRunning) {
        return { recovered: false, message: "Gateway restart cancelled" };
      }
    }

    try {
      await this.options.restartProcess();
      if (!this.desiredRunning) {
        return { recovered: false, message: "Gateway stopped during restart" };
      }
      this.consecutiveFailures = 0;
      this.consecutiveProbeFailures = 0;
      this.lastFailure = null;
      this.state = "healthy";
      this.armProbe();
      this.notify();
      const recoveredMessage = `${this.options.label} restarted and healthy`;
      this.options.log(`watchdog: ${recoveredMessage}`);
      this.emitStatus(
        {
          phase: "recovered",
          message: recoveredMessage,
          attempt,
          maxAttempts: this.maxRestarts,
        },
        directReporter,
      );
      return { recovered: true, message: recoveredMessage };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastFailure = detail;
      this.pruneWindow();
      const exhausted = this.restartTimestamps.length >= this.maxRestarts;
      this.state = exhausted ? "degraded" : "unhealthy";
      if (exhausted) {
        this.nextRetryAt = this.restartTimestamps[0]! + this.windowMs;
      } else if (this.desiredRunning) {
        this.armProbe();
      }
      this.options.log(`watchdog: restart failed: ${detail}`);
      this.notify();
      const failMessage = exhausted
        ? `${this.options.label} could not restart (${this.maxRestarts}/${this.maxRestarts} attempts in ${formatWindow(this.windowMs)}): ${detail}`
        : `${this.options.label} restart failed: ${detail}`;
      this.emitStatus(
        {
          phase: exhausted ? "degraded" : "unhealthy",
          message: failMessage,
          attempt,
          maxAttempts: this.maxRestarts,
        },
        directReporter,
      );
      return {
        recovered: false,
        abortRetry: exhausted,
        message: failMessage,
      };
    }
  }

  private sleep(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (this.backoffCancel === cancel) this.backoffCancel = null;
        resolve(ok);
      };
      const timer = this.schedule(() => finish(true), ms);
      const cancel = () => {
        timer.cancel();
        finish(false);
      };
      this.backoffCancel = cancel;
    });
  }

  private armProbe(): void {
    this.cancelProbe();
    if (!this.desiredRunning || this.probeIntervalMs <= 0) return;
    this.probeTimer = this.schedule(() => {
      this.probeTimer = null;
      void this.runProbe();
    }, this.probeIntervalMs);
  }

  private cancelProbe(): void {
    this.probeTimer?.cancel();
    this.probeTimer = null;
  }

  /** Exposed for tests and manual diagnostics; also invoked by the periodic probe timer. */
  async runProbe(): Promise<void> {
    if (!this.desiredRunning) return;
    if (this.inFlightRecovery) {
      this.armProbe();
      return;
    }
    this.pruneWindow();
    if (this.state === "degraded") {
      this.armProbe();
      return;
    }
    // Active runs are guarded directly by request/stream stall timeouts.
    if (this.options.busy()) {
      this.armProbe();
      return;
    }

    const healthy = await this.options.checkHealth().catch(() => false);
    if (!this.desiredRunning) return;

    if (healthy) {
      this.consecutiveProbeFailures = 0;
      if (this.state !== "healthy") {
        this.state = "healthy";
        this.lastFailure = null;
        this.notify();
      }
      this.armProbe();
      return;
    }

    if (!this.options.isProcessRunning()) {
      this.options.log("watchdog: probe found managed process not running");
      await this.recover("managed process exited unexpectedly");
      return;
    }

    this.consecutiveProbeFailures += 1;
    this.lastFailure = `health check unresponsive (${this.consecutiveProbeFailures}/${this.probeFailureThreshold})`;
    this.state = "unhealthy";
    this.options.log(`watchdog: ${this.lastFailure}`);
    this.notify();

    if (this.consecutiveProbeFailures >= this.probeFailureThreshold) {
      this.consecutiveProbeFailures = 0;
      await this.recover("health check unresponsive while process is alive");
      return;
    }

    this.armProbe();
  }
}
