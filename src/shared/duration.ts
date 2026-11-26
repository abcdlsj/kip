/**
 * Shared human-readable duration formatters for GUI, TUI, and CLI output.
 *
 * Sub-threshold or missing durations return `null` so the UI omits the timing
 * suffix (e.g. "Thought" instead of "Thought for 0.0s", or hiding "0ms" on
 * instant/denied tool calls).
 */

function formatMinutesSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Formats thinking duration. Returns `null` under 500ms so buffered/instant
 * thinking bursts never show "0.0s" or noisy millisecond figures.
 */
export function formatThinkingDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 500) return null;
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return formatMinutesSeconds(totalSeconds);
}

/**
 * Formats aggregate run/work duration ("Worked for ..."). Returns `null` under
 * 1 second so short turns display plain "Worked" rather than "0s" or "<1s".
 */
export function formatWorkDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1_000) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return formatMinutesSeconds(totalSeconds);
}

/**
 * Formats individual tool call duration. Returns `null` when missing or < 1ms
 * so instant/denied tools never render a misleading "0ms".
 */
export function formatToolDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1) return null;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  return formatMinutesSeconds(Math.round(ms / 1000));
}
