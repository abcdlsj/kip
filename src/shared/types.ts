/**
 * Shared data contract between the Bun main process and the webview.
 * This module must stay free of runtime dependencies.
 */

export type ThemeMode = "light" | "dark" | "system";
export type CliTuiLayout = "inline" | "fullscreen";
export type ApprovalPolicy = "read-only-auto" | "full-auto" | "strict" | "yolo";
export type ThinkingLevel = "off" | "low" | "medium" | "high";
/**
 * `agent` threads get tools, a system prompt, and workspace context. `chat`
 * threads send only the conversation, for providers whose value is the model
 * itself rather than its tool loop.
 */
export type ThreadMode = "agent" | "chat";
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
  mode: ThreadMode;
  /** Per-thread permission override; null/undefined inherits the global policy. */
  approvalPolicy?: ApprovalPolicy | null;
  updatedAt: number;
  isRunning: boolean;
  /** True when the thread has no recorded messages yet; hidden from sidebar lists. */
  isEmpty?: boolean;
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

/** What a plugin may touch while doing its work. Shown before the user enables it. */
export type PluginPermission = "network" | "process" | "files" | "credentials";

/** One catalog entry the Plugins page renders; no network, shipped with the repo. */
export interface MarketplaceEntry {
  id: string;
  kind: PluginKind;
  name: string;
  summary: string;
  version: string;
  author: string;
  homepage?: string;
  /** The provider record a gateway plugin owns. */
  providerId?: string;
  permissions: PluginPermission[];
  /** The plugin opens a window with a page of its own. */
  window: boolean;
  /** Bundled in this repository rather than fetched from somewhere. */
  builtin: boolean;
}

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
  /** The catalog entry for this plugin, including its author and permissions. */
  market: MarketplaceEntry;
  /**
   * Whether the user accepted this plugin's permissions. Plugins that declare
   * permissions are not started, probed, or opened until they are accepted.
   */
  accepted: boolean;
  /** The plugin can open its own window; the Plugins page offers a button. */
  hasWindow: boolean;
}

/** The catalog the Plugins page renders, plus the liability notice above it. */
export interface PluginMarketplace {
  notice: string;
  entries: MarketplaceEntry[];
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
  /**
   * Providers whose plugin offers Chat threads, with the mode their new threads
   * start in. The composer shows the switch only for these and uses the same
   * default, so what it shows is what a new thread gets.
   */
  chatModeProviders: Array<{ providerId: string; defaultMode: ThreadMode }>;
  sidebarCollapsed: boolean;
  cliTuiLayout: CliTuiLayout;
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
  | {
      kind: "thinking_done";
      turnId: string;
      blockId: string;
      durationMs: number;
    }
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
  /**
   * Pi treats a failed request as retryable and re-sends it. Without this event
   * the UI shows nothing between attempts, so a stalled provider looks like an
   * endlessly thinking agent.
   */
  | {
      kind: "retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      message: string;
    }
  /** The retry attempt finished; `success` is false when the run finally failed. */
  | { kind: "retry_end"; attempt: number; success: boolean }
  /** Lifecycle update from a locally managed gateway plugin during a run. */
  | {
      kind: "gateway_status";
      providerId: string;
      phase: "restarting" | "recovered" | "degraded" | "unhealthy";
      message: string;
      attempt?: number;
      maxAttempts?: number;
    }
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
  mode?: ThreadMode;
  approvalPolicy?: ApprovalPolicy | null;
}

export type WindowAction = "minimize" | "maximize" | "close";

/** Lifecycle phase of the Ed25519-verified seamless auto-updater. */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "ready_to_restart"
  | "flushing"
  | "installing"
  | "error";

/** Current status snapshot pushed from the Bun updater to the webview. */
export interface UpdateStatus {
  /** Running version without leading "v", e.g. "0.2.18". */
  current: string;
  /** Latest version advertised by the signed manifest, if checked. */
  latest?: string | null;
  available: boolean;
  state: UpdatePhase;
  /** Download/verification progress, 0-100. */
  progress: number;
  /** True when the current macOS bundle can be atomically swapped in place. */
  can_apply: boolean;
  release_url?: string | null;
  notes?: string | null;
  error?: string | null;
}

/** Frontend session state preserved across an atomic update restart. */
export interface UpdateHandoffAppState {
  activeWorkspaceId?: string | null;
  activeThreadId?: string | null;
  drafts?: Record<string, string>;
  scrollTop?: number;
  scrollPinned?: boolean;
}

/** Atomic one-shot handoff payload written before exit and consumed on boot. */
export interface UpdateHandoffPayload {
  schema_version: number;
  from_version: string;
  to_version: string;
  created_at_ms: number;
  ttl_ms: number;
  app_state: UpdateHandoffAppState;
}

/** Status of the `kip` command-line shim installed on PATH. */
export interface CliInstallStatus {
  installed: boolean;
  /** Path where Kip's CLI shim is currently installed, or null if absent. */
  installPath: string | null;
  /** Preferred destination used by Install. */
  targetPath: string;
  /** Whether the install (or target) directory is present on the user's shell PATH. */
  inPath: boolean;
  /** True when an existing Kip shim points to a different or missing runtime. */
  outdated: boolean;
  /** True when the CLI entrypoint and Bun runtime can be resolved from this app. */
  available: boolean;
  /** Short message when unavailable or when an existing non-Kip binary conflicts. */
  reason?: string;
  /** One-line shell snippet shown only when the install directory is not in PATH. */
  pathHint?: string;
}
