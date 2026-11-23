/**
 * Which desktop platform the view is running on, plus platform-native keyboard
 * shortcut labels so macOS shows `⌘` while Windows and Linux show `Ctrl+`.
 */
export type Platform = "mac" | "win" | "linux";

function detect(): Platform {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Windows")) return "win";
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X"))
    return "mac";
  return "linux";
}

export const platform = detect();

/** macOS keeps its native traffic lights; elsewhere the view draws the buttons. */
export const needsWindowControls = platform !== "mac";

export const isMac = platform === "mac";

/** Primary modifier prefix (`⌘` on macOS, `Ctrl+` elsewhere). */
export const modKey = isMac ? "⌘" : "Ctrl+";

/** Format a shortcut like `⌘K` (macOS) or `Ctrl+K` (Windows/Linux). */
export function modShortcut(key: string): string {
  return `${modKey}${key}`;
}

/** Primary submit / approve chord (`⌘↵` on macOS, `Ctrl+↵` elsewhere). */
export const modEnter = isMac ? "⌘↵" : "Ctrl+↵";

export function applyPlatform(): void {
  document.documentElement.dataset.platform = platform;
}
