/**
 * Strongly typed Electrobun RPC contract.
 * Request/response pairs are used for state changes; streamed agent output is a
 * one-way message so it can be coalesced on the Bun side.
 */
import type {
  AgentStreamEnvelope,
  ApprovalPolicy,
  ChatTurn,
  ContextUsage,
  CreateThreadInput,
  FileSuggestion,
  ModelOption,
  PluginProbeResult,
  PluginSummary,
  ProviderModel,
  ProviderProtocol,
  ProviderRecord,
  RunChanges,
  SendPromptInput,
  SettingsSnapshot,
  SyncConfig,
  SyncProvider,
  ThemeMode,
  ThinkingLevel,
  ThreadMode,
  ThreadSummary,
  UpdateStatus,
  WindowAction,
  Workspace,
} from "./types";

export interface SaveProviderInput {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  models: ProviderModel[];
}

export interface UpdateSettingsInput {
  theme?: ThemeMode;
  approvalPolicy?: ApprovalPolicy;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: ThinkingLevel;
  defaultThreadMode?: ThreadMode;
  sidebarCollapsed?: boolean;
}

export interface KipRPCSchema {
  bun: {
    requests: {
      listWorkspaces: { params: void; response: Workspace[] };
      pickAndCreateWorkspace: { params: void; response: Workspace | null };
      removeWorkspace: { params: { workspaceId: string }; response: void };
      listWorkspaceFiles: {
        params: { workspaceId: string; query: string };
        response: FileSuggestion[];
      };

      listThreads: { params: { workspaceId: string }; response: ThreadSummary[] };
      createThread: { params: CreateThreadInput; response: ThreadSummary };
      loadThreadTurns: {
        params: { threadId: string };
        response: { turns: ChatTurn[]; usage: ContextUsage };
      };
      deleteThread: { params: { threadId: string }; response: void };
      renameThread: { params: { threadId: string; title: string }; response: void };
      regenerateThreadTitle: { params: { threadId: string }; response: { title: string | null } };
      setThreadModel: {
        params: { threadId: string; provider: string; modelId: string };
        response: void;
      };
      setThinkingLevel: { params: { threadId: string; level: ThinkingLevel }; response: void };
      setThreadMode: { params: { threadId: string; mode: ThreadMode }; response: void };
      setThreadApprovalPolicy: {
        params: { threadId: string; policy: ApprovalPolicy | null };
        response: void;
      };
      compactThread: { params: { threadId: string }; response: ContextUsage };

      sendPrompt: { params: SendPromptInput; response: { accepted: boolean } };
      /** Returns the text of queued messages that were dropped, so the view can restore them. */
      abortThread: { params: { threadId: string }; response: { restored: string[] } };
      resolveToolApproval: {
        params: {
          threadId: string;
          toolCallId: string;
          approved: boolean;
          rememberForSession?: boolean;
          /** Optional reason shown to the model when the call is denied. */
          reason?: string;
        };
        response: void;
      };
      /** Rewinds the thread to before the given user message and sends new text. */
      editPrompt: {
        params: { threadId: string; userIndex: number; text: string };
        response: { accepted: boolean };
      };
      getRunChanges: { params: { threadId: string }; response: RunChanges | null };
      undoRunChanges: {
        params: { threadId: string; runId: string };
        response: { ok: boolean; error?: string; next: RunChanges | null };
      };

      getSettings: { params: void; response: SettingsSnapshot };
      updateSettings: { params: UpdateSettingsInput; response: SettingsSnapshot };
      setProviderApiKey: {
        params: { provider: string; apiKey: string };
        response: { valid: boolean };
      };
      removeProviderApiKey: { params: { provider: string }; response: void };
      listProviders: { params: void; response: ProviderRecord[] };
      saveProvider: { params: SaveProviderInput; response: ProviderRecord };
      deleteProvider: { params: { provider: string }; response: void };
      testProvider: {
        params: { provider: string };
        response: { connected: boolean; latencyMs?: number; error?: string };
      };
      fetchProviderModels: {
        params: { baseUrl: string; apiKey?: string };
        response: { models: ProviderModel[]; error?: string };
      };
      listPlugins: { params: void; response: PluginSummary[] };
      updatePlugin: {
        params: { plugin: string; enabled?: boolean; values?: Record<string, string> };
        response: PluginSummary;
      };
      probePlugin: {
        params: { plugin: string; values: Record<string, string> };
        response: PluginProbeResult;
      };
      getAvailableModels: { params: void; response: ModelOption[] };

      getSyncConfig: { params: void; response: SyncConfig };
      updateSyncConfig: {
        params: {
          provider?: SyncProvider;
          enabled: boolean;
          endpoint?: string;
          region?: string;
          bucket?: string;
          prefix?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
          googleClientId?: string;
          googleClientSecret?: string;
          googleFolderName?: string;
        };
        response: { connected: boolean; error?: string };
      };
      connectGoogleDrive: {
        params: {
          clientId: string;
          clientSecret?: string;
          folderName?: string;
        };
        response: { connected: boolean; email?: string | null; error?: string };
      };
      disconnectGoogleDrive: { params: void; response: void };
      triggerSync: {
        params: void;
        response: { pushed: number; pulled: number; syncedAt: number };
      };

      exportThreadMarkdown: {
        params: { threadId: string };
        response: { savedPath: string | null };
      };
      exportFullBackupBundle: { params: void; response: { savedPath: string | null } };
      importBackupBundle: { params: void; response: { importedThreads: number } };

      windowControl: { params: { action: WindowAction }; response: void };

      /** Last known result of the background GitHub Releases check. */
      getUpdateStatus: { params: void; response: UpdateStatus };
      /** Opens the release page in the default browser. */
      openUpdatePage: { params: void; response: { opened: boolean } };
      /** Agents still working, so the restart prompt can warn before stopping them. */
      getRunningThreadCount: { params: void; response: number };
      /** Replaces the staged bundle and quits; the new copy relaunches itself. */
      restartForUpdate: { params: void; response: { started: boolean } };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      agentStreamEvent: AgentStreamEnvelope;
      syncStatus: { state: "idle" | "running" | "error"; message?: string };
      /** Sent when the user clicks the notch indicator. */
      focusThread: { threadId: string };
      /** Window chrome state for the in-app buttons on Windows and Linux. */
      windowState: { maximized: boolean };
      /** Pushed whenever the update check changes state. */
      updateStatus: UpdateStatus;
    };
  };
}
