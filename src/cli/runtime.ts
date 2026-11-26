/**
 * Shared runtime bootstrap for both CLI print mode and interactive TUI.
 * Reuses Kip's SQLite store, secure credential vault, model registry, plugins,
 * and Pi orchestrator so desktop and terminal stay completely in sync.
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelRegistry } from "../bun/agent/model-registry";
import { KipOrchestrator } from "../bun/agent/pi-orchestrator";
import { hasSessionMessages } from "../bun/agent/session-bridge";
import {
  afterGatewayRequest,
  beforeGatewayRequest,
  disposePlugins,
  resolveNewThreadMode,
} from "../bun/plugins/registry";
import { getSessionDir, KipDatabase, newId } from "../bun/storage/db";
import type {
  AgentStreamEvent,
  ApprovalPolicy,
  CliTuiLayout,
  ModelOption,
  ThinkingLevel,
  ThreadMode,
  ThreadSummary,
  Workspace,
} from "../shared/types";
import { resolveModelOption } from "./args";

export type StreamListener = (
  threadId: string,
  event: AgentStreamEvent,
) => void;

export interface CliRuntimeOptions {
  cwd: string;
  ephemeral: boolean;
  continueLast: boolean;
  modelQuery?: string;
  thinking?: ThinkingLevel;
  policy?: ApprovalPolicy;
  chat?: boolean;
  onEvent?: StreamListener;
}

export class CliRuntime {
  readonly database: KipDatabase;
  readonly registry: ModelRegistry;
  readonly orchestrator: KipOrchestrator;
  readonly workspace: Workspace;
  thread: ThreadSummary;
  private listener: StreamListener;
  private readonly createdWorkspace: boolean;
  private readonly ephemeral: boolean;
  private readonly ephemeralThreadIds = new Set<string>();
  /** Threads created during this CLI/TUI session; removed on switch/exit if still empty. */
  private readonly createdThreadIds = new Set<string>();
  private disposed = false;

  private constructor(params: {
    database: KipDatabase;
    registry: ModelRegistry;
    orchestrator: KipOrchestrator;
    workspace: Workspace;
    thread: ThreadSummary;
    listener: StreamListener;
    createdWorkspace: boolean;
    ephemeral: boolean;
    createdInitialThread: boolean;
  }) {
    this.database = params.database;
    this.registry = params.registry;
    this.orchestrator = params.orchestrator;
    this.workspace = params.workspace;
    this.thread = params.thread;
    this.listener = params.listener;
    this.createdWorkspace = params.createdWorkspace;
    this.ephemeral = params.ephemeral;
    if (params.ephemeral) {
      this.ephemeralThreadIds.add(params.thread.id);
    }
    if (params.createdInitialThread) {
      this.createdThreadIds.add(params.thread.id);
    }
  }

  static async create(options: CliRuntimeOptions): Promise<CliRuntime> {
    const resolvedCwd = safeRealpath(resolve(options.cwd));
    const database = new KipDatabase();
    const registry = await ModelRegistry.create(database);

    let listener: StreamListener = options.onEvent ?? (() => {});
    const orchestrator = new KipOrchestrator(
      database,
      registry,
      (threadId, event) => listener(threadId, event),
      {
        providerActivity: {
          before: (providerId) => beforeGatewayRequest(database, providerId),
          after: (providerId) => afterGatewayRequest(database, providerId),
        },
      },
    );

    const { workspace, created } = ensureWorkspace(database, resolvedCwd);
    const chosenModel = await pickInitialModel(
      database,
      registry,
      options.modelQuery,
    );
    const defaultThinking = database.getSetting<ThinkingLevel>(
      "defaultThinkingLevel",
      "medium",
    );
    const thinkingLevel = options.thinking ?? defaultThinking;

    let thread: ThreadSummary | null = null;
    if (options.continueLast) {
      const existing =
        database
          .listThreads(workspace.id)
          .find((item) => hasSessionMessages(item.sessionFilePath)) ?? null;
      if (existing) {
        thread = existing;
        if (options.modelQuery && chosenModel) {
          database.updateThread(thread.id, {
            modelProvider: chosenModel.provider,
            modelId: chosenModel.modelId,
          });
          thread = database.getThread(thread.id) ?? thread;
        }
        if (options.thinking) {
          database.updateThread(thread.id, { thinkingLevel: options.thinking });
          thread = database.getThread(thread.id) ?? thread;
        }
        if (options.policy) {
          database.updateThread(thread.id, { approvalPolicy: options.policy });
          thread = database.getThread(thread.id) ?? thread;
        }
      }
    }

    const createdInitialThread = thread === null;
    const isEphemeral = options.ephemeral && createdInitialThread;
    if (!thread) {
      const mode: ThreadMode = options.chat
        ? "chat"
        : resolveNewThreadMode(database, chosenModel?.provider ?? "");
      thread = createPersistedThread({
        database,
        workspace,
        provider: chosenModel?.provider ?? "",
        modelId: chosenModel?.modelId ?? "",
        thinkingLevel,
        mode,
        approvalPolicy: options.policy ?? null,
      });
    }

    const runtime = new CliRuntime({
      database,
      registry,
      orchestrator,
      workspace,
      thread,
      listener,
      createdWorkspace: created,
      ephemeral: isEphemeral,
      createdInitialThread,
    });
    // Allow callers to attach listeners after construction.
    listener = (threadId, event) => runtime.listener(threadId, event);
    return runtime;
  }

  setEventListener(fn: StreamListener): void {
    this.listener = fn;
  }

  get availableModels(): ModelOption[] {
    return this.registry.listAvailable();
  }

  get currentModel(): ModelOption | undefined {
    return this.registry
      .listAvailable()
      .find(
        (item) =>
          item.provider === this.thread.modelProvider &&
          item.modelId === this.thread.modelId,
      );
  }

  get effectivePolicy(): ApprovalPolicy {
    return (
      this.thread.approvalPolicy ??
      this.database.getSetting<ApprovalPolicy>(
        "approvalPolicy",
        "read-only-auto",
      )
    );
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.orchestrator.updateThreadModel(
      this.thread.id,
      provider,
      modelId,
    );
    if (this.registry.getModel(provider, modelId)) {
      this.database.setSetting("defaultProvider", provider);
      this.database.setSetting("defaultModelId", modelId);
    }
    this.thread = this.database.getThread(this.thread.id) ?? this.thread;
  }

  setThinking(level: ThinkingLevel): void {
    this.orchestrator.setThinkingLevel(this.thread.id, level);
    this.thread = this.database.getThread(this.thread.id) ?? this.thread;
  }

  setPolicy(policy: ApprovalPolicy): void {
    this.orchestrator.setThreadApprovalPolicy(this.thread.id, policy);
    this.thread = this.database.getThread(this.thread.id) ?? this.thread;
  }

  getTuiLayout(): CliTuiLayout {
    const stored = this.database.getSetting<string>("cliTuiLayout", "inline");
    return stored === "fullscreen" ? "fullscreen" : "inline";
  }

  setTuiLayout(layout: CliTuiLayout): void {
    this.database.setSetting("cliTuiLayout", layout);
  }

  async setMode(mode: ThreadMode): Promise<void> {
    await this.orchestrator.setThreadMode(this.thread.id, mode);
    this.thread = this.database.getThread(this.thread.id) ?? this.thread;
  }

  createNewThread(options?: { mode?: ThreadMode }): ThreadSummary {
    const previousId = this.thread.id;
    const mode =
      options?.mode ??
      resolveNewThreadMode(this.database, this.thread.modelProvider);
    const next = createPersistedThread({
      database: this.database,
      workspace: this.workspace,
      provider: this.thread.modelProvider,
      modelId: this.thread.modelId,
      thinkingLevel: this.thread.thinkingLevel,
      mode,
      approvalPolicy: this.thread.approvalPolicy ?? null,
    });
    this.createdThreadIds.add(next.id);
    this.thread = next;
    this.cleanupEmptyThread(previousId);
    return next;
  }

  switchThread(threadId: string): ThreadSummary {
    const target = this.database.getThread(threadId);
    if (!target) throw new Error("Thread not found");
    const previousId = this.thread.id;
    this.thread = target;
    if (previousId !== target.id) {
      this.cleanupEmptyThread(previousId);
    }
    return target;
  }

  listWorkspaceThreads(): ThreadSummary[] {
    return this.database
      .listThreads(this.workspace.id)
      .filter(
        (item) =>
          item.id === this.thread.id ||
          hasSessionMessages(item.sessionFilePath),
      );
  }

  private cleanupEmptyThread(threadId: string): void {
    if (!this.createdThreadIds.has(threadId)) return;
    const stored = this.database.getThread(threadId);
    if (!stored) {
      this.createdThreadIds.delete(threadId);
      return;
    }
    if (hasSessionMessages(stored.sessionFilePath)) return;
    this.createdThreadIds.delete(threadId);
    this.database.deleteThread(threadId);
    if (stored.sessionFilePath && existsSync(stored.sessionFilePath)) {
      rmSync(stored.sessionFilePath, { force: true });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.orchestrator.shutdown();
    } catch {
      // Best-effort shutdown.
    }
    try {
      await disposePlugins();
    } catch {
      // Best-effort plugin teardown.
    }
    if (this.ephemeral) {
      for (const threadId of this.ephemeralThreadIds) {
        const stored = this.database.getThread(threadId);
        this.database.deleteThread(threadId);
        if (stored?.sessionFilePath && existsSync(stored.sessionFilePath)) {
          rmSync(stored.sessionFilePath, { force: true });
        }
      }
    }
    // Never leave untouched empty threads behind when exiting TUI.
    for (const threadId of [...this.createdThreadIds]) {
      this.cleanupEmptyThread(threadId);
    }
    if (this.createdWorkspace) {
      const remaining = this.database.listThreads(this.workspace.id);
      if (remaining.length === 0) {
        this.database.removeWorkspace(this.workspace.id);
        const sessionDir = getSessionDir(this.workspace.id);
        if (existsSync(sessionDir)) {
          rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    }
    try {
      this.database.close();
    } catch {
      // Ignore double close.
    }
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function ensureWorkspace(
  database: KipDatabase,
  rootPath: string,
): { workspace: Workspace; created: boolean } {
  const existing = database.findWorkspaceByPath(rootPath);
  if (existing) {
    database.touchWorkspace(existing.id);
    return { workspace: existing, created: false };
  }
  const name = basename(rootPath) || rootPath;
  return {
    workspace: database.createWorkspace(name, rootPath),
    created: true,
  };
}

async function pickInitialModel(
  database: KipDatabase,
  registry: ModelRegistry,
  query?: string,
): Promise<{ provider: string; modelId: string } | null> {
  await registry.syncWithDatabase();
  const available = registry.listAvailable();
  if (query) {
    const resolved = resolveModelOption(available, query);
    if (resolved.match) {
      return {
        provider: resolved.match.provider,
        modelId: resolved.match.modelId,
      };
    }
    if (resolved.candidates && resolved.candidates.length > 1) {
      const list = resolved.candidates
        .slice(0, 6)
        .map(
          (item) =>
            `  - ${item.provider}/${item.modelId} (${item.displayName})`,
        )
        .join("\n");
      throw new Error(
        `Model "${query}" matched multiple models:\n${list}\nPass a more specific id or provider/model.`,
      );
    }
    throw new Error(
      `Model "${query}" was not found. Run \`kip models\` to list configured models.`,
    );
  }

  const defaults = await registry.ensureDefault();
  if (defaults) return defaults;
  const fallbackProvider = database.getSetting("defaultProvider", "");
  const fallbackModel = database.getSetting("defaultModelId", "");
  if (fallbackProvider && fallbackModel) {
    return { provider: fallbackProvider, modelId: fallbackModel };
  }
  return null;
}

function createPersistedThread(input: {
  database: KipDatabase;
  workspace: Workspace;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  mode: ThreadMode;
  approvalPolicy: ApprovalPolicy | null;
}): ThreadSummary {
  const id = newId("th");
  const sessionDir = getSessionDir(input.workspace.id);
  const manager = SessionManager.create(input.workspace.rootPath, sessionDir, {
    id,
  });
  const sessionFilePath =
    manager.getSessionFile() ?? join(sessionDir, `${id}.jsonl`);
  input.database.touchWorkspace(input.workspace.id);
  return input.database.createThread({
    id,
    workspaceId: input.workspace.id,
    title: "New Thread",
    sessionFilePath,
    modelProvider: input.provider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    mode: input.mode,
    approvalPolicy: input.approvalPolicy,
  });
}
