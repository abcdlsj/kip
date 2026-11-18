/**
 * Windows text rasterization fix.
 *
 * Electrobun's Windows binaries ship without any DPI-awareness manifest, so the
 * process starts out DPI-unaware: at 150%/200% display scaling Windows lays the
 * window out at 96 DPI and then bitmap-stretches the result. Every glyph arrives
 * pre-blurred and slightly bolder — CJK strokes worst, which is exactly the
 * "Microsoft YaHei looks fuzzy" report on a 4K screen.
 *
 * Wails avoids this by declaring DPI awareness in its exe manifest before the
 * process starts. We cannot patch Electrobun's binaries from here, but we do own
 * the process that creates the window: `ffi.request.createWindow` runs in this
 * Bun process, long after this module is imported, so opting in here is early
 * enough for Windows to take effect.
 *
 * System awareness (not per-monitor) is deliberate. Electrobun's native wrapper
 * handles no WM_DPICHANGED message, so per-monitor mode would leave the window
 * unrelaid when it moves to a display with a different scale factor. System
 * awareness keeps the current window geometry and only fixes the raster scale.
 */
import { dlopen, FFIType } from "bun:ffi";

export function applyWindowsDpiAwareness(): void {
  if (process.platform !== "win32") return;
  try {
    const { symbols } = dlopen("user32.dll", {
      SetProcessDPIAware: { args: [], returns: FFIType.bool },
    });
    // Returns false when awareness was already set (by a manifest or an earlier
    // call); that is a no-op, not an error.
    const applied = symbols.SetProcessDPIAware();
    console.log(
      applied
        ? "Windows: DPI awareness enabled (system)."
        : "Windows: DPI awareness was already set.",
    );
  } catch (error) {
    console.warn(
      "Windows: could not enable DPI awareness:",
      error instanceof Error ? error.message : error,
    );
  }
}
