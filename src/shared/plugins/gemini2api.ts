/** The state and actions the gemini2api plugin page and its controller share. */
export interface GeminiModel {
  id: string;
  displayName: string;
}

export interface GeminiHealth {
  version: string | null;
  accounts: Array<{ id: string; status: string; signedIn: boolean }>;
  keyRequired: boolean;
}

export interface GeminiPageState {
  platform: string;
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  running: boolean;
  port: number | null;
  pid: number | null;
  health: GeminiHealth | null;
  models: GeminiModel[];
  cookieProfile: string | null;
  cookieCount: number;
  homepage: string;
  logs: string[];
  busy: string | null;
  error: string | null;
}

export type GeminiAction =
  | "install"
  | "uninstall"
  | "start"
  | "stop"
  | "import-cookies"
  | "refresh";

export const GEMINI_HOMEPAGE = "https://github.com/abcdlsj/gemini2api";
