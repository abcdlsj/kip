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
  ProviderModel,
  ProviderProtocol,
  ProviderRecord,
  SendPromptInput,
  SettingsSnapshot,
  SyncConfig,
  ThemeMode,
  ThinkingLevel,
  ThreadSummary,
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
      setThreadModel: {
        params: { threadId: string; provider: string; modelId: string };
        response: void;
      };
      setThinkingLevel: { params: { threadId: string; level: ThinkingLevel }; response: void };
      compactThread: { params: { threadId: string }; response: ContextUsage };

      sendPrompt: { params: SendPromptInput; response: { accepted: boolean } };
      abortThread: { params: { threadId: string }; response: void };
      resolveToolApproval: {
        params: {
          threadId: string;
          toolCallId: string;
          approved: boolean;
          rememberForSession?: boolean;
        };
        response: void;
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
      getAvailableModels: { params: void; response: ModelOption[] };

      getSyncConfig: { params: void; response: SyncConfig };
      updateSyncConfig: {
        params: {
          enabled: boolean;
          endpoint: string;
          region: string;
          bucket: string;
          prefix: string;
          accessKeyId?: string;
          secretAccessKey?: string;
        };
        response: { connected: boolean; error?: string };
      };
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
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      agentStreamEvent: AgentStreamEnvelope;
      syncStatus: { state: "idle" | "running" | "error"; message?: string };
    };
  };
}
