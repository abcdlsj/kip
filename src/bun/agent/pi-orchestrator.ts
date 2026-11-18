/**
 * In-process Pi session pool. One ActiveSession per thread; concurrent threads
 * stream independently and never share an AbortController or tool queue.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentStreamEvent,
  ChatTurn,
  ContextUsage,
  SendPromptInput,
  ThinkingLevel,
  ThreadSummary,
  ToolCallBlock,
  ToolApprovalPayload,
} from "../../shared/types";
import { DEFAULT_SYSTEM_PROMPT, STREAM_FRAME_MS } from "../../shared/constants";
import type { KipDatabase } from "../storage/db";
import { getDataDir, getSessionDir } from "../storage/db";
import type { ModelRegistry } from "./model-registry";
import { ToolInterceptor } from "./tool-interceptor";
import {
  projectSessionTurns,
  textOf,
  titleFromPrompt,
  toSharedUsage,
} from "./session-bridge";
import { summarizeToolCall } from "./tool-policy";

type Emit = (threadId: string, event: AgentStreamEvent) => void;

interface ActiveSession {
  threadId: string;
  session: AgentSession;
  interceptor: ToolInterceptor;
  unsubscribe: () => void;
  running: boolean;
  currentTurn: ChatTurn | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  thinkingStartedAt: number | null;
  buffer: FrameBuffer;
  firstPrompt: string | null;
}

class FrameBuffer {
  private readonly pending = new Map<string, { kind: "text_delta" | "thinking_delta"; turnId: string; text: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly emit: Emit, private readonly threadId: string) {}

  push(kind: "text_delta" | "thinking_delta", turnId: string, blockId: string, delta: string): void {
    const key = `${kind}:${blockId}`;
    const existing = this.pending.get(key);
    if (existing) existing.text += delta;
    else this.pending.set(key, { kind, turnId, text: delta });
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), STREAM_FRAME_MS);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [key, value] of this.pending) {
      const blockId = key.slice(key.indexOf(":") + 1);
      this.emit(this.threadId, {
        kind: value.kind,
        turnId: value.turnId,
        blockId,
        delta: value.text,
      });
    }
    this.pending.clear();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

export class KipOrchestrator {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(
    private readonly database: KipDatabase,
    private readonly registry: ModelRegistry,
    private readonly emit: Emit,
  ) {}

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
        turns: projectSessionTurns(active.session.sessionManager.getEntries(), workspace.rootPath),
        usage: toSharedUsage(active.session.getContextUsage()),
      };
    }
    const manager = SessionManager.open(thread.sessionFilePath, undefined, workspace.rootPath);
    const entries = manager.getEntries();
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
    if (active.running) throw new Error("This thread is already running");
    active.running = true;
    active.firstPrompt = null;
    const thread = this.requireThread(input.threadId);
    const workspace = this.database.getWorkspace(thread.workspaceId);
    if (!workspace) throw new Error("Workspace missing");

    const referenced = input.referencedFiles?.length
      ? `Referenced files:\n${input.referencedFiles.map((file) => `- ${file}`).join("\n")}\n\n`
      : "";
    const promptText = `${referenced}${input.text}`;
    if (thread.title === "New Thread") {
      active.firstPrompt = input.text;
    }

    const images: ImageContent[] = (input.images ?? []).map((image) => ({
      type: "image",
      data: image.base64Data,
      mimeType: image.mimeType,
    }));

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
      this.database.touchThread(input.threadId);
    }
  }

  async abort(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId);
    if (!active) return;
    active.interceptor.cancelAll("aborted");
    await active.session.abort();
    active.running = false;
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
  ): void {
    const active = this.sessions.get(threadId);
    active?.interceptor.resolveApproval(toolCallId, approved, rememberForSession);
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

  async shutdown(): Promise<void> {
    for (const active of this.sessions.values()) {
      active.buffer.clear();
      active.interceptor.cancelAll("shutdown");
      try {
        active.unsubscribe();
        active.session.dispose();
      } catch {
        // Shutdown is best-effort; the process is exiting.
      }
    }
    this.sessions.clear();
  }

  private async ensureSession(threadId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;

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
      policy: () => this.database.getSetting("approvalPolicy", "read-only-auto"),
      requestApproval: (payload) => this.requestApproval(threadId, payload),
    });

    const tools = [
      createReadToolDefinition(workspace.rootPath),
      createWriteToolDefinition(workspace.rootPath),
      createEditToolDefinition(workspace.rootPath),
      createBashToolDefinition(workspace.rootPath, {
        spawnHook: (context) => ({
          ...context,
          env: {
            ...context.env,
            GIT_PAGER: "cat",
            PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
            NO_COLOR: "1",
          },
        }),
      }),
      createGrepToolDefinition(workspace.rootPath),
      createFindToolDefinition(workspace.rootPath),
      createLsToolDefinition(workspace.rootPath),
    ].map((tool) => interceptor.wrap(tool as unknown as ToolDefinition<never, unknown>));

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
      appendSystemPrompt: [DEFAULT_SYSTEM_PROMPT],
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
      currentTurn: null,
      textBlockId: null,
      thinkingBlockId: null,
      thinkingStartedAt: null,
      firstPrompt: null,
      buffer,
    };

    active.unsubscribe = session.subscribe((event) => this.onSessionEvent(active, event));
    this.sessions.set(threadId, active);
    return active;
  }

  private async resolveModel(thread: ThreadSummary) {
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
          summaryLabel: meta?.summaryLabel ?? "Tool call",
        });
        return;
      }
      case "agent_settled": {
        active.buffer.flush();
        active.running = false;
        this.emit(active.threadId, {
          kind: "usage_update",
          usage: toSharedUsage(active.session.getContextUsage()),
        });
        this.emit(active.threadId, { kind: "turn_complete" });
        active.currentTurn = null;
        active.textBlockId = null;
        active.thinkingBlockId = null;
        if (active.firstPrompt) {
          const title = titleFromPrompt(active.firstPrompt);
          active.firstPrompt = null;
          this.database.updateThread(active.threadId, { title });
          this.emit(active.threadId, { kind: "thread_title_updated", title });
        }
        return;
      }
      default:
        return;
    }
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

function findToolBlock(turn: ChatTurn | null, toolCallId: string): ToolCallBlock | undefined {
  if (!turn) return undefined;
  for (const block of turn.blocks) {
    if (block.type === "tool_call" && block.id === toolCallId) return block;
  }
  return undefined;
}

