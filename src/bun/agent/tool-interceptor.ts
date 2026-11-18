/**
 * Wraps Pi's built-in tools with Kip's safety boundary: workspace containment,
 * sensitive-file denial, command classification, diff previews, and a promise
 * that suspends mutating calls until the user decides.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ApprovalPolicy,
  ToolApprovalPayload,
  ToolCallBlock,
} from "../../shared/types";
import {
  MUTATING_TOOLS,
  classifyCommand,
  commandApprovalKeys,
  commandPathsOutsideRoot,
  commandTouchesSensitivePath,
  countLineChanges,
  isSensitivePath,
  isWithinRoot,
  needsApproval,
  resolveToolPath,
  summarizeToolCall,
} from "./tool-policy";

export interface InterceptorOptions {
  workspaceRoot: string;
  threadId: string;
  /** Read on every call so a change in Settings applies to open threads. */
  policy: ApprovalPolicy | (() => ApprovalPolicy);
  requestApproval: (payload: ToolApprovalPayload) => void;
  /** Awaited before every tool runs; used to finish the pre-run Git snapshot. */
  beforeTool?: () => Promise<void>;
}

interface PendingApproval {
  resolve: (decision: { approved: boolean; reason?: string }) => void;
}

interface CallMeta {
  summaryLabel: string;
  diff?: { before: string; after: string; filePath: string };
  risk: "safe" | "standard" | "high-risk";
  outsideWorkspace: boolean;
  command?: string;
  /** Resolved target of a file tool; remembered approvals are scoped to it. */
  filePath?: string;
}

const MAX_DIFF_BYTES = 512 * 1024;

export class ToolInterceptor {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionAllowlist = new Set<string>();
  private readonly callMeta = new Map<string, CallMeta>();

  constructor(private readonly options: InterceptorOptions) {}

  wrap(tool: ToolDefinition<never, unknown>): ToolDefinition<never, unknown> {
    const original = tool.execute.bind(tool) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const label = tool.label;
    const description = tool.description;
    const parameters = tool.parameters;

    const wrapped: ToolDefinition<never, unknown> = {
      ...tool,
      label,
      description,
      parameters,
      execute: async (
        toolCallId: string,
        params: never,
        signal: AbortSignal | undefined,
        onUpdate: never,
        ctx: never,
      ) => {
        const args = params as unknown as Record<string, unknown>;
        await this.options.beforeTool?.();
        await this.authorize(toolCallId, tool.name, args, signal);
        return (await original(toolCallId, params, signal, onUpdate, ctx)) as never;
      },
    };
    return wrapped;
  }

  getMeta(toolCallId: string): CallMeta | undefined {
    return this.callMeta.get(toolCallId);
  }

  resolveApproval(
    toolCallId: string,
    approved: boolean,
    rememberForSession = false,
    reason?: string,
  ): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    this.pending.delete(toolCallId);
    if (approved && rememberForSession) {
      const meta = this.callMeta.get(toolCallId);
      if (meta && meta.risk !== "high-risk" && !meta.outsideWorkspace) {
        if (meta.command) {
          for (const key of commandApprovalKeys(meta.command)) this.sessionAllowlist.add(key);
        } else if (meta.filePath) {
          this.sessionAllowlist.add(fileApprovalKey(meta.filePath));
        }
      }
    }
    pending.resolve({ approved, reason: reason?.trim().slice(0, 600) || undefined });
  }

  cancelAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve({ approved: false });
      void reason;
    }
  }

  private async authorize(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const targetPath =
      typeof args.path === "string" ? resolveToolPath(this.options.workspaceRoot, args.path) : null;

    if (targetPath && isSensitivePath(targetPath)) {
      throw new Error("Access to this path is blocked by Kip's safety policy");
    }
    if (toolName === "bash" && commandTouchesSensitivePath(String(args.command ?? ""))) {
      throw new Error("This command touches a credential path blocked by Kip's safety policy");
    }

    const command = toolName === "bash" ? String(args.command ?? "") : undefined;
    const outsideWorkspace =
      (targetPath !== null && !isWithinRoot(this.options.workspaceRoot, targetPath)) ||
      (command !== undefined &&
        commandPathsOutsideRoot(command, this.options.workspaceRoot).length > 0);
    const isMutation = MUTATING_TOOLS.has(toolName);

    let risk: "safe" | "standard" | "high-risk" = "safe";
    if (toolName === "bash") {
      risk = classifyCommand(String(args.command ?? "")).risk;
    } else if (isMutation) {
      risk = "standard";
    }

    let previewDiff: CallMeta["diff"];
    let summaryLabel = summarizeToolCall(toolName, args, this.options.workspaceRoot);

    if (toolName === "write" || toolName === "edit") {
      previewDiff = this.buildDiff(toolName, args, targetPath);
      if (previewDiff) {
        const change = countLineChanges(previewDiff.before, previewDiff.after);
        summaryLabel = summarizeToolCall(toolName, args, this.options.workspaceRoot, change);
      }
    }

    const filePath = isMutation && targetPath ? targetPath : undefined;
    const meta: CallMeta = {
      summaryLabel,
      diff: previewDiff,
      risk,
      outsideWorkspace,
      command,
      filePath,
    };
    this.callMeta.set(toolCallId, meta);

    // Remembered commands never cover high-risk or out-of-workspace calls, and
    // every segment of a compound command must have been approved before.
    const keys = command ? commandApprovalKeys(command) : [];
    const allowlisted =
      risk !== "high-risk" &&
      !outsideWorkspace &&
      (filePath
        ? this.sessionAllowlist.has(fileApprovalKey(filePath))
        : keys.length > 0 && keys.every((key) => this.sessionAllowlist.has(key)));

    const policy =
      typeof this.options.policy === "function" ? this.options.policy() : this.options.policy;
    const mustAsk = !allowlisted && needsApproval(policy, risk, outsideWorkspace, isMutation);

    if (!mustAsk) return;

    const decision = await new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      this.pending.set(toolCallId, { resolve });
      signal?.addEventListener(
        "abort",
        () => {
          const pending = this.pending.get(toolCallId);
          if (!pending) return;
          this.pending.delete(toolCallId);
          pending.resolve({ approved: false });
        },
        { once: true },
      );
      this.options.requestApproval({
        threadId: this.options.threadId,
        toolCallId,
        toolName,
        summaryLabel,
        commandOrPath:
          toolName === "bash"
            ? String(args.command ?? "")
            : previewDiff?.filePath
              ? relative(this.options.workspaceRoot, previewDiff.filePath)
              : targetPath
                ? relative(this.options.workspaceRoot, targetPath)
                : "",
        risk,
        outsideWorkspace,
        previewDiff,
      });
    });

    if (!decision.approved) {
      throw new Error(
        decision.reason
          ? `The user denied this tool call. Their reason: ${decision.reason}`
          : "The user denied this tool call",
      );
    }
  }

  private buildDiff(
    toolName: string,
    args: Record<string, unknown>,
    targetPath: string | null,
  ): CallMeta["diff"] {
    if (!targetPath) return undefined;
    let before = "";
    if (existsSync(targetPath)) {
      try {
        if (statSync(targetPath).size <= MAX_DIFF_BYTES) {
          before = readFileSync(targetPath, "utf8");
        }
      } catch {
        before = "";
      }
    }
    let after = before;
    if (toolName === "write") {
      after = typeof args.content === "string" ? args.content : "";
    } else {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      for (const edit of edits) {
        if (typeof edit !== "object" || edit === null) continue;
        const oldText = (edit as Record<string, unknown>).oldText;
        const newText = (edit as Record<string, unknown>).newText;
        if (typeof oldText === "string" && typeof newText === "string") {
          // A function replacement keeps `$&` and `$1` in newText literal.
          after = after.replace(oldText, () => newText);
        }
      }
    }
    return { before, after, filePath: targetPath };
  }
}

function fileApprovalKey(path: string): string {
  return `file:${path}`;
}

export function blockToRunningTool(block: ToolCallBlock): ToolCallBlock {
  return { ...block, status: "running" };
}
