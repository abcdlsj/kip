/** Kip's theme resolution, shared by the main view and plugin pages. */
import type { ThemeMode } from "../../shared/types";

export function resolvedTheme(theme: ThemeMode): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: ThemeMode): void {
  const resolved = resolvedTheme(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

/** Re-applies a `system` theme when the OS preference flips. Idempotent. */
export function watchSystemTheme(current: () => ThemeMode): void {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (current() === "system") applyTheme("system");
    });
}
