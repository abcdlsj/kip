/**
 * Wires the typed RPC contract to storage, safety, agent, and sync services.
 * All long-running work is pushed to the webview through coalesced events.
 */
import { BrowserView, Utils, type BrowserWindow } from "electrobun/bun";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { KipRPCSchema } from "../shared/rpc-schema";
import type {
  AgentStreamEnvelope,
  CreateThreadInput,
  ModelOption,
  ProviderRecord,
  SendPromptInput,
  SettingsSnapshot,
  ThinkingLevel,
  ThreadSummary,
} from "../shared/types";
import { getSessionDir, newId, type KipDatabase } from "./storage/db";
import { deleteApiKey, getApiKey, hasApiKey, setApiKey } from "./storage/keychain";
import type { ModelRegistry } from "./agent/model-registry";
import { displayModelName, fetchRemoteModels } from "./agent/model-registry";
import type { KipOrchestrator } from "./agent/pi-orchestrator";
import { pickWorkspaceFolder, suggestFiles, workspaceName } from "./system/fs-dialog";
import { inspectGit } from "./system/git-inspector";
import {
  exportBackupBundle,
  exportThreadMarkdown,
  importBackupBundle,
} from "./sync/exporter";
import { getSyncConfig, triggerS3Sync, updateSyncConfig } from "./sync/s3-sync";

export interface RpcDeps {
  database: KipDatabase;
  registry: ModelRegistry;
  orchestrator: KipOrchestrator;
  windowRef: { current: BrowserWindow | null };
}

export function createKipRpc(deps: RpcDeps) {
  let sendStream: (payload: AgentStreamEnvelope) => void = () => {};
  let sendSync: (payload: { state: "idle" | "running" | "error"; message?: string }) => void =
    () => {};

  const rpc = BrowserView.defineRPC<KipRPCSchema>({
    maxRequestTime: 60_000,
    handlers: {
      requests: {
        listWorkspaces: async () => {
          const workspaces = deps.database.listWorkspaces();
          return Promise.all(
            workspaces.map(async (workspace) => {
              const git = await inspectGit(workspace.rootPath);
              return { ...workspace, gitBranch: git.branch, dirtyFiles: git.dirtyFiles };
            }),
          );
        },
        pickAndCreateWorkspace: async () => {
          const folder = await pickWorkspaceFolder();
          if (!folder) return null;
          const existing = deps.database.findWorkspaceByPath(folder);
          if (existing) {
            deps.database.touchWorkspace(existing.id);
            const git = await inspectGit(folder);
            return { ...existing, gitBranch: git.branch, dirtyFiles: git.dirtyFiles };
          }
          const created = deps.database.createWorkspace(workspaceName(folder), folder);
          const git = await inspectGit(folder);
          return { ...created, gitBranch: git.branch, dirtyFiles: git.dirtyFiles };
        },
        removeWorkspace: ({ workspaceId }) => {
          for (const thread of deps.database.listThreads(workspaceId)) {
            void deps.orchestrator.abort(thread.id);
          }
          deps.database.removeWorkspace(workspaceId);
          const dir = getSessionDir(workspaceId);
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        },
        listWorkspaceFiles: async ({ workspaceId, query }) => {
          const workspace = deps.database.getWorkspace(workspaceId);
          if (!workspace) return [];
          return suggestFiles(workspace.rootPath, query);
        },
        listThreads: ({ workspaceId }) =>
          deps.database
            .listThreads(workspaceId)
            .map((thread) => ({ ...thread, isRunning: deps.orchestrator.isRunning(thread.id) })),
        createThread: async (input: CreateThreadInput) => {
          const thread = await createThread(deps, input);
          return { ...thread, isRunning: false };
        },
        loadThreadTurns: ({ threadId }) => deps.orchestrator.loadTurns(threadId),
        deleteThread: ({ threadId }) => {
          const thread = deps.database.getThread(threadId);
          void deps.orchestrator.abort(threadId);
          deps.database.deleteThread(threadId);
          if (thread?.sessionFilePath && existsSync(thread.sessionFilePath)) {
            rmSync(thread.sessionFilePath, { force: true });
          }
        },
        renameThread: ({ threadId, title }) => {
          deps.database.updateThread(threadId, { title: title.trim() || "New Thread" });
        },
        setThreadModel: async ({ threadId, provider, modelId }) => {
          await deps.orchestrator.updateThreadModel(threadId, provider, modelId);
        },
        setThinkingLevel: ({ threadId, level }) => {
          deps.orchestrator.setThinkingLevel(threadId, level);
        },
        compactThread: async ({ threadId }) => deps.orchestrator.compact(threadId),
        sendPrompt: async (input: SendPromptInput) => {
          void deps.orchestrator.sendPrompt(input).catch((error: unknown) => {
            sendStream({
              threadId: input.threadId,
              event: {
                kind: "turn_error",
                message: error instanceof Error ? error.message : "Unable to start the run",
              },
            });
          });
          return { accepted: true };
        },
        abortThread: async ({ threadId }) => {
          await deps.orchestrator.abort(threadId);
        },
        resolveToolApproval: ({ threadId, toolCallId, approved, rememberForSession }) => {
          deps.orchestrator.resolveApproval(threadId, toolCallId, approved, rememberForSession);
        },
        getSettings: () => settingsSnapshot(deps),
        updateSettings: async (patch) => {
          for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) deps.database.setSetting(key, value);
          }
          return settingsSnapshot(deps);
        },
        setProviderApiKey: async ({ provider, apiKey }) => {
          await setApiKey(provider, apiKey.trim());
          const record = deps.database.getProvider(provider);
          if (record) await deps.registry.addOrUpdateProvider(record, apiKey.trim());
          return { valid: apiKey.trim().length > 0 };
        },
        removeProviderApiKey: async ({ provider }) => {
          await deleteApiKey(provider);
          deps.registry.removeProvider(provider);
        },
        listProviders: async () => withKeyFlags(deps, deps.database.listProviders()),
        saveProvider: async (input) => {
          const record = deps.database.saveProvider(input);
          if (input.apiKey?.trim()) await setApiKey(record.id, input.apiKey.trim());
          const withKey = { ...record, hasApiKey: await hasApiKey(record.id) };
          await deps.registry.addOrUpdateProvider(withKey);
          await ensureDefaultProvider(deps, record);
          return withKey;
        },
        deleteProvider: async ({ provider }) => {
          await deleteApiKey(provider);
          deps.database.deleteProvider(provider);
          deps.registry.removeProvider(provider);
        },
        testProvider: ({ provider }) => deps.registry.testProvider(provider),
        fetchProviderModels: ({ baseUrl, apiKey }) =>
          fetchRemoteModels(baseUrl, apiKey ?? undefined),
        getAvailableModels: () => deps.registry.listAvailable(),
        getSyncConfig: () => getSyncConfig(deps.database),
        updateSyncConfig: (input) => updateSyncConfig(deps.database, input),
        triggerSync: async () => {
          sendSync({ state: "running" });
          try {
            const result = await triggerS3Sync(deps.database);
            sendSync({ state: "idle" });
            return result;
          } catch (error) {
            sendSync({
              state: "error",
              message: error instanceof Error ? error.message : "Sync failed",
            });
            throw error;
          }
        },
        exportThreadMarkdown: async ({ threadId }) => ({
          savedPath: await exportThreadMarkdown(deps.database, threadId),
        }),
        exportFullBackupBundle: async () => ({
          savedPath: await exportBackupBundle(deps.database),
        }),
        importBackupBundle: () => importBackupBundle(deps.database),
        windowControl: ({ action }) => {
          const window = deps.windowRef.current;
          if (!window) return;
          if (action === "minimize") window.minimize();
          else if (action === "maximize") {
            if (window.isMaximized()) window.unmaximize();
            else window.maximize();
          } else window.close();
        },
      },
      messages: {},
    },
  });

  sendStream = (payload) => rpc.send.agentStreamEvent(payload);
  sendSync = (payload) => rpc.send.syncStatus(payload);
  void Utils;
  return rpc;
}

async function createThread(deps: RpcDeps, input: CreateThreadInput): Promise<ThreadSummary> {
  const workspace = deps.database.getWorkspace(input.workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  const defaults = await deps.registry.ensureDefault();
  const provider = input.modelProvider ?? deps.database.getSetting("defaultProvider", "") ?? "";
  const modelId = input.modelId ?? deps.database.getSetting("defaultModelId", "") ?? "";
  const thinkingLevel =
    input.thinkingLevel ??
    (deps.database.getSetting("defaultThinkingLevel", "medium") as ThinkingLevel);
  const chosenProvider = provider || defaults?.provider || "";
  const chosenModel = modelId || defaults?.modelId || "";
  const id = newId("th");
  const sessionDir = getSessionDir(workspace.id);
  const manager = SessionManager.create(workspace.rootPath, sessionDir, { id });
  const sessionFilePath = manager.getSessionFile() ?? join(sessionDir, `${id}.jsonl`);
  deps.database.touchWorkspace(workspace.id);
  const thread = deps.database.createThread({
    id,
    workspaceId: workspace.id,
    title: "New Thread",
    sessionFilePath,
    modelProvider: chosenProvider,
    modelId: chosenModel,
    thinkingLevel,
  });
  return thread;
}

async function settingsSnapshot(deps: RpcDeps): Promise<SettingsSnapshot> {
  const providers = await withKeyFlags(deps, deps.database.listProviders());
  return {
    theme: deps.database.getSetting("theme", "system"),
    approvalPolicy: deps.database.getSetting("approvalPolicy", "read-only-auto"),
    defaultProvider: deps.database.getSetting("defaultProvider", ""),
    defaultModelId: deps.database.getSetting("defaultModelId", ""),
    defaultThinkingLevel: deps.database.getSetting("defaultThinkingLevel", "medium"),
    sidebarCollapsed: deps.database.getSetting("sidebarCollapsed", false),
    configuredProviders: providers.filter((provider) => provider.hasApiKey).map((p) => p.id),
    availableModels: deps.registry.listAvailable(),
  };
}

async function withKeyFlags(
  deps: RpcDeps,
  providers: ProviderRecord[],
): Promise<ProviderRecord[]> {
  void deps;
  return Promise.all(
    providers.map(async (provider) => ({
      ...provider,
      hasApiKey: (await getApiKey(provider.id)) !== null,
      models: provider.models.map((model) => ({
        ...model,
        displayName: model.displayName || displayModelName(model.id),
      })),
    })),
  );
}

async function ensureDefaultProvider(deps: RpcDeps, record: ProviderRecord): Promise<void> {
  const current = deps.database.getSetting("defaultProvider", "") as string;
  if (current && deps.database.getProvider(current)) return;
  const first = record.models[0];
  if (!first) return;
  deps.database.setSetting("defaultProvider", record.id);
  deps.database.setSetting("defaultModelId", first.id);
}

export function resolveDefaultModel(deps: RpcDeps): ModelOption | null {
  return deps.registry.listAvailable()[0] ?? null;
}

export { basename };
