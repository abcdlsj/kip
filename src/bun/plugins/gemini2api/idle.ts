/**
 * Counts down while a managed gateway sits unused and shuts it down, then lets
 * the next run start it again.
 *
 * Nothing here talks to the user: the process is either up or it is not, and
 * the only trace is a line in the plugin's log. The countdown is restarted by
 * `touch()`, which the host calls around every run that reaches this provider.
 */

export interface IdleTimer {
  cancel(): void;
}

export interface IdleGuardOptions {
  /** How long to wait before pausing, or null when the user turned pausing off. */
  delayMs(): number | null;
  /** True while a run is in flight, so the process has to stay up. */
  busy(): boolean;
  /** True while the managed process is actually running. */
  running(): boolean;
  pause(): Promise<void>;
  log(line: string): void;
  /** `setTimeout` in production; injected so tests never wait on a clock. */
  schedule?: (run: () => void, ms: number) => IdleTimer;
}

const defaultSchedule = (run: () => void, ms: number): IdleTimer => {
  const timer = setTimeout(run, ms);
  // The app's lifetime is not this timer's business.
  (timer as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
};

export class IdleGuard {
  private timer: IdleTimer | null = null;

  constructor(private readonly options: IdleGuardOptions) {}

  /**
   * Restarts the countdown. Called after a run, after a start, and when the
   * plugin's settings change, because any of those resets what "idle" means.
   */
  touch(): void {
    this.cancel();
    const delay = this.options.delayMs();
    if (delay === null) return;
    const schedule = this.options.schedule ?? defaultSchedule;
    this.timer = schedule(() => {
      void this.fire(delay);
    }, delay);
  }

  cancel(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private async fire(delay: number): Promise<void> {
    this.timer = null;
    // A run that began inside the window owns the process; wait out another one.
    if (this.options.busy()) {
      this.touch();
      return;
    }
    if (!this.options.running()) return;
    await this.options.pause();
    this.options.log(`paused after ${formatDelay(delay)} without a run`);
  }
}

/** `120` minutes reads better as `2h` in the log than as a number of minutes. */
export function formatDelay(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}
