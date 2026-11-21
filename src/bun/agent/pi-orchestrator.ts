/**
 * In-process Pi session pool. One ActiveSession per thread; concurrent threads
 * stream independently and never share an AbortController or tool queue.
 *
 * Tool providers, system prompt context providers, and tool lifecycle hooks are
 * injected via `OrchestratorOptions` so capabilities (MCP tools, workspace
 * instructions, telemetry, custom guardrails) can grow without editing this core.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ApprovalPolicy,
  ChatTurn,
  ContextUsage,
  RunChanges,
  PromptDelivery,
  QueuedPrompt,
  SendPromptInput,
  ThinkingLevel,
  ThreadSummary,
  ToolCallBlock,
  ToolApprovalPayload,
} from "../../shared/types";
import type { KipDatabase, StoredRunChanges } from "../storage/db";
import { getDataDir, getSessionDir, newId } from "../storage/db";
import { diffTrees, restoreRun, snapshotTree } from "../system/git-snapshot";
import { ContextBuilder } from "./context-builder";
import type { ModelRegistry } from "./model-registry";
import { FrameBuffer, type StreamEmit } from "./stream-buffer";
import { ToolInterceptor, type ToolHook } from "./tool-interceptor";
import { ToolRegistry } from "./tool-registry";
import {
  projectSessionTurns,
  textOf,
  titleFromPrompt,
  toSharedUsage,
} from "./session-bridge";
import { summarizeToolCall } from "./tool-policy";
import { generateTitleWithPlugins } from "../plugins/registry";

export interface OrchestratorOptions {
  toolRegistry?: ToolRegistry;
  contextBuilder?: ContextBuilder;
  hooks?: ToolHook[];
  /** Maximum number of idle sessions retained in memory before LRU eviction. */
  maxIdleSessions?: number;
}

const DEFAULT_MAX_IDLE_SESSIONS = 12;

interface ActiveSession {
  threadId: string;
  session: AgentSession;
  interceptor: ToolInterceptor;
  unsubscribe: () => void;
  running: boolean;
  lastActiveAt: number;
  currentTurn: ChatTurn | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  thinkingStartedAt: number | null;
  buffer: FrameBuffer;
  firstPrompt: string | null;
  queued: QueuedEntry[];
  /** Git tree of the workspace when the current run started; null outside Git. */
  runBefore: Promise<string | null> | null;
}

/** Prefix for notes Kip adds to a prompt; the transcript view hides these lines. */
const KIP_NOTE_PREFIX = "[Kip note] ";

/** A message sent during a run, waiting for Pi to deliver it. */
interface QueuedEntry extends QueuedPrompt {
  /** Exact text handed to Pi; matched against the delivered user message. */
  promptText: string;
  attachments?: ChatTurn["attachments"];
}

export class KipOrchestrator {
  private readonly sessions = new Map<string, ActiveSession>();
  /** Prevents concurrent `ensureSession` calls from creating duplicate sessions. */
  private readonly initializing = new Map<string, Promise<ActiveSession>>();
  /** Notes for the model, delivered with the next prompt (for example after an undo). */
  private readonly pendingNotes = new Map<string, string[]>();
  readonly toolRegistry: ToolRegistry;
  readonly contextBuilder: ContextBuilder;
  private readonly hooks: ToolHook[];
  private readonly maxIdleSessions: number;

  constructor(
    private readonly database: KipDatabase,
    private readonly registry: ModelRegistry,
    private readonly emit: StreamEmit,
    options: OrchestratorOptions = {},
  ) {
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
    this.hooks = options.hooks ?? [];
    this.maxIdleSessions = options.maxIdleSessions ?? DEFAULT_MAX_IDLE_SESSIONS;
  }

  runningThreadIds(): string[] {
    return [...this.sessions.values()].filter((item) => item.running).map((item) => item.threadId);
  }

  isRunning(threadId: string): boolean {
    return this.sessions.get(threadId)?.running ?? false;
  }

  async createThreadSession(
    threadId: string,
    workspaceRoot: string,
  ): Promise<string> {
    const sessionDir = getSessionDir(this.database.getThread(threadId)?.workspaceId ?? "default");
    mkdirSync(sessionDir, { recursive: true });
    const manager = SessionManager.create(workspaceRoot, sessionDir, { id: threadId });
    const file = manager.getSessionFile();
    if (!file) throw new Error("Unable to create session file");
    mkdirSync(dirname(file), { recursive: true });
    return file;
  }

  async loadTurns(threadId: string): Promise<{ turns: ChatTurn[]; usage: ContextUsage }> {
    const thread = this.requireThread(threadId);
    const workspace = this.database.getWorkspace(thread.workspaceId);
    if (!workspace) return { turns: [], usage: toSharedUsage(undefined) };
    if (!thread.sessionFilePath || !existsSync(thread.sessionFilePath)) {
      return { turns: [], usage: toSharedUsage(undefined) };
    }
    const active = this.sessions.get(threadId);
    if (active) {
      return {
        turns: projectSessionTurns(active.session.sessionManager.getBranch(), workspace.rootPath),
        usage: toSharedUsage(active.session.getContextUsage()),
      };
    }
    const manager = SessionManager.open(thread.sessionFilePath, undefined, workspace.rootPath);
    // Only the active branch is shown; edited messages leave older branches in the file.
    const entries = manager.getBranch();
    const model = this.registry.getModel(thread.modelProvider, thread.modelId);
    const contextWindow = (model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
    let used = 0;
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const usage = (entry.message as { usage?: { totalTokens?: number } }).usage;
      used = usage?.totalTokens ?? 0;
      break;
    }
    return {
      turns: projectSessionTurns(entries, workspace.rootPath),
      usage: {
        usedTokens: used,
        maxTokens: contextWindow,
        ratio: contextWindow > 0 ? Math.min(1, used / contextWindow) : 0,
      },
    };
  }

  async sendPrompt(input: SendPromptInput): Promise<void> {
    const active = await this.ensureSession(input.threadId);
    const referenced = input.referencedFiles?.length
      ? `Referenced files:\n${input.referencedFiles.map((file) => `- ${file}`).join("\n")}\n\n`
      : "";
    const notes = this.pendingNotes.get(input.threadId) ?? [];
    this.pendingNotes.delete(input.threadId);
    const noteText = notes.length ? `${notes.map((note) => KIP_NOTE_PREFIX + note).join("\n")}\n\n` : "";
    const promptText = `${noteText}${referenced}${input.text}`;
    const images: ImageContent[] = (input.images ?? []).map((image) => ({
      type: "image",
      data: image.base64Data,
      mimeType: image.mimeType,
    }));

    if (active.running) {
      await this.queuePrompt(active, input, promptText, images);
      return;
    }

    active.running = true;
    active.firstPrompt = null;
    const thread = this.requireThread(input.threadId);
    const workspace = this.database.getWorkspace(thread.workspaceId);
    if (!workspace) {
      active.running = false;
      throw new Error("Workspace missing");
    }
    if (thread.title === "New Thread") {
      active.firstPrompt = input.text;
    }
    // Snapshot in parallel with the model's first response; every tool call
    // waits for it (see beforeTool), so the snapshot always precedes changes.
    active.runBefore = snapshotTree(workspace.rootPath).catch(() => null);

    try {
      await active.session.prompt(promptText, images.length ? { images } : undefined);
    } catch (error) {
      active.running = false;
      active.buffer.clear();
      this.emit(input.threadId, {
        kind: "turn_error",
        message: error instanceof Error ? error.message : "The agent run failed",
      });
    } finally {
      active.buffer.flush();
      active.running = false;
      // A failed run may never settle; still record what it changed.
      if ((active.runBefore as ActiveSession["runBefore"]) !== null) void this.recordRunChanges(active).catch(() => undefined);
      this.database.touchThread(input.threadId);
    }
  }

  private async queuePrompt(
    active: ActiveSession,
    input: SendPromptInput,
    promptText: string,
    images: ImageContent[],
  ): Promise<void> {
    const delivery: PromptDelivery = input.delivery ?? "followUp";
    const attachments: NonNullable<ChatTurn["attachments"]> = [
      ...(input.referencedFiles ?? []).map((path) => ({
        name: path.split("/").pop() ?? path,
        path,
        mimeType: "text/plain",
      })),
      ...(input.images ?? []).map((image, index) => ({
        name: `image-${index + 1}`,
        path: `image-${index + 1}`,
        mimeType: image.mimeType,
      })),
    ];
    active.queued.push({
      id: `q_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
      text: input.text,
      delivery,
      promptText,
      attachments: attachments.length ? attachments : undefined,
    });
    this.emitQueue(active);
    await active.session.prompt(promptText, {
      images: images.length ? images : undefined,
      streamingBehavior: delivery,
    });
  }

  private emitQueue(active: ActiveSession): void {
    this.emit(active.threadId, {
      kind: "queue_update",
      queued: active.queued.map(({ id, text, delivery }) => ({ id, text, delivery })),
    });
  }

  async abort(threadId: string): Promise<string[]> {
    const active = this.sessions.get(threadId);
    if (!active) return [];
    active.interceptor.cancelAll("aborted");
    // Drop queued messages before aborting so Pi does not start them, and hand
    // their text back to the composer instead of losing it.
    const restored = active.queued.map((entry) => entry.text);
    active.queued = [];
    active.session.clearQueue();
    this.emitQueue(active);
    await active.session.abort();
    active.running = false;
    return restored;
  }

  /**
   * Moves the thread back to just before one of its user messages and sends
   * new text from there. The old branch stays in the JSONL file.
   */
  async editPrompt(threadId: string, userIndex: number, text: string): Promise<void> {
    const active = await this.ensureSession(threadId);
    if (active.running) throw new Error("Stop the current run before editing a message");
    const users = active.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "user");
    const target = users[userIndex];
    if (!target) throw new Error("That message is no longer in this thread");
    await active.session.navigateTree(target.id);
    await this.sendPrompt({ threadId, text });
  }

  latestChanges(threadId: string): RunChanges | null {
    const stored = this.database.latestRunChanges(threadId);
    return stored ? toRunChanges(stored) : null;
  }

  async undoChanges(
    threadId: string,
    runId: string,
  ): Promise<{ ok: boolean; error?: string; next: RunChanges | null }> {
    if (this.isRunning(threadId)) {
      return { ok: false, error: "Wait for the run to finish.", next: this.latestChanges(threadId) };
    }
    const stored = this.database.getRunChanges(runId);
    const thread = this.requireThread(threadId);
    const workspace = this.database.getWorkspace(thread.workspaceId);
    if (!stored || stored.threadId !== threadId || !workspace) {
      return { ok: false, error: "Nothing to undo.", next: this.latestChanges(threadId) };
    }
    const result = await restoreRun(
      workspace.rootPath,
      stored.beforeTree,
      stored.afterTree,
      stored.files,
    );
    if (!result.ok) {
      return { ok: false, error: result.error, next: this.latestChanges(threadId) };
    }
    this.database.markRunReverted(runId);
    const list = stored.files.map((file) => file.path).join(", ");
    const notes = this.pendingNotes.get(threadId) ?? [];
    notes.push(`The user undid your file changes from an earlier turn (${list}). Those files are back to their previous content.`);
    this.pendingNotes.set(threadId, notes);
    const next = this.latestChanges(threadId);
    this.emit(threadId, { kind: "changes_update", changes: next });
    return { ok: true, next };
  }

  private async recordRunChanges(active: ActiveSession): Promise<void> {
    const pendingBefore = active.runBefore;
    active.runBefore = null;
    if (!pendingBefore) return;
    const before = await pendingBefore;
    if (!before) return;
    const thread = this.database.getThread(active.threadId);
    const workspace = thread ? this.database.getWorkspace(thread.workspaceId) : null;
    if (!workspace) return;
    const after = await snapshotTree(workspace.rootPath);
    if (!after || after === before) return;
    const files = await diffTrees(workspace.rootPath, before, after);
    if (files.length === 0) return;
    this.database.addRunChanges({
      id: newId("run"),
      threadId: active.threadId,
      beforeTree: before,
      afterTree: after,
      files,
      createdAt: Date.now(),
    });
    this.emit(active.threadId, { kind: "changes_update", changes: this.latestChanges(active.threadId) });
  }

  async compact(threadId: string): Promise<ContextUsage> {
    const active = await this.ensureSession(threadId);
    await active.session.compact();
    return toSharedUsage(active.session.getContextUsage());
  }

  resolveApproval(
    threadId: string,
    toolCallId: string,
    approved: boolean,
    rememberForSession = false,
    reason?: string,
  ): void {
    const active = this.sessions.get(threadId);
    if (!active) return;
    active.interceptor.resolveApproval(toolCallId, approved, rememberForSession, reason);
    const block = findToolBlock(active.currentTurn, toolCallId);
    if (block && block.status === "awaiting_approval") {
      block.status = approved ? "running" : "denied";
    }
    this.emit(threadId, {
      kind: "tool_approved",
      turnId: active.currentTurn?.id ?? "",
      toolCallId,
      approved,
    });
  }

  async updateThreadModel(threadId: string, provider: string, modelId: string): Promise<void> {
    const active = this.sessions.get(threadId);
    const model = this.registry.getModel(provider, modelId);
    this.database.updateThread(threadId, { modelProvider: provider, modelId });
    if (active && model) {
      await active.session.setModel(model as never);
    }
  }

  setThinkingLevel(threadId: string, level: ThinkingLevel): void {
    this.database.updateThread(threadId, { thinkingLevel: level });
    const active = this.sessions.get(threadId);
    if (active) active.session.setThinkingLevel(level);
  }

  setThreadApprovalPolicy(threadId: string, policy: ApprovalPolicy | null): void {
    this.database.updateThread(threadId, { approvalPolicy: policy });
    this.reevaluateApprovals(threadId);
  }

  reevaluateApprovals(threadId?: string): void {
    const targets = threadId
      ? [this.sessions.get(threadId)].filter((s): s is ActiveSession => Boolean(s))
      : [...this.sessions.values()];
    for (const active of targets) {
      const approved = active.interceptor.reevaluatePending();
      for (const toolCallId of approved) {
        const block = findToolBlock(active.currentTurn, toolCallId);
        if (block) block.status = "running";
        this.emit(active.threadId, {
          kind: "tool_approved",
          turnId: active.currentTurn?.id ?? "",
          toolCallId,
        });
      }
    }
  }

  /** Aborts and releases a thread's in-memory Pi session (e.g. when deleted). */
  async disposeSession(threadId: string): Promise<void> {
    this.pendingNotes.delete(threadId);
    const active = this.sessions.get(threadId);
    if (!active) return;
    this.sessions.delete(threadId);
    active.buffer.clear();
    active.interceptor.cancelAll("disposed");
    active.queued = [];
    try {
      active.session.clearQueue();
      if (active.running) await active.session.abort();
    } catch {
      // Best-effort abort during disposal.
    }
    active.running = false;
    try {
      active.unsubscribe();
      active.session.dispose();
    } catch {
      // Disposal must never throw.
    }
  }

  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.disposeSession(id)));
    this.sessions.clear();
    this.pendingNotes.clear();
  }

  private evictIdleSessions(keepThreadId: string): void {
    const idle = [...this.sessions.values()]
      .filter(
        (item) =>
          item.threadId !== keepThreadId &&
          !item.running &&
          item.interceptor.pendingCount === 0,
      )
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    while (idle.length > this.maxIdleSessions) {
      const victim = idle.shift();
      if (!victim) break;
      void this.disposeSession(victim.threadId);
    }
  }

  private async ensureSession(threadId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(threadId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    const inflight = this.initializing.get(threadId);
    if (inflight) return inflight;

    const creating = this.createSession(threadId).finally(() => {
      this.initializing.delete(threadId);
    });
    this.initializing.set(threadId, creating);
    return creating;
  }

  private async createSession(threadId: string): Promise<ActiveSession> {
    const thread = this.requireThread(threadId);
    const workspace = this.database.getWorkspace(thread.workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    const model = await this.resolveModel(thread);
    if (!model) throw new Error("Add a model provider in Settings before starting a chat");

    const sessionManager =
      thread.sessionFilePath && existsSync(thread.sessionFilePath)
        ? SessionManager.open(thread.sessionFilePath, undefined, workspace.rootPath)
        : SessionManager.create(workspace.rootPath, getSessionDir(thread.workspaceId), { id: threadId });

    let active: ActiveSession;
    const buffer = new FrameBuffer(this.emit, threadId);
    const interceptor = new ToolInterceptor({
      workspaceRoot: workspace.rootPath,
      threadId,
      policy: () =>
        this.database.getThread(threadId)?.approvalPolicy ??
        this.database.getSetting("approvalPolicy", "read-only-auto"),
      requestApproval: (payload) => this.requestApproval(threadId, payload),
      beforeTool: async () => {
        await this.sessions.get(threadId)?.runBefore;
      },
      hooks: this.hooks,
    });

    const [rawTools, systemPromptSections] = await Promise.all([
      this.toolRegistry.resolveTools({
        threadId,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
      }),
      this.contextBuilder.buildSystemPromptSections({
        threadId,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        workspaceName: workspace.name,
      }),
    ]);
    const tools = rawTools.map((tool) => interceptor.wrap(tool));

    const agentDir = join(getDataDir(), "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const settingsManager = SettingsManager.create(workspace.rootPath, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.rootPath,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: systemPromptSections,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: workspace.rootPath,
      modelRuntime: this.registry.runtime,
      model: model as never,
      thinkingLevel: thread.thinkingLevel,
      sessionManager,
      settingsManager,
      resourceLoader,
      noTools: "builtin",
      customTools: tools,
      tools: tools.map((tool) => tool.name),
    });

    const path = session.sessionManager.getSessionFile();
    if (path && path !== thread.sessionFilePath) {
      this.database.updateThread(threadId, { sessionFilePath: path });
    }

    active = {
      threadId,
      session,
      interceptor,
      unsubscribe: () => {},
      running: false,
      lastActiveAt: Date.now(),
      currentTurn: null,
      textBlockId: null,
      thinkingBlockId: null,
      thinkingStartedAt: null,
      firstPrompt: null,
      buffer,
      queued: [],
      runBefore: null,
    };

    active.unsubscribe = session.subscribe((event) => this.onSessionEvent(active, event));
    this.sessions.set(threadId, active);
    this.evictIdleSessions(threadId);
    return active;
  }

  private async resolveModel(thread: ThreadSummary) {
    await this.registry.syncWithDatabase();
    let model = this.registry.getModel(thread.modelProvider, thread.modelId);
    if (model) return model;
    const fallback = await this.registry.ensureDefault();
    if (!fallback) return undefined;
    model = this.registry.getModel(fallback.provider, fallback.modelId);
    if (model) {
      this.database.updateThread(thread.id, {
        modelProvider: fallback.provider,
        modelId: fallback.modelId,
      });
    }
    return model;
  }

  private requestApproval(threadId: string, payload: ToolApprovalPayload): void {
    const active = this.sessions.get(threadId);
    if (!active) return;
    active.buffer.flush();
    const block = findToolBlock(active.currentTurn, payload.toolCallId);
    if (block) block.status = "awaiting_approval";
    this.emit(threadId, {
      kind: "tool_approval_required",
      turnId: active.currentTurn?.id ?? "",
      approval: payload,
    });
  }

  private onSessionEvent(active: ActiveSession, event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "user") {
          this.onUserMessage(active, textOf(event.message.content));
          return;
        }
        if (event.message.role !== "assistant") return;
        if (!active.currentTurn) {
          const turn: ChatTurn = {
            id: `turn_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
            role: "assistant",
            blocks: [],
            createdAt: Date.now(),
          };
          active.currentTurn = turn;
          this.emit(active.threadId, { kind: "turn_start", turn });
        }
        active.textBlockId = null;
        active.thinkingBlockId = null;
        active.thinkingStartedAt = null;
        return;
      }
      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_delta" && active.currentTurn) {
          const blockId = this.ensureTextBlock(active);
          active.buffer.push("text_delta", active.currentTurn.id, blockId, assistantEvent.delta);
        } else if (assistantEvent.type === "thinking_delta" && active.currentTurn) {
          const blockId = this.ensureThinkingBlock(active);
          active.buffer.push("thinking_delta", active.currentTurn.id, blockId, assistantEvent.delta);
        } else if (assistantEvent.type === "thinking_end" && active.currentTurn) {
          active.buffer.flush();
          const blockId = this.ensureThinkingBlock(active);
          const durationMs =
            active.thinkingStartedAt === null ? 0 : Date.now() - active.thinkingStartedAt;
          const block = active.currentTurn.blocks.find((item) => item.id === blockId);
          if (block?.type === "thinking") {
            block.isComplete = true;
            block.durationMs = durationMs;
          }
          this.emit(active.threadId, {
            kind: "thinking_done",
            turnId: active.currentTurn.id,
            blockId,
            durationMs,
          });
        }
        return;
      }
      case "tool_execution_start": {
        if (!active.currentTurn) return;
        active.buffer.flush();
        const args = (event.args ?? {}) as Record<string, unknown>;
        const block: ToolCallBlock = {
          type: "tool_call",
          id: event.toolCallId,
          toolName: event.toolName,
          args,
          status: "running",
          summaryLabel: summarizeToolCall(
            event.toolName,
            args,
            this.database.getWorkspace(this.requireThread(active.threadId).workspaceId)?.rootPath ?? "",
          ),
        };
        active.currentTurn.blocks.push(block);
        this.emit(active.threadId, {
          kind: "tool_start",
          turnId: active.currentTurn.id,
          block,
        });
        return;
      }
      case "tool_execution_end": {
        if (!active.currentTurn) return;
        active.buffer.flush();
        const meta = active.interceptor.getMeta(event.toolCallId);
        const block = findToolBlock(active.currentTurn, event.toolCallId);
        const denial = event.isError && /denied|blocked by Kip/i.test(textOf(event.result?.content));
        if (block) {
          block.status = denial ? "denied" : event.isError ? "error" : "completed";
          block.durationMs = event.durationMs ?? 0;
          block.summaryLabel = meta?.summaryLabel ?? block.summaryLabel;
          block.risk = meta?.risk;
          block.outsideWorkspace = meta?.outsideWorkspace;
          block.diff = meta?.diff;
          block.output = textOf(event.result?.content);
        }
        this.emit(active.threadId, {
          kind: "tool_end",
          turnId: active.currentTurn.id,
          toolCallId: event.toolCallId,
          status: denial ? "denied" : event.isError ? "error" : "completed",
          output: textOf(event.result?.content),
          diff: meta?.diff,
          durationMs: event.durationMs ?? 0,
          summaryLabel: meta?.summaryLabel ?? block?.summaryLabel ?? "Tool call",
        });
        return;
      }
      case "agent_settled": {
        active.buffer.flush();
        active.running = false;
        if (active.queued.length) {
          active.queued = [];
          this.emitQueue(active);
        }
        this.emit(active.threadId, {
          kind: "usage_update",
          usage: toSharedUsage(active.session.getContextUsage()),
        });
        this.emit(active.threadId, { kind: "turn_complete" });
        void this.recordRunChanges(active).catch(() => undefined);
        const firstAssistantText = active.currentTurn
          ? active.currentTurn.blocks
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
              .trim()
          : "";
        active.currentTurn = null;
        active.textBlockId = null;
        active.thinkingBlockId = null;
        if (active.firstPrompt) {
          const firstPrompt = active.firstPrompt;
          const fallbackTitle = titleFromPrompt(firstPrompt);
          active.firstPrompt = null;
          this.database.updateThread(active.threadId, { title: fallbackTitle });
          this.emit(active.threadId, { kind: "thread_title_updated", title: fallbackTitle });
          void this.enhanceThreadTitle(
            active.threadId,
            firstPrompt,
            firstAssistantText,
            fallbackTitle,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private async enhanceThreadTitle(
    threadId: string,
    userText: string,
    assistantText: string,
    fallbackTitle: string,
  ): Promise<void> {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: userText },
    ];
    if (assistantText) {
      messages.push({ role: "assistant", content: assistantText });
    }
    const aiTitle = await generateTitleWithPlugins(this.database, {
      mode: "initial",
      messages,
    });
    if (!aiTitle) return;
    // Never overwrite a title the user renamed while the request was in flight.
    const current = this.database.getThread(threadId);
    if (!current || current.title !== fallbackTitle) return;
    this.database.updateThread(threadId, { title: aiTitle });
    this.emit(threadId, { kind: "thread_title_updated", title: aiTitle });
  }

  async regenerateThreadTitle(threadId: string): Promise<string | null> {
    const { turns } = await this.loadTurns(threadId);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const turn of turns) {
      const content = turn.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!content) continue;
      messages.push({ role: turn.role, content });
    }
    if (!messages.some((m) => m.role === "user")) return null;
    const aiTitle = await generateTitleWithPlugins(this.database, {
      mode: "conversation",
      messages: messages.slice(-10),
    });
    if (!aiTitle) return null;
    this.database.updateThread(threadId, { title: aiTitle });
    this.emit(threadId, { kind: "thread_title_updated", title: aiTitle });
    return aiTitle;
  }

  /**
   * Pi emits message_start for every user message, including the one that
   * started the run. Only messages we queued mid-run split the transcript.
   */
  private onUserMessage(active: ActiveSession, text: string): void {
    const index = active.queued.findIndex((entry) => text.startsWith(entry.promptText));
    if (index === -1) return;
    const [entry] = active.queued.splice(index, 1);
    this.emitQueue(active);
    if (!entry) return;
    active.buffer.flush();
    active.currentTurn = null;
    active.textBlockId = null;
    active.thinkingBlockId = null;
    active.thinkingStartedAt = null;
    this.emit(active.threadId, {
      kind: "user_turn",
      turn: {
        id: `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
        role: "user",
        blocks: [{ type: "text", id: `utxt_${entry.id}`, text: entry.text }],
        attachments: entry.attachments,
        createdAt: Date.now(),
      },
    });
  }

  private ensureTextBlock(active: ActiveSession): string {
    if (active.textBlockId) return active.textBlockId;
    const id = `txt_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    active.currentTurn?.blocks.push({ type: "text", id, text: "" });
    active.textBlockId = id;
    return id;
  }

  private ensureThinkingBlock(active: ActiveSession): string {
    if (active.thinkingBlockId) return active.thinkingBlockId;
    const id = `thk_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    active.currentTurn?.blocks.push({
      type: "thinking",
      id,
      thinking: "",
      isComplete: false,
    });
    active.thinkingBlockId = id;
    active.thinkingStartedAt = Date.now();
    return id;
  }

  private requireThread(threadId: string): ThreadSummary {
    const thread = this.database.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    return thread;
  }
}

function toRunChanges(stored: StoredRunChanges): RunChanges {
  return {
    id: stored.id,
    threadId: stored.threadId,
    files: stored.files,
    added: stored.files.reduce((sum, file) => sum + file.added, 0),
    removed: stored.files.reduce((sum, file) => sum + file.removed, 0),
    createdAt: stored.createdAt,
  };
}

function findToolBlock(turn: ChatTurn | null, toolCallId: string): ToolCallBlock | undefined {
  if (!turn) return undefined;
  for (const block of turn.blocks) {
    if (block.type === "tool_call" && block.id === toolCallId) return block;
  }
  return undefined;
}

