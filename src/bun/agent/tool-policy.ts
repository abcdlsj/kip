/**
 * Pure safety and presentation helpers for tool calls. Keeping these free of
 * I/O lets the policy be unit-tested and reused by both the interceptor and UI.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { diffLines } from "diff";

export type CommandRisk = "safe" | "standard" | "high-risk";

const SAFE_COMMANDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "which",
  "echo",
  "rg",
  "grep",
  "find",
  "git",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "branch", "show", "rev-parse"]);

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, label: "recursive delete" },
  { pattern: /\bsudo\b/, label: "privilege escalation" },
  { pattern: /\bchmod\s+777\b/, label: "world-writable permissions" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, label: "filesystem format" },
  { pattern: /\bdd\s+if=/, label: "raw disk write" },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: "discards local changes" },
  { pattern: /\bgit\s+push\s+.*--force\b/, label: "force push" },
  { pattern: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/, label: "pipes network input to a shell" },
  { pattern: /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/, label: "pipes network input to a shell" },
  { pattern: />\s*\/dev\/sd[a-z]/, label: "writes a raw device" },
];

const RESTRICTED_ROOTS = [".ssh", ".aws", ".gnupg"];

export function realPathForGuard(target: string): string {
  const absolute = resolve(target);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = realPathForGuard(root);
  const resolvedTarget = realPathForGuard(
    isAbsolute(target) ? target : resolve(resolvedRoot, target),
  );
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

export function resolveToolPath(workspaceRoot: string, targetPath: string): string {
  return isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspaceRoot, targetPath);
}

export function isSensitivePath(targetPath: string): boolean {
  const expanded = targetPath.startsWith("~")
    ? resolve(homedir(), targetPath.slice(1))
    : resolve(targetPath);
  const home = homedir();
  if (expanded === resolve(home, ".kip", "credentials.enc")) return true;
  for (const root of RESTRICTED_ROOTS) {
    const restricted = resolve(home, root);
    if (expanded === restricted || expanded.startsWith(`${restricted}${sep}`)) return true;
  }
  return false;
}

function splitShellSegments(command: string): string[] {
  const withoutSubshells = command
    .replace(/\$\(([^()]*)\)/g, (_, inner: string) => ` ; ${inner} ; `)
    .replace(/`([^`]*)`/g, (_, inner: string) => ` ; ${inner} ; `);
  return withoutSubshells
    .split(/(?:&&|\|\||;|\|)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function classifySegment(raw: string): CommandRisk {
  const segment = raw.trim();
  if (!segment) return "safe";

  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.pattern.test(segment)) return "high-risk";
  }

  if (/(^|[^>])>{1,2}(?!&)/.test(segment)) return "standard";

  const words = segment.match(/[^\s]+/g) ?? [];
  const first = (words[0] ?? "").replace(/^\(/, "");
  if (!SAFE_COMMANDS.has(first)) return "standard";

  if (first === "find" && /-(exec|delete)\b/.test(segment)) return "standard";
  if (first === "git") {
    const sub = words[1] ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return "standard";
    if (sub === "branch" && !segment.includes("--show-current") && words.length > 2) {
      return "standard";
    }
    return "safe";
  }
  return "safe";
}

export function classifyCommand(command: string): { risk: CommandRisk; reason: string } {
  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.pattern.test(command)) return { risk: "high-risk", reason: rule.label };
  }
  const segments = splitShellSegments(command);
  let highest: CommandRisk = "safe";
  for (const segment of segments) {
    const risk = classifySegment(segment);
    if (risk === "high-risk") return { risk, reason: "destructive command" };
    if (risk === "standard") highest = "standard";
  }
  return {
    risk: highest,
    reason: highest === "safe" ? "read-only command" : "may modify the workspace",
  };
}

export function commandTouchesSensitivePath(command: string): boolean {
  const trimmed = command.replace(/["']/g, "");
  const markers = [
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    join(homedir(), ".gnupg"),
    join(homedir(), ".kip", "credentials.enc"),
  ];
  if (markers.some((marker) => trimmed.includes(marker))) return true;
  return /(^|[\s/])~?\/\.ssh\b|(^|[\s/])~?\/\.aws\b|(^|[\s/])~?\/\.gnupg\b/.test(trimmed);
}

export function needsApproval(
  policy: "read-only-auto" | "full-auto" | "strict",
  risk: CommandRisk,
  outsideWorkspace: boolean,
  isMutation: boolean,
): boolean {
  if (outsideWorkspace) return true;
  if (policy === "full-auto") return false;
  if (policy === "strict") return true;
  if (isMutation) return true;
  return risk !== "safe";
}

export function countLineChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

export function shortenPath(path: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  change?: { added: number; removed: number },
): string {
  const pathValue = typeof args.path === "string" ? shortenPath(args.path, workspaceRoot) : "";
  switch (toolName) {
    case "read":
      return `Read ${pathValue || "file"}`;
    case "write":
      return `Wrote ${pathValue || "file"}${change ? ` (+${change.added})` : ""}`;
    case "edit":
      return `Edited ${pathValue || "file"}${
        change ? ` (+${change.added} -${change.removed})` : ""
      }`;
    case "bash": {
      const command = typeof args.command === "string" ? args.command : "command";
      return `Ran ${command.length > 64 ? `${command.slice(0, 61)}...` : command}`;
    }
    case "grep":
      return `Searched ${String(args.pattern ?? "pattern")}`;
    case "find":
      return `Found files ${String(args.pattern ?? "")}`.trim();
    case "ls":
      return `Listed ${pathValue || basename(workspaceRoot)}`;
    default:
      return `Called ${toolName}`;
  }
}

export const MUTATING_TOOLS = new Set(["write", "edit"]);
