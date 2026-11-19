/**
 * A small indicator that hangs from the MacBook notch (or the top centre of
 * the menu bar on displays without one) while Kip is in the background:
 * a spinner while an agent works, a yellow dot when a thread waits for
 * approval, and a blue dot when a run finished.
 */
import { BrowserWindow, Screen } from "electrobun/bun";
import { release } from "node:os";
import {
  getMacScreens,
  getWindowReferenceScreenHeight,
  isNSWindow,
  setPropertiesOnMainThread,
} from "./objc";

export type NotchState = "idle" | "working" | "attention" | "done";

/** Above the menu bar (NSMainMenuWindowLevel = 24). */
const STATUS_WINDOW_LEVEL = 25;
/** canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary */
const COLLECTION_BEHAVIOR = 1 | 16 | 64 | 256;
/** Hardware notch width in points, rounded up so the wings stay visible. */
const NOTCH_WIDTH = 190;
const WING = 30;
const HIDE_DELAY_MS = 240;

/** Kip aperture mark from logoPaths.ts (viewBox 220 220 584 584). */
const KIP_ICON_SVG =
  `<svg class="logo" width="13" height="13" viewBox="220 220 584 584" aria-hidden="true">` +
  `<path d="M581.36 253.13Q659.70 426.72 770.87 581.36Q597.28 659.70 442.64 770.87Q364.30 597.28 253.13 442.64Q426.72 364.30 581.36 253.13ZM538.49 413.12Q479.43 455.58 413.12 485.51Q455.58 544.57 485.51 610.88Q544.57 568.42 610.88 538.49Q568.42 479.43 538.49 413.12Z" fill="rgba(250, 249, 246, 0.88)" fill-rule="evenodd"/>` +
  `</svg>`;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    -webkit-user-select: none; user-select: none; cursor: default; }
  .shell { position: absolute; inset: 0; background: #000;
    border-radius: 0 0 11px 11px; transform: translateY(-100%);
    transition: transform 240ms cubic-bezier(0.32, 0.72, 0, 1); }
  .shell.on { transform: translateY(0); }
  .wing { position: absolute; top: 0; bottom: 0; width: ${WING}px;
    display: flex; align-items: center; justify-content: center; }
  .wing.left { left: 0; }
  .wing.right { right: 0; }
  .logo { display: block; opacity: 0.92; }
  .dot { width: 7px; height: 7px; border-radius: 50%; opacity: 0;
    transition: opacity 160ms ease, background-color 160ms ease; }
  .dot.attention { opacity: 1; background: #ffc53d;
    box-shadow: 0 0 6px rgba(255, 197, 61, 0.75); animation: breathe 1.8s ease-in-out infinite; }
  .dot.done { opacity: 1; background: #4c9bff; box-shadow: 0 0 6px rgba(76, 155, 255, 0.6); }
  .spin { position: absolute; width: 9px; height: 9px; border-radius: 50%;
    border: 1.5px solid rgba(255, 255, 255, 0.18); border-top-color: rgba(255, 255, 255, 0.82);
    opacity: 0; animation: spin 0.9s linear infinite; transition: opacity 160ms ease; }
  .spin.on { opacity: 1; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe { 50% { opacity: 0.55; } }
</style></head><body>
<div class="shell" id="shell">
  <div class="wing left">${KIP_ICON_SVG}</div>
  <div class="wing right"><div class="spin" id="spin"></div><div class="dot" id="dot"></div></div>
</div>
<script>
  window.kipSetState = function (state) {
    document.getElementById("shell").classList.toggle("on", state !== "idle");
    document.getElementById("spin").classList.toggle("on", state === "working");
    var dot = document.getElementById("dot");
    dot.className = "dot" + (state === "attention" || state === "done" ? " " + state : "");
  };
  document.addEventListener("mousedown", function () {
    if (window.__electrobunSendToHost) window.__electrobunSendToHost({ type: "open" });
  });
</script>
</body></html>`;

/** macOS 14+ only: the native WebKit renderer is required for a transparent window. */
function supported(): boolean {
  if (process.platform !== "darwin") return false;
  const major = Number(release().split(".")[0]);
  return Number.isFinite(major) && major >= 23;
}

interface NotchPlacement {
  x: number;
  /** Target bottom-left Y in AppKit screen coordinates (when fromAppKit is true), or top-left Y otherwise. */
  y: number;
  width: number;
  height: number;
  fromAppKit: boolean;
}

function computeNotchPlacement(): NotchPlacement {
  const screens = getMacScreens();
  if (screens.length > 0) {
    // Prefer the built-in display with a hardware notch (safeAreaInsets.top > 0
    // works even when the menu bar is auto-hidden or on secondary displays).
    const notched = screens.find(
      (screen) =>
        screen.safeAreaTop > 0 &&
        screen.auxLeft !== null &&
        screen.auxRight !== null &&
        screen.auxLeft.width > 0 &&
        screen.auxRight.width > 0,
    );
    if (notched && notched.auxLeft && notched.auxRight) {
      const notchLeft = notched.auxLeft.x + notched.auxLeft.width;
      const notchRight = notched.auxRight.x;
      const notchWidth = Math.max(NOTCH_WIDTH, notchRight - notchLeft);
      const width = Math.round(notchWidth + WING * 2);
      const height = Math.round(
        Math.max(
          notched.safeAreaTop,
          notched.frame.y + notched.frame.height - notched.auxLeft.y,
        ),
      );
      const notchCenterX = (notchLeft + notchRight) / 2;
      const x = Math.round(notchCenterX - width / 2);
      const y = Math.round(notched.frame.y + notched.frame.height - height);
      return { x, y, width, height, fromAppKit: true };
    }
    const primary = screens[0]!;
    const menuBar = Math.max(
      24,
      Math.round(
        primary.frame.y +
          primary.frame.height -
          (primary.visibleFrame.y + primary.visibleFrame.height),
      ),
    );
    const width = WING * 2;
    const x = Math.round(primary.frame.x + (primary.frame.width - width) / 2);
    const y = Math.round(primary.frame.y + primary.frame.height - menuBar);
    return { x, y, width, height: menuBar, fromAppKit: true };
  }

  // Fallback to Electrobun's Screen API if AppKit introspection is unavailable.
  const displays = Screen.getAllDisplays();
  const withInset = displays
    .map((display) => ({ display, inset: display.workArea.y - display.bounds.y }))
    .sort((a, b) => b.inset - a.inset);
  const notched = withInset.find((item) => item.inset >= 30);
  const chosen = notched
    ? { ...notched, notched: true }
    : (() => {
        const primary = Screen.getPrimaryDisplay();
        return {
          display: primary,
          inset: Math.max(22, primary.workArea.y - primary.bounds.y),
          notched: false,
        };
      })();
  const width = (chosen.notched ? NOTCH_WIDTH : 0) + WING * 2;
  const height = Math.round(chosen.inset);
  const x = Math.round(chosen.display.bounds.x + (chosen.display.bounds.width - width) / 2);
  return { x, y: chosen.display.bounds.y, width, height, fromAppKit: false };
}

export class NotchIndicator {
  private window: BrowserWindow | null = null;
  private ready = false;
  private visible = false;
  private state: NotchState = "idle";
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onOpen: () => void) {
    if (!supported() || process.env.KIP_NOTCH === "0") return;
    try {
      this.create();
    } catch (error) {
      console.warn("Notch indicator unavailable:", error instanceof Error ? error.message : error);
      this.window = null;
    }
  }

  private create(): void {
    const placement = computeNotchPlacement();
    const window = new BrowserWindow({
      title: "Kip Indicator",
      html: HTML,
      titleBarStyle: "hidden",
      transparent: true,
      hidden: true,
      activate: false,
      renderer: "native",
      frame: { x: placement.x, y: 0, width: placement.width, height: placement.height },
      styleMask: {
        Borderless: true,
        Resizable: false,
        Closable: false,
        Miniaturizable: false,
      },
    });
    this.window = window;

    if (isNSWindow(window.ptr)) {
      setPropertiesOnMainThread(window.ptr, {
        level: STATUS_WINDOW_LEVEL,
        collectionBehavior: COLLECTION_BEHAVIOR,
        hasShadow: 0,
      });
    }
    this.position();

    window.webview.on("dom-ready", () => {
      this.ready = true;
      this.render();
    });
    // Electrobun emits host-message for any webview; its type list omits it.
    (window.webview.on as (name: string, handler: () => void) => void)("host-message", () =>
      this.onOpen(),
    );
  }

  /**
   * Aligns the indicator with the current notch geometry. Electrobun's
   * setWindowFrame converts Y via `refScreenHeight - y - height`, so passing
   * `refScreenHeight - appKitY - height` lands on the exact AppKit Y even on
   * multi-display setups where the notched screen is not primary.
   */
  private position(): void {
    const window = this.window;
    if (!window) return;
    const placement = computeNotchPlacement();
    let electrobunY = placement.y;
    if (placement.fromAppKit) {
      const refHeight = getWindowReferenceScreenHeight(window.ptr);
      if (refHeight !== null) {
        electrobunY = refHeight - placement.y - placement.height;
      } else {
        electrobunY = 0;
      }
    }
    window.setFrame(placement.x, electrobunY, placement.width, placement.height);
  }

  set(state: NotchState): void {
    if (state === this.state) return;
    this.state = state;
    this.render();
  }

  private render(): void {
    const window = this.window;
    if (!window) return;
    if (this.state === "idle") {
      if (this.ready) window.webview.executeJavascript(`window.kipSetState("idle")`);
      if (this.visible && !this.hideTimer) {
        this.hideTimer = setTimeout(() => {
          this.hideTimer = null;
          if (this.state !== "idle") return;
          window.hide();
          this.visible = false;
        }, HIDE_DELAY_MS);
      }
      return;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (!this.visible) {
      this.position();
      window.showInactive();
      this.visible = true;
    }
    if (this.ready) window.webview.executeJavascript(`window.kipSetState(${JSON.stringify(this.state)})`);
  }
}
