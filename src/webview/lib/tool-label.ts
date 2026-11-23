/**
 * Labels for tool steps by state. The Bun side reports finished work in the
 * past tense ("Wrote a.ts"); a step that is still running or waiting for
 * approval must not read as if it already happened.
 */
import type { ToolCallBlock } from "../../shared/types";

export function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const source = parts.indexOf("src");
  if (source >= 0) return parts.slice(source).join("/");
  if (parts.length > 4) return `…/${parts.slice(-3).join("/")}`;
  return normalized;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Present progressive, for the live action line: "Writing src/a.ts". */
export function activeLabel(
  block: Pick<ToolCallBlock, "toolName" | "args">,
): string {
  const path =
    typeof block.args.path === "string" ? shortPath(block.args.path) : "";
  switch (block.toolName) {
    case "bash": {
      const command =
        typeof block.args.command === "string" ? block.args.command : "";
      return command ? `Running ${clip(command, 40)}` : "Running a command";
    }
    case "read":
      return path ? `Reading ${path}` : "Reading a file";
    case "edit":
      return path ? `Editing ${path}` : "Editing";
    case "write":
      return path ? `Writing ${path}` : "Writing";
    case "grep":
      return "Searching the codebase";
    case "find":
      return "Finding files";
    case "ls":
      return "Listing files";
    default:
      return `Using ${block.toolName}`;
  }
}

/** Imperative, for steps that have not happened: "Write src/a.ts". */
export function intentLabel(
  block: Pick<ToolCallBlock, "toolName" | "args">,
): string {
  const path =
    typeof block.args.path === "string" ? shortPath(block.args.path) : "";
  switch (block.toolName) {
    case "bash": {
      const command =
        typeof block.args.command === "string" ? block.args.command : "";
      return command ? `Run ${clip(command, 64)}` : "Run a command";
    }
    case "read":
      return path ? `Read ${path}` : "Read a file";
    case "edit":
      return path ? `Edit ${path}` : "Edit a file";
    case "write":
      return path ? `Write ${path}` : "Write a file";
    case "grep":
      return `Search ${String(block.args.pattern ?? "")}`.trim();
    case "find":
      return `Find files ${String(block.args.pattern ?? "")}`.trim();
    case "ls":
      return "List files";
    default:
      return `Use ${block.toolName}`;
  }
}

/** The label a step shows in the work log for its current status. */
export function stepLabel(block: ToolCallBlock): string {
  if (block.status === "running") return activeLabel(block);
  if (block.status === "awaiting_approval" || block.status === "denied")
    return intentLabel(block);
  return block.summaryLabel;
}
