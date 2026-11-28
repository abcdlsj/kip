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
  ThreadMode,
  ThreadSummary,
} from "../shared/types";
import { getSessionDir, newId, type KipDatabase } from "./storage/db";
import {
  deleteApiKey,
  getApiKey,
  hasApiKey,
  setApiKey,
} from "./storage/keychain";
import type { ModelRegistry } from "./agent/model-registry";
import { displayModelName, fetchRemoteModels } from "./agent/model-registry";
import {
  acceptPlugin,
  afterGatewayRequest,
  chatModeSupport,
  findPlugin,
  getOrCreatePluginDeviceId,
  isPluginAccepted,
  notifyGatewaySettings,
  beforeGatewayRequest,
  pluginDataDir,
  pluginSummaries,
  resolveNewThreadMode,
  savePluginValues,
  setPluginEnabled,
  toPluginSummary,
} from "./plugins/registry";
import { MARKETPLACE, MARKETPLACE_NOTICE } from "../shared/marketplace";
import type { KipOrchestrator } from "./agent/pi-orchestrator";
import { hasSessionMessages } from "./agent/session-bridge";
import type { PluginWindows } from "./plugins/windows";
import {
  pickWorkspaceFolder,
  suggestFiles,
  workspaceName,
} from "./system/fs-dialog";
import { inspectGit } from "./system/git-inspector";
import {
  exportBackupBundle,
  exportThreadMarkdown,
  importBackupBundle,
} from "./sync/exporter";
import { connectGoogleDrive, disconnectGoogleDrive } from "./sync/gdrive-sync";
import { getSyncConfig, triggerSync, updateSyncConfig } from "./sync/s3-sync";
import type { UpdateManager } from "./updater";
import { getCliStatus, installCli, uninstallCli } from "./system/cli-installer";

export interface RpcDeps {
  database: KipDatabase;
  registry: ModelRegistry;
  orchestrator: KipOrchestrator;
  updater: UpdateManager;
  pluginWindows: PluginWindows;
  windowRef: { current: BrowserWindow | null };
}

export function createKipRpc(deps: RpcDeps) {
  let sendStream: (payload: AgentStreamEnvelope) => void = () => {};
  let sendSync: (payload: {
    state: "idle" | "running" | "error";
    message?: string;
  }) => void = () => {};

  const rpc = BrowserView.defineRPC<KipRPCSchema>({
    maxRequestTime: 180_000,
    handlers: {
      requests: {
        listWorkspaces: async () => {
          const workspaces = deps.database.listWorkspaces();
          return Promise.all(
            workspaces.map(async (workspace) => {
              const git = await inspectGit(workspace.rootPath);
              return {
                ...workspace,
                gitBranch: git.branch,
                dirtyFiles: git.dirtyFiles,
              };
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
            return {
              ...existing,
              gitBranch: git.branch,
              dirtyFiles: git.dirtyFiles,
            };
          }
          const created = deps.database.createWorkspace(
            workspaceName(folder),
            folder,
          );
          const git = await inspectGit(folder);
          return {
            ...created,
            gitBranch: git.branch,
            dirtyFiles: git.dirtyFiles,
          };
        },
        removeWorkspace: async ({ workspaceId }) => {
          const threads = deps.database.listThreads(workspaceId);
          refuseWhileDrivenElsewhere(
            deps,
            threads.map((thread) => thread.id),
          );
          await Promise.all(
            threads.map((thread) =>
              deps.orchestrator.disposeSession(thread.id),
            ),
          );
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
          deps.database.listThreads(workspaceId).map((thread) => {
            const isRunning = deps.orchestrator.isRunning(thread.id);
            return {
              ...thread,
              isRunning,
              isEmpty:
                !isRunning && !hasSessionMessages(thread.sessionFilePath),
            };
          }),
        createThread: async (input: CreateThreadInput) => {
          const thread = await createThread(deps, input);
          return { ...thread, isRunning: false, isEmpty: true };
        },
        loadThreadTurns: ({ threadId }) =>
          deps.orchestrator.loadTurns(threadId),
        deleteThread: async ({ threadId }) => {
          refuseWhileDrivenElsewhere(deps, [threadId]);
          const thread = deps.database.getThread(threadId);
          await deps.orchestrator.disposeSession(threadId);
          deps.database.deleteThread(threadId);
          if (thread?.sessionFilePath && existsSync(thread.sessionFilePath)) {
            rmSync(thread.sessionFilePath, { force: true });
          }
        },
        renameThread: ({ threadId, title }) => {
          deps.database.updateThread(threadId, {
            title: title.trim() || "New Thread",
          });
        },
        regenerateThreadTitle: async ({ threadId }) => ({
          title: await deps.orchestrator.regenerateThreadTitle(threadId),
        }),
        setThreadModel: async ({ threadId, provider, modelId }) => {
          await deps.orchestrator.updateThreadModel(
            threadId,
            provider,
            modelId,
          );
          rememberModelChoice(deps, provider, modelId);
        },
        setThinkingLevel: ({ threadId, level }) => {
          deps.orchestrator.setThinkingLevel(threadId, level);
        },
        setThreadMode: async ({ threadId, mode }) => {
          await deps.orchestrator.setThreadMode(threadId, mode);
        },
        setThreadApprovalPolicy: ({ threadId, policy }) => {
          deps.orchestrator.setThreadApprovalPolicy(threadId, policy);
        },
        compactThread: async ({ threadId }) =>
          deps.orchestrator.compact(threadId),
        sendPrompt: async (input: SendPromptInput) => {
          void deps.orchestrator.sendPrompt(input).catch((error: unknown) => {
            sendStream({
              threadId: input.threadId,
              event: {
                kind: "turn_error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Unable to start the run",
              },
            });
          });
          return { accepted: true };
        },
        abortThread: async ({ threadId }) => ({
          restored: await deps.orchestrator.abort(threadId),
        }),
        resolveToolApproval: ({
          threadId,
          toolCallId,
          approved,
          rememberForSession,
          reason,
        }) => {
          deps.orchestrator.resolveApproval(
            threadId,
            toolCallId,
            approved,
            rememberForSession,
            reason,
          );
        },
        editPrompt: async ({ threadId, userIndex, text }) => {
          void deps.orchestrator
            .editPrompt(threadId, userIndex, text)
            .catch((error: unknown) => {
              sendStream({
                threadId,
                event: {
                  kind: "turn_error",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Unable to edit the message",
                },
              });
            });
          return { accepted: true };
        },
        getRunChanges: ({ threadId }) =>
          deps.orchestrator.latestChanges(threadId),
        undoRunChanges: ({ threadId, runId }) =>
          deps.orchestrator.undoChanges(threadId, runId),
        getSettings: () => settingsSnapshot(deps),
        updateSettings: async (patch) => {
          for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) deps.database.setSetting(key, value);
          }
          if (patch.approvalPolicy !== undefined) {
            deps.orchestrator.reevaluateApprovals();
          }
          if (patch.theme !== undefined) deps.pluginWindows.refreshAll();
          return settingsSnapshot(deps);
        },
        setProviderApiKey: async ({ provider, apiKey }) => {
          await setApiKey(provider, apiKey.trim());
          const record = deps.database.getProvider(provider);
          if (record)
            await deps.registry.addOrUpdateProvider(record, apiKey.trim());
          return { valid: apiKey.trim().length > 0 };
        },
        removeProviderApiKey: async ({ provider }) => {
          await deleteApiKey(provider);
          deps.registry.removeProvider(provider);
        },
        listProviders: async () =>
          withKeyFlags(deps, deps.database.listProviders()),
        saveProvider: async (input) => {
          const record = deps.database.saveProvider(input);
          if (input.apiKey?.trim())
            await setApiKey(record.id, input.apiKey.trim());
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
        testProvider: async ({ provider }) => {
          // Testing a paused gateway is a use of it: bring it up first.
          try {
            await beforeGatewayRequest(deps.database, provider);
            return await deps.registry.testProvider(provider);
          } finally {
            afterGatewayRequest(deps.database, provider);
          }
        },
        fetchProviderModels: ({ baseUrl, apiKey }) =>
          fetchRemoteModels(baseUrl, apiKey ?? undefined),
        listPlugins: async () => pluginSummaries(deps.database),
        getMarketplace: () => ({
          notice: MARKETPLACE_NOTICE,
          entries: MARKETPLACE,
        }),
        openPluginWindow: ({ plugin: pluginId }) => {
          const plugin = findPlugin(pluginId);
          if (!plugin || plugin.kind !== "gateway") {
            throw new Error(`Plugin ${pluginId} has no window`);
          }
          if (!isPluginAccepted(deps.database, plugin)) {
            throw new Error(
              "Accept this plugin's permissions before opening it.",
            );
          }
          if (!deps.pluginWindows.openPlugin(plugin)) {
            throw new Error(`Plugin ${pluginId} has no window`);
          }
        },
        updatePlugin: async ({
          plugin: pluginId,
          enabled,
          accepted,
          values,
        }) => {
          const plugin = findPlugin(pluginId);
          if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
          if (accepted === true) acceptPlugin(deps.database, plugin);
          if (enabled !== undefined && plugin.kind === "title") {
            if (enabled && !isPluginAccepted(deps.database, plugin)) {
              throw new Error(
                "Accept this plugin's permissions before enabling it.",
              );
            }
            setPluginEnabled(deps.database, plugin, enabled);
          }
          if (values) {
            savePluginValues(deps.database, plugin, values);
            notifyGatewaySettings(deps.database, plugin);
          }
          return toPluginSummary(deps.database, plugin);
        },
        probePlugin: async ({ plugin: pluginId, values }) => {
          const plugin = findPlugin(pluginId);
          if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
          if (!isPluginAccepted(deps.database, plugin)) {
            return {
              ok: false,
              error: "Accept this plugin's permissions before using it.",
            };
          }
          if (plugin.kind === "title") {
            const deviceId = getOrCreatePluginDeviceId(deps.database, plugin);
            const result = await plugin.probe(values, { deviceId });
            if (result.ok) {
              savePluginValues(deps.database, plugin, values);
            }
            return result;
          }
          const storedApiKey =
            (await getApiKey(plugin.providerId)) ?? undefined;
          const outcome = await plugin.probe(values, {
            storedApiKey,
            dataDir: pluginDataDir(plugin.id),
          });
          if (!outcome.ok || !outcome.proposal) {
            const { proposal: _proposal, ...result } = outcome;
            return result;
          }

          const proposal = outcome.proposal;
          const record = deps.database.saveProvider({
            id: proposal.providerId,
            displayName: proposal.displayName,
            protocol: proposal.protocol,
            baseUrl: proposal.baseUrl,
            models: proposal.models,
          });
          const apiKey = proposal.apiKey ?? storedApiKey;
          if (apiKey) await setApiKey(record.id, apiKey);
          const withKey: ProviderRecord = {
            ...record,
            hasApiKey: apiKey !== undefined,
          };
          await deps.registry.addOrUpdateProvider(withKey, apiKey);
          await ensureDefaultProvider(deps, record);
          savePluginValues(deps.database, plugin, values);
          notifyGatewaySettings(deps.database, plugin);

          const { proposal: _proposal, ...result } = outcome;
          return { ...result, provider: withKey };
        },
        getAvailableModels: async () => {
          await deps.registry.syncWithDatabase();
          return deps.registry.listAvailable();
        },
        getSyncConfig: () => getSyncConfig(deps.database),
        updateSyncConfig: (input) => updateSyncConfig(deps.database, input),
        connectGoogleDrive: (input) => connectGoogleDrive(deps.database, input),
        disconnectGoogleDrive: () => disconnectGoogleDrive(deps.database),
        triggerSync: async () => {
          sendSync({ state: "running" });
          try {
            const result = await triggerSync(deps.database);
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
        updaterGetStatus: () => deps.updater.status(),
        updaterCheckNow: () => deps.updater.checkManual(),
        updaterDownloadUpdate: () => deps.updater.startDownload(),
        updaterCommitRestart: ({ appState }) =>
          deps.updater.commitRestart(appState),
        updaterTakeHandoff: () => deps.updater.takeStartupHandoff(),
        openUpdatePage: () => {
          const releaseUrl = deps.updater.status().release_url;
          if (!releaseUrl || !/^https?:\/\//i.test(releaseUrl))
            return { opened: false };
          Utils.openExternal(releaseUrl);
          return { opened: true };
        },
        getRunningThreadCount: () =>
          deps.orchestrator.runningThreadIds().length,
        getCliStatus: () => getCliStatus(),
        installCli: () => installCli(),
        uninstallCli: () => uninstallCli(),
      },
      messages: {},
    },
  });

  sendStream = (payload) => rpc.send.agentStreamEvent(payload);
  sendSync = (payload) => rpc.send.syncStatus(payload);
  return rpc;
}

async function createThread(
  deps: RpcDeps,
  input: CreateThreadInput,
): Promise<ThreadSummary> {
  const workspace = deps.database.getWorkspace(input.workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  const defaults = await deps.registry.ensureDefault();
  const provider =
    input.modelProvider ??
    deps.database.getSetting("defaultProvider", "") ??
    "";
  const modelId =
    input.modelId ?? deps.database.getSetting("defaultModelId", "") ?? "";
  const thinkingLevel =
    input.thinkingLevel ??
    (deps.database.getSetting(
      "defaultThinkingLevel",
      "medium",
    ) as ThinkingLevel);
  const chosenProvider = provider || defaults?.provider || "";
  const chosenModel = modelId || defaults?.modelId || "";
  // Only a provider whose plugin offers chat threads has a choice; the plugin's
  // saved default applies unless this thread asked for something else.
  const mode: ThreadMode = resolveNewThreadMode(
    deps.database,
    chosenProvider,
    input.mode,
  );
  const id = newId("th");
  const sessionDir = getSessionDir(workspace.id);
  const manager = SessionManager.create(workspace.rootPath, sessionDir, { id });
  const sessionFilePath =
    manager.getSessionFile() ?? join(sessionDir, `${id}.jsonl`);
  deps.database.touchWorkspace(workspace.id);
  const thread = deps.database.createThread({
    id,
    workspaceId: workspace.id,
    title: "New Thread",
    sessionFilePath,
    modelProvider: chosenProvider,
    modelId: chosenModel,
    thinkingLevel,
    mode,
    approvalPolicy: input.approvalPolicy ?? null,
  });
  return thread;
}

/**
 * Destructive thread operations would corrupt a run another Kip process is
 * driving right now, so they are refused instead of racing it.
 */
function refuseWhileDrivenElsewhere(
  deps: RpcDeps,
  threadIds: string[],
): void {
  const busy = threadIds.find((threadId) =>
    deps.orchestrator.isLockedElsewhere(threadId),
  );
  if (!busy) return;
  throw new Error(
    "This thread is running in another Kip process. Stop that run first.",
  );
}

/**
 * Picking a model in any thread also makes it the default, so the next new
 * thread starts where the last choice left off. Only models the registry still
 * exposes are remembered; a deleted provider must not poison the default.
 */
function rememberModelChoice(
  deps: RpcDeps,
  provider: string,
  modelId: string,
): void {
  if (!deps.registry.getModel(provider, modelId)) return;
  deps.database.setSetting("defaultProvider", provider);
  deps.database.setSetting("defaultModelId", modelId);
}

async function settingsSnapshot(deps: RpcDeps): Promise<SettingsSnapshot> {
  await deps.registry.syncWithDatabase();
  const providers = await withKeyFlags(deps, deps.database.listProviders());
  return {
    theme: deps.database.getSetting("theme", "system"),
    approvalPolicy: deps.database.getSetting(
      "approvalPolicy",
      "read-only-auto",
    ),
    defaultProvider: deps.database.getSetting("defaultProvider", ""),
    defaultModelId: deps.database.getSetting("defaultModelId", ""),
    defaultThinkingLevel: deps.database.getSetting(
      "defaultThinkingLevel",
      "medium",
    ),
    chatModeProviders: chatModeSupport(deps.database),
    sidebarCollapsed: deps.database.getSetting("sidebarCollapsed", false),
    cliTuiLayout: deps.database.getSetting("cliTuiLayout", "inline"),
    configuredProviders: providers
      .filter((provider) => provider.hasApiKey)
      .map((p) => p.id),
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

async function ensureDefaultProvider(
  deps: RpcDeps,
  record: ProviderRecord,
): Promise<void> {
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
