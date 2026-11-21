/**
 * Shared data contract between the Bun main process and the webview.
 * This module must stay free of runtime dependencies.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ApprovalPolicy = "read-only-auto" | "full-auto" | "strict" | "yolo";
export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type ProviderProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  gitBranch: string | null;
  dirtyFiles: number;
  lastOpenedAt: number;
}

export interface ThreadSummary {
  id: string;
  workspaceId: string;
  title: string;
  sessionFilePath: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Per-thread permission override; null/undefined inherits the global policy. */
  approvalPolicy?: ApprovalPolicy | null;
  updatedAt: number;
  isRunning: boolean;
}

export interface TextBlock {
  type: "text";
  id: string;
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  id: string;
  thinking: string;
  durationMs?: number;
  isComplete: boolean;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "awaiting_approval" | "completed" | "error" | "denied";
  summaryLabel: string;
  output?: string;
  diff?: { before: string; after: string; filePath: string };
  durationMs?: number;
  risk?: "safe" | "standard" | "high-risk";
  outsideWorkspace?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  attachments?: Array<{ name: string; path: string; mimeType: string }>;
  createdAt: number;
  error?: string;
  /** Wall time of the whole assistant run, set once the run has finished. */
  durationMs?: number;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
}

/** File changes made during one agent run, captured as Git tree snapshots. */
export interface RunChanges {
  id: string;
  threadId: string;
  files: FileChange[];
  added: number;
  removed: number;
  createdAt: number;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  ratio: number;
}

export interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  supportsReasoning: boolean;
}

export interface ProviderRecord {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  models: ProviderModel[];
}

export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export type PluginKind = "gateway" | "title";
export type PluginFieldKind = "text" | "port" | "secret" | "toggle" | "select";

/** One input a plugin needs before it can reach its gateway. */
export interface PluginField {
  name: string;
  label: string;
  kind: PluginFieldKind;
  placeholder?: string;
  help?: string;
  optional?: boolean;
  /** For `select`: the values on offer, first one is the default. */
  options?: { value: string; label: string; help?: string }[];
}

/** A plugin as the view sees it: what to render, not how it works. */
export interface PluginSummary {
  id: string;
  kind: PluginKind;
  label: string;
  description: string;
  /** Whether the user can toggle this plugin on/off independently of probing. */
  toggleable: boolean;
  /** Active state for toggleable plugins (always true for gateway discovery plugins). */
  enabled: boolean;
  fields: PluginField[];
  /** Saved non-secret values, so the form survives a restart. */
  values: Record<string, string>;
}

export interface PluginProbeDetail {
  label: string;
  value: string;
}

export interface PluginProbeResult {
  ok: boolean;
  summary?: string;
  details?: PluginProbeDetail[];
  /** Fields the probe still needs, with the reason to show next to them. */
  missing?: Array<{ field: string; message: string }>;
  error?: string;
  /** The provider record written when the probe succeeded. */
  provider?: ProviderRecord;
}

export interface SettingsSnapshot {
  theme: ThemeMode;
  approvalPolicy: ApprovalPolicy;
  defaultProvider: string;
  defaultModelId: string;
  defaultThinkingLevel: ThinkingLevel;
  sidebarCollapsed: boolean;
  configuredProviders: string[];
  availableModels: ModelOption[];
}

export interface FileSuggestion {
  path: string;
  name: string;
}

export type SyncProvider = "s3" | "google-drive";

export interface SyncConfig {
  provider: SyncProvider;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  hasCredentials: boolean;
  googleClientId: string;
  googleFolderName: string;
  googleConnected: boolean;
  googleEmail: string | null;
  lastSyncedAt: number | null;
}

export type ToolApprovalPayload = {
  threadId: string;
  toolCallId: string;
  toolName: string;
  summaryLabel: string;
  commandOrPath: string;
  risk: "safe" | "standard" | "high-risk";
  outsideWorkspace: boolean;
  previewDiff?: { before: string; after: string; filePath: string };
};

export type AgentStreamEvent =
  | { kind: "turn_start"; turn: ChatTurn }
  | { kind: "text_delta"; turnId: string; blockId: string; delta: string }
  | { kind: "thinking_delta"; turnId: string; blockId: string; delta: string }
  | { kind: "thinking_done"; turnId: string; blockId: string; durationMs: number }
  | { kind: "tool_start"; turnId: string; block: ToolCallBlock }
  | {
      kind: "tool_approval_required";
      turnId: string;
      approval: ToolApprovalPayload;
    }
  | {
      kind: "tool_approved";
      turnId: string;
      toolCallId: string;
      approved?: boolean;
    }
  | {
      kind: "tool_end";
      turnId: string;
      toolCallId: string;
      status: "completed" | "error" | "denied";
      output?: string;
      diff?: { before: string; after: string; filePath: string };
      durationMs: number;
      summaryLabel: string;
    }
  | { kind: "usage_update"; usage: ContextUsage }
  | { kind: "thread_title_updated"; title: string }
  | { kind: "turn_complete" }
  /** A message sent during a run was delivered to the agent. */
  | { kind: "user_turn"; turn: ChatTurn }
  | { kind: "queue_update"; queued: QueuedPrompt[] }
  /** The latest run with undoable file changes, or null when there is none. */
  | { kind: "changes_update"; changes: RunChanges | null }
  | { kind: "turn_error"; message: string };

export interface AgentStreamEnvelope {
  threadId: string;
  event: AgentStreamEvent;
}

/**
 * How a message sent during a run reaches the agent: `followUp` waits until the
 * current work is done, `steer` is delivered after the current tool call.
 */
export type PromptDelivery = "followUp" | "steer";

export interface SendPromptInput {
  threadId: string;
  text: string;
  referencedFiles?: string[];
  images?: Array<{ mimeType: string; base64Data: string }>;
  /** Only used while the thread is running. Defaults to followUp. */
  delivery?: PromptDelivery;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  delivery: PromptDelivery;
}

export interface CreateThreadInput {
  workspaceId: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  approvalPolicy?: ApprovalPolicy | null;
}

export type WindowAction = "minimize" | "maximize" | "close";

/**
 * How this copy of Kip was installed, which decides how an update is applied.
 * `homebrew` points at `brew upgrade --cask kip`, `direct` can replace itself,
 * `manual` has no writable bundle and falls back to the release page.
 */
export type UpdateInstallSource = "homebrew" | "direct" | "manual";

/**
 * Result of the background GitHub Releases check. `available` drives the single
 * quiet arrow at the bottom of the sidebar.
 */
export interface UpdateStatus {
  /** Version of the running app, e.g. "0.2.2". */
  current: string;
  /** Newer release version without the leading "v", when one exists. */
  latest: string | null;
  available: boolean;
  /** `ready` means a staged bundle waits for the user to restart. */
  state: "idle" | "checking" | "available" | "downloading" | "ready";
  installSource: UpdateInstallSource;
  /** Download progress, 0-100. Only meaningful while `downloading`. */
  progress: number;
  /** Release page for `latest`, opened from the sidebar arrow. */
  releaseUrl: string | null;
  /** Unix ms of the last successful check, or null before the first one. */
  checkedAt: number | null;
}
