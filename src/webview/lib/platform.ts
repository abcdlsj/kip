/**
 * Which desktop platform the view is running on.
 *
 * The view cannot read `process.platform`, and the UA is stable for the process
 * lifetime, so it is read once here. CSS keys off `<html data-platform>` (see
 * styles/tokens.css) and the window buttons render only where the window manager
 * does not draw them.
 */
export type Platform = "mac" | "win" | "linux";

function detect(): Platform {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Windows")) return "win";
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X")) return "mac";
  return "linux";
}

export const platform = detect();

/** macOS keeps its native traffic lights; elsewhere the view draws the buttons. */
export const needsWindowControls = platform !== "mac";

export function applyPlatform(): void {
  document.documentElement.dataset.platform = platform;
}
