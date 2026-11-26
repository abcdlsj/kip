/**
 * One-shot print mode (`kip -p "..."` or piped stdin).
 * Streams pure assistant text to stdout while keeping status and approval
 * prompts quiet on stderr so pipelines (`kip -p "..." | pbcopy`) stay clean.
 */
import { createInterface } from "node:readline/promises";
import { formatToolDuration } from "../shared/duration";
import type { AgentStreamEvent, ToolApprovalPayload } from "../shared/types";
import type { CliRuntime } from "./runtime";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[38;2;238;136;132m";
const AMBER = "\x1b[38;2;209;160;65m";
const GREEN = "\x1b[38;2;122;185;72m";

export interface PrintModeOptions {
  prompt: string;
  quiet: boolean;
  /** True when stdin is a real terminal (not piped), enabling interactive approvals. */
  canPromptApproval: boolean;
}

export async function runPrintMode(
  runtime: CliRuntime,
  options: PrintModeOptions,
): Promise<number> {
  const useColor = Boolean(process.stderr.isTTY && !process.env.NO_COLOR);
  const showStatus = Boolean(process.stderr.isTTY && !options.quiet);
  const dim = (text: string) => (useColor ? `${DIM}${text}${RESET}` : text);
  const err = (text: string) => (useColor ? `${RED}${text}${RESET}` : text);
  const warn = (text: string) => (useColor ? `${AMBER}${text}${RESET}` : text);
  const ok = (text: string) => (useColor ? `${GREEN}${text}${RESET}` : text);

  let wroteStdout = false;
  let endsWithNewline = true;
  let failedMessage: string | null = null;
  let interrupted = false;
  let approvalQueue: Promise<void> = Promise.resolve();

  const onSigint = () => {
    interrupted = true;
    void runtime.orchestrator.abort(runtime.thread.id);
  };
  process.on("SIGINT", onSigint);

  const writeStatus = (line: string) => {
    if (!showStatus) return;
    process.stderr.write(`${line}\n`);
  };

  const handleApproval = async (approval: ToolApprovalPayload) => {
    if (!options.canPromptApproval) {
      if (!options.quiet) {
        process.stderr.write(
          `${warn("!")} Skipped ${approval.summaryLabel} ${dim("(requires approval; pass --permission auto or --yolo)")}\n`,
        );
      }
      runtime.orchestrator.resolveApproval(
        runtime.thread.id,
        approval.toolCallId,
        false,
        false,
        "Running non-interactively without approval.",
      );
      return;
    }

    if (wroteStdout && !endsWithNewline) {
      process.stdout.write("\n");
      endsWithNewline = true;
    }

    const canRemember =
      approval.risk !== "high-risk" && !approval.outsideWorkspace;
    const badge =
      approval.risk === "high-risk"
        ? ` ${err("[high risk]")}`
        : approval.outsideWorkspace
          ? ` ${warn("[outside workspace]")}`
          : "";
    process.stderr.write(
      `\n${warn("?")} ${approval.summaryLabel}${badge}\n` +
        (approval.commandOrPath ? `  ${dim(approval.commandOrPath)}\n` : ""),
    );

    const hint = canRemember
      ? "[y] allow  [a] always  [n] deny"
      : "[y] allow  [n] deny";
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let answer = "";
    try {
      answer = (await rl.question(`  ${dim(hint)} › `)).trim().toLowerCase();
    } catch {
      answer = "n";
    } finally {
      rl.close();
    }

    const approved = answer === "y" || answer === "yes" || answer === "a";
    const remember = canRemember && answer === "a";
    runtime.orchestrator.resolveApproval(
      runtime.thread.id,
      approval.toolCallId,
      approved,
      remember,
    );
  };

  const onEvent = (threadId: string, event: AgentStreamEvent) => {
    if (threadId !== runtime.thread.id) return;
    switch (event.kind) {
      case "text_delta":
        if (!event.delta) return;
        process.stdout.write(event.delta);
        wroteStdout = true;
        endsWithNewline = event.delta.endsWith("\n");
        break;
      case "tool_start":
        writeStatus(dim(`· ${event.block.summaryLabel}…`));
        break;
      case "retry_start":
        writeStatus(
          dim(
            `↻ retrying ${event.attempt}/${event.maxAttempts} · ${event.message}`,
          ),
        );
        break;
      case "gateway_status":
        if (event.phase === "recovered") {
          writeStatus(`${ok("✓")} ${dim(event.message)}`);
        } else if (event.phase === "restarting") {
          writeStatus(dim(`↻ ${event.message}`));
        } else {
          writeStatus(`${warn("!")} ${dim(event.message)}`);
        }
        break;
      case "tool_end": {
        const formatted = formatToolDuration(event.durationMs);
        const ms = formatted ? dim(` (${formatted})`) : "";
        if (event.status === "completed") {
          writeStatus(`${ok("✓")} ${dim(event.summaryLabel)}${ms}`);
        } else if (event.status === "denied") {
          writeStatus(`${warn("×")} ${dim(`${event.summaryLabel} — denied`)}`);
        } else {
          writeStatus(`${err("×")} ${dim(`${event.summaryLabel} — error`)}`);
        }
        break;
      }
      case "tool_approval_required":
        approvalQueue = approvalQueue.then(() =>
          handleApproval(event.approval),
        );
        break;
      case "turn_error":
        failedMessage = event.message;
        break;
      default:
        break;
    }
  };

  runtime.setEventListener(onEvent);

  try {
    await runtime.orchestrator.sendPrompt({
      threadId: runtime.thread.id,
      text: options.prompt,
    });
    await approvalQueue;
  } catch (error) {
    failedMessage =
      error instanceof Error ? error.message : "The agent run failed";
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (wroteStdout && !endsWithNewline) {
    process.stdout.write("\n");
  }

  if (interrupted) return 130;
  if (failedMessage) {
    process.stderr.write(`${err("error:")} ${failedMessage}\n`);
    return 1;
  }
  return 0;
}
