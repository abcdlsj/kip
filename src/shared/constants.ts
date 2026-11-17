/** Runtime constants shared by both processes. */

export const APP_NAME = "Kip";
export const DATA_DIR_NAME = ".kip";

export const SIDEBAR_WIDTH = 232;
export const COMPOSER_MAX_WIDTH = 740;
export const STREAM_FRAME_MS = 16;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Kip, a precise and quiet coding agent embedded in the user's desktop.",
  "Work directly in the selected workspace. Read before editing, keep changes minimal,",
  "and explain only what matters. Never claim a file changed unless the tool succeeded.",
].join(" ");

export const MODEL_DISPLAY_FALLBACK = "Unnamed model";

export const SUGGESTIONS = [
  "Explain this codebase",
  "Find the riskiest code path",
  "Draft a small improvement",
];
