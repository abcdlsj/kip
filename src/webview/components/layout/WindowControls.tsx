import { Minus, Square, X } from "lucide-react";
import type { WindowAction } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";

/**
 * Minimize / maximize / close for frameless windows.
 *
 * macOS draws its traffic lights natively, so this only renders on Windows and
 * Linux. Sizes follow the Windows 11 caption buttons (46 px wide, full title bar
 * height) so they read as system chrome rather than app buttons.
 */
export function WindowControls() {
  const maximized = useUiStore((state) => state.windowMaximized);

  const control = (action: WindowAction) => () => {
    void request("windowControl", { action });
  };

  return (
    <div className="-mr-3 flex h-11 shrink-0 items-stretch">
      <button
        onClick={control("minimize")}
        className="no-drag flex w-[46px] items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus size={11} strokeWidth={1.3} />
      </button>
      <button
        onClick={control("maximize")}
        className="no-drag flex w-[46px] items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-subtle)]"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth={1.3}>
            <rect x="0.65" y="2.65" width="7.7" height="7.7" rx="0.6" />
            <path d="M2.65 2.65V0.65h7.7v7.7h-2" />
          </svg>
        ) : (
          <Square size={10} strokeWidth={1.3} />
        )}
      </button>
      <button
        onClick={control("close")}
        className="no-drag flex w-[46px] items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[#c42b1c] hover:text-white"
        aria-label="Close"
        title="Close"
      >
        <X size={12} strokeWidth={1.3} />
      </button>
    </div>
  );
}
