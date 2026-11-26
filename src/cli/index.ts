#!/usr/bin/env bun
/**
 * Kip CLI / TUI entrypoint.
 *
 *   kip                    Start interactive TUI in the current folder
 *   kip -p "prompt"        Ask once and print the answer to stdout
 *   git diff | kip -p ...  Pipe stdin context into a one-shot prompt
 *   kip models             List configured models
 */
import pkg from "../../package.json";
import { ModelRegistry } from "../bun/agent/model-registry";
import { KipDatabase } from "../bun/storage/db";
import { formatHelp, parseCliArgs } from "./args";
import { runPrintMode } from "./print-mode";
import { CliRuntime } from "./runtime";
import { runTui } from "./tui/app";

const VERSION = pkg.version ?? "0.0.0";

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function listModelsCommand(): Promise<number> {
  const database = new KipDatabase();
  try {
    const registry = await ModelRegistry.create(database);
    const models = registry.listAvailable();
    const defaultProvider = database.getSetting("defaultProvider", "");
    const defaultModel = database.getSetting("defaultModelId", "");
    if (models.length === 0) {
      console.log(
        "No models configured yet. Open Kip Desktop → Settings → Providers to add one.",
      );
      return 0;
    }
    for (const model of models) {
      const isDefault =
        model.provider === defaultProvider && model.modelId === defaultModel;
      const mark = isDefault ? "*" : " ";
      const ctx = model.contextWindow
        ? `${Math.round(model.contextWindow / 1000)}k`
        : "";
      console.log(
        `${mark} ${model.provider}/${model.modelId}  ${model.displayName}${ctx ? ` (${ctx})` : ""}`,
      );
    }
    return 0;
  } finally {
    database.close();
  }
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `kip: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  if (args.command === "help") {
    console.log(formatHelp(VERSION));
    return 0;
  }
  if (args.command === "version") {
    console.log(`kip ${VERSION}`);
    return 0;
  }
  if (args.command === "models") {
    return listModelsCommand();
  }

  const stdinIsTty = Boolean(process.stdin.isTTY);
  const piped = stdinIsTty ? "" : await readPipedStdin();
  const usePrintMode = args.print || !stdinIsTty;

  const combinedPrompt = [piped, args.prompt ?? ""]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();

  if (usePrintMode && !combinedPrompt) {
    console.error(
      'kip: provide a prompt with `-p "..."` or pipe input via stdin.',
    );
    return 2;
  }

  const cwd = args.cwd ?? process.cwd();
  let runtime: CliRuntime;
  try {
    runtime = await CliRuntime.create({
      cwd,
      ephemeral: usePrintMode,
      continueLast: args.continueLast,
      modelQuery: args.model,
      thinking: args.thinking,
      policy: args.policy,
      chat: args.chat,
    });
  } catch (error) {
    console.error(
      `kip: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  try {
    if (usePrintMode) {
      if (runtime.availableModels.length === 0) {
        console.error(
          "kip: no model configured yet. Open Kip Desktop → Settings → Providers to add one.",
        );
        return 1;
      }
      return await runPrintMode(runtime, {
        prompt: combinedPrompt,
        quiet: args.quiet,
        canPromptApproval: stdinIsTty && Boolean(process.stderr.isTTY),
      });
    }

    return await runTui(runtime, {
      initialPrompt: combinedPrompt || null,
      resumed: args.continueLast,
      layout: args.layout ?? runtime.getTuiLayout(),
    });
  } finally {
    await runtime.dispose();
  }
}

process.on("unhandledRejection", (reason) => {
  console.error(
    "kip:",
    reason instanceof Error ? reason.message : String(reason),
  );
  process.exit(1);
});

const exitCode = await main();
process.exit(exitCode);
