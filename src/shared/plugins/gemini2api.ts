/** The state and actions the gemini2api plugin page and its controller share. */
const TEMPORARY_SUFFIX = /\s*\((?:temporary|temp)\)\s*$/i;
const TEMPORARY_ID = /[-_](?:temp|temporary)$/i;

/**
 * The name a picker should show for a Gemini SKU: "gemini-4-neon" reads
 * "Gemini 4 Neon", and a temporary variant says so in words.
 */
export function geminiModelName(raw: string, temporary?: boolean): string {
  let name = (raw ?? "").trim();
  let isTemporary = temporary === true;
  if (TEMPORARY_SUFFIX.test(name)) {
    isTemporary = true;
    name = name.replace(TEMPORARY_SUFFIX, "");
  }
  if (TEMPORARY_ID.test(name)) {
    isTemporary = true;
    name = name.replace(TEMPORARY_ID, "");
  }
  const words = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) =>
      /^\d/.test(word) ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`,
    );
  const pretty = words.join(" ") || name;
  return isTemporary ? `${pretty} (Temporary)` : pretty;
}

export interface GeminiModel {
  id: string;
  displayName: string;
}

/**
 * How long a locally managed gateway may stay silent before Kip treats it as
 * hung. Generous by default: Gemini Web can think for a while before the first
 * byte, and a restart costs the user the whole answer.
 */
export const DEFAULT_STALL_TIMEOUT_SECONDS = 120;
export const MIN_STALL_TIMEOUT_SECONDS = 10;
export const MAX_STALL_TIMEOUT_SECONDS = 1800;

/** Reads a stall timeout in seconds from a plugin's saved values. */
export function stallTimeoutMs(
  values: Record<string, string>,
  field: string,
  fallbackSeconds = DEFAULT_STALL_TIMEOUT_SECONDS,
): number {
  const raw = (values[field] ?? "").trim();
  const seconds = Number(raw);
  if (raw === "" || !Number.isFinite(seconds))
    return fallbackSeconds * 1_000;
  const clamped = Math.min(
    MAX_STALL_TIMEOUT_SECONDS,
    Math.max(MIN_STALL_TIMEOUT_SECONDS, seconds),
  );
  return Math.round(clamped * 1_000);
}

export interface GeminiHealth {
  version: string | null;
  accounts: Array<{ id: string; status: string; signedIn: boolean }>;
  keyRequired: boolean;
  chats?: number | null;
}

export type GeminiWatchdogHealthState =
  | "stopped"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "restarting"
  | "degraded";

export interface GeminiWatchdogState {
  state: GeminiWatchdogHealthState;
  restartCount: number;
  maxRestarts: number;
  windowMs: number;
  lastRestartAt: number | null;
  lastFailure: string | null;
  nextRetryAt: number | null;
  consecutiveFailures: number;
}

/** What went wrong, plus the next step the user can take. */
export interface GeminiPageError {
  message: string;
  hint: string | null;
}

export interface GeminiPageState {
  platform: string;
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  running: boolean;
  /** Running, but started by the user rather than by Kip. */
  external: boolean;
  port: number | null;
  pid: number | null;
  health: GeminiHealth | null;
  models: GeminiModel[];
  cookieProfile: string | null;
  cookieCount: number;
  homepage: string;
  logs: string[];
  busy: string | null;
  error: GeminiPageError | null;
  watchdog?: GeminiWatchdogState;
}

export type GeminiAction =
  | "install"
  | "uninstall"
  | "start"
  | "stop"
  | "restart"
  | "import-cookies"
  | "refresh";

export const GEMINI_HOMEPAGE = "https://github.com/abcdlsj/gemini2api";
