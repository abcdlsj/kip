/**
 * The idle countdown that lets the gemini2api sidecar go quiet. No real clock:
 * the schedule is injected, so each case fires the timer by hand.
 */
import { describe, expect, test } from "bun:test";
import { IdleGuard, formatDelay } from "../src/bun/plugins/gemini2api/idle";

interface Scheduled {
  run: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

function harness(options: {
  delayMs?: (() => number | null) | null;
  busy?: boolean;
  running?: boolean;
}) {
  const scheduled: Scheduled[] = [];
  const pauses: number[] = [];
  const logs: string[] = [];
  const state = {
    delayMs:
      options.delayMs === null
        ? () => null
        : (options.delayMs ?? (() => 60_000)),
    busy: options.busy ?? false,
    running: options.running ?? true,
  };
  let guard: IdleGuard;
  guard = new IdleGuard({
    delayMs: () => state.delayMs(),
    busy: () => state.busy,
    running: () => state.running,
    pause: async () => {
      pauses.push(Date.now());
    },
    log: (line) => logs.push(line),
    schedule: (run, ms) => {
      const entry: Scheduled = {
        ms,
        cancelled: false,
        fired: false,
        run: () => {
          entry.fired = true;
          run();
        },
      };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  });
  /** The timer that is still armed, if any. */
  const live = () =>
    scheduled.filter((entry) => !entry.cancelled && !entry.fired);
  return { guard, scheduled, live, pauses, logs, state };
}

async function fire(entry: Scheduled): Promise<void> {
  entry.run();
  // `fire` is async: let its pause and log run before asserting.
  await Bun.sleep(0);
}

describe("gemini2api idle pause", () => {
  test("does nothing while pausing is off, and counts down once it is on", async () => {
    const { guard, live, state } = harness({ delayMs: null });
    guard.touch();
    expect(live()).toHaveLength(0);

    state.delayMs = () => 30 * 60_000;
    guard.touch();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.ms).toBe(30 * 60_000);
  });

  test("pauses a running gateway and says how long it waited", async () => {
    const { guard, live, pauses, logs } = harness({
      delayMs: () => 2 * 60 * 60_000,
    });
    guard.touch();
    await fire(live()[0]!);
    expect(pauses).toHaveLength(1);
    expect(logs[0]).toBe("paused after 2h without a run");
  });

  test("leaves a gateway that is already down alone", async () => {
    const { guard, live, pauses } = harness({ running: false });
    guard.touch();
    await fire(live()[0]!);
    expect(pauses).toHaveLength(0);
  });

  test("waits out another window while a run is in flight", async () => {
    const { guard, live, pauses, state } = harness({ busy: true });
    guard.touch();
    await fire(live()[0]!);
    expect(pauses).toHaveLength(0);
    // Re-armed, not fired again: the run still owns the gateway.
    expect(live()).toHaveLength(1);

    state.busy = false;
    await fire(live()[0]!);
    expect(pauses).toHaveLength(1);
  });

  test("touch restarts the countdown, and dispose stops it", async () => {
    const { guard, live, pauses } = harness({});
    guard.touch();
    const first = live()[0]!;
    guard.touch();
    expect(first.cancelled).toBe(true);
    expect(live()).toHaveLength(1);

    guard.cancel();
    expect(live()).toHaveLength(0);
    expect(pauses).toHaveLength(0);
  });

  test("reads human durations", () => {
    expect(formatDelay(5 * 60_000)).toBe("5m");
    expect(formatDelay(2 * 60 * 60_000)).toBe("2h");
    expect(formatDelay(90 * 60_000)).toBe("1.5h");
  });
});
