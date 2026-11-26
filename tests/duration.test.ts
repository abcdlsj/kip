import { describe, expect, test } from "bun:test";
import {
  formatThinkingDuration,
  formatToolDuration,
  formatWorkDuration,
} from "../src/shared/duration";

describe("duration formatting", () => {
  test("formatThinkingDuration hides sub-500ms bursts and never renders 0.0s", () => {
    expect(formatThinkingDuration(undefined)).toBeNull();
    expect(formatThinkingDuration(Number.NaN)).toBeNull();
    expect(formatThinkingDuration(-10)).toBeNull();
    expect(formatThinkingDuration(0)).toBeNull();
    expect(formatThinkingDuration(12)).toBeNull();
    expect(formatThinkingDuration(49)).toBeNull();
    expect(formatThinkingDuration(499)).toBeNull();

    expect(formatThinkingDuration(500)).toBe("0.5s");
    expect(formatThinkingDuration(1_240)).toBe("1.2s");
    expect(formatThinkingDuration(9_940)).toBe("9.9s");
    expect(formatThinkingDuration(9_960)).toBe("10s");
    expect(formatThinkingDuration(45_200)).toBe("45s");
    expect(formatThinkingDuration(60_000)).toBe("1m");
    expect(formatThinkingDuration(75_000)).toBe("1m 15s");
  });

  test("formatWorkDuration hides sub-second runs and omits trailing 0s", () => {
    expect(formatWorkDuration(undefined)).toBeNull();
    expect(formatWorkDuration(0)).toBeNull();
    expect(formatWorkDuration(999)).toBeNull();

    expect(formatWorkDuration(1_000)).toBe("1s");
    expect(formatWorkDuration(59_400)).toBe("59s");
    expect(formatWorkDuration(60_000)).toBe("1m");
    expect(formatWorkDuration(125_000)).toBe("2m 5s");
  });

  test("formatToolDuration hides 0ms and formats ms, seconds, and minutes cleanly", () => {
    expect(formatToolDuration(undefined)).toBeNull();
    expect(formatToolDuration(0)).toBeNull();
    expect(formatToolDuration(0.4)).toBeNull();

    expect(formatToolDuration(1)).toBe("1ms");
    expect(formatToolDuration(245)).toBe("245ms");
    expect(formatToolDuration(1_000)).toBe("1.0s");
    expect(formatToolDuration(12_340)).toBe("12.3s");
    expect(formatToolDuration(60_000)).toBe("1m");
    expect(formatToolDuration(90_000)).toBe("1m 30s");
  });
});
