/**
 * Pure safety and presentation helpers for tool calls. Keeping these free of
 * I/O lets the policy be unit-tested and reused by both the interceptor and UI.
 */
import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { diffLines } from "diff";
import type { ApprovalPolicy } from "../../shared/types";
import { pathStartsWith, toPosixPath, userHome } from "../system/platform";

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
  "where",
  "echo",
  "rg",
  "grep",
  "find",
  "git",
  "dir",
  "type",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "branch",
  "show",
  "rev-parse",
]);

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
    label: "recursive delete",
  },
  { pattern: /\bsudo\b/, label: "privilege escalation" },
  { pattern: /\bchmod\s+777\b/, label: "world-writable permissions" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, label: "filesystem format" },
  { pattern: /\bdd\s+if=/, label: "raw disk write" },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: "discards local changes" },
  { pattern: /\bgit\s+push\s+.*--force\b/, label: "force push" },
  {
    pattern: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/,
    label: "pipes network input to a shell",
  },
  {
    pattern: /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/,
    label: "pipes network input to a shell",
  },
  { pattern: />\s*\/dev\/sd[a-z]/, label: "writes a raw device" },
  // Windows / PowerShell destructive equivalents
  {
    pattern: /\b(?:remove-item|ri|del|erase)\b[^\n]*(?:-recurse|-r\b|\/s\b)/i,
    label: "recursive delete",
  },
  {
    pattern: /\b(?:rmdir|rd)\b[^\n]*\/s\b/i,
    label: "recursive directory delete",
  },
  { pattern: /\bformat(?:\.com)?\s+[a-z]:/i, label: "disk format" },
  {
    pattern:
      /\b(?:irm|invoke-restmethod|iwr|invoke-webrequest)\b[^|]*\|\s*(?:iex|invoke-expression)\b/i,
    label: "pipes network input to PowerShell",
  },
];

const RESTRICTED_ROOTS = [".ssh", ".aws", ".gnupg"];

function expandHome(targetPath: string): string {
  if (targetPath === "~") return userHome();
  if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
    return resolve(userHome(), targetPath.slice(2));
  }
  return resolve(targetPath);
}

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
  // On Windows, paths on different drives produce an absolute `rel` (e.g. "D:\\...").
  return (
    rel === "" ||
    (!isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(`..${sep}`))
  );
}

export function resolveToolPath(
  workspaceRoot: string,
  targetPath: string,
): string {
  if (
    targetPath === "~" ||
    targetPath.startsWith("~/") ||
    targetPath.startsWith("~\\")
  ) {
    return expandHome(targetPath);
  }
  return isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(workspaceRoot, targetPath);
}

export function isSensitivePath(targetPath: string): boolean {
  const expanded = expandHome(targetPath);
  const home = userHome();
  const credentials = resolve(home, ".kip", "credentials.enc");
  const machineKey = resolve(home, ".kip", ".machine");
  if (
    pathStartsWith(expanded, credentials) ||
    pathStartsWith(expanded, machineKey)
  )
    return true;
  for (const root of RESTRICTED_ROOTS) {
    const restricted = resolve(home, root);
    if (pathStartsWith(expanded, restricted)) return true;
  }
  return false;
}

export function splitShellSegments(command: string): string[] {
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

  const withoutNullRedirects = segment
    .replace(/(?:\d?>>?|&>)\s*\/dev\/null/g, "")
    .replace(/\d?>&\d/g, "");
  if (/(^|[^>])>{1,2}(?!&)/.test(withoutNullRedirects)) return "standard";

  const words = segment.match(/[^\s]+/g) ?? [];
  const first = (words[0] ?? "").replace(/^\(/, "");
  if (!SAFE_COMMANDS.has(first)) return "standard";

  if (first === "find" && /-(exec|delete)\b/.test(segment)) return "standard";
  if (first === "git") {
    const sub = words[1] ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return "standard";
    if (
      sub === "branch" &&
      !segment.includes("--show-current") &&
      words.length > 2
    ) {
      return "standard";
    }
    return "safe";
  }
  return "safe";
}

export function classifyCommand(command: string): {
  risk: CommandRisk;
  reason: string;
} {
  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.pattern.test(command))
      return { risk: "high-risk", reason: rule.label };
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
    reason:
      highest === "safe" ? "read-only command" : "may modify the workspace",
  };
}

export function commandTouchesSensitivePath(command: string): boolean {
  const trimmed = command.replace(/["']/g, "");
  const home = userHome();
  const markers = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".kip", "credentials.enc"),
    join(home, ".kip", ".machine"),
    toPosixPath(join(home, ".ssh")),
    toPosixPath(join(home, ".aws")),
    toPosixPath(join(home, ".gnupg")),
    toPosixPath(join(home, ".kip", "credentials.enc")),
    toPosixPath(join(home, ".kip", ".machine")),
  ];
  const lower = trimmed.toLowerCase();
  if (markers.some((marker) => lower.includes(marker.toLowerCase())))
    return true;
  return /(^|[\s/\\])(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)?[\\/]\.(?:ssh|aws|gnupg)\b|(^|[\s/\\])\.kip[\\/](?:credentials\.enc|\.machine)\b/i.test(
    trimmed,
  );
}

/** Programs whose second word picks the action (`git push`, `npm install`). */
const SUBCOMMAND_PROGRAMS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "npx",
  "cargo",
  "go",
  "pip",
  "pip3",
  "uv",
  "docker",
  "kubectl",
  "make",
  "brew",
  "gh",
  "deno",
  "python",
  "python3",
  "node",
]);

/**
 * Key used by "remember for session". It names the program and, for tools with
 * subcommands, the subcommand too, so approving `git commit` never covers
 * `git push`.
 */
export function commandApprovalKey(segment: string): string {
  const words = segment.trim().match(/[^\s]+/g) ?? [];
  let index = 0;
  while (
    index < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")
  )
    index++;
  const program = (words[index] ?? "").replace(/^\(/, "");
  if (!program) return "";
  const sub = words[index + 1];
  if (SUBCOMMAND_PROGRAMS.has(program) && sub && !sub.startsWith("-"))
    return `${program} ${sub}`;
  return program;
}

export function commandApprovalKeys(command: string): string[] {
  return [
    ...new Set(
      splitShellSegments(command).map(commandApprovalKey).filter(Boolean),
    ),
  ];
}

const DEVICE_PATHS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
  "/dev/tty",
  "NUL",
  "nul",
]);

/**
 * Path-like arguments in a shell command that resolve outside the workspace.
 * The program word itself is skipped: running `/usr/bin/env` is not file access.
 */
export function commandPathsOutsideRoot(
  command: string,
  workspaceRoot: string,
): string[] {
  const outside: string[] = [];
  for (const segment of splitShellSegments(command)) {
    const words = segment.match(/[^\s]+/g) ?? [];
    for (const [index, raw] of words.entries()) {
      if (index === 0) continue;
      let word = raw
        .replace(/^[<>]+|^\d?>>?|^&>/, "")
        .replace(/^["'(]+|["')]+$/g, "");
      const eq = word.indexOf("=");
      if (word.startsWith("-") && eq > 0) word = word.slice(eq + 1);
      if (!word || word.startsWith("-") || word.includes("://")) continue;
      const isWinDrive = /^[a-zA-Z]:[\\/]/.test(word);
      const looksLikePath =
        isWinDrive ||
        word.startsWith("/") ||
        word.startsWith("~") ||
        word === ".." ||
        word.startsWith("../") ||
        word.startsWith("..\\") ||
        word.includes("/../") ||
        word.includes("\\..\\");
      if (!looksLikePath || DEVICE_PATHS.has(word)) continue;
      const expanded = word.startsWith("~") ? expandHome(word) : word;
      if (!isWithinRoot(workspaceRoot, expanded)) outside.push(word);
    }
  }
  return outside;
}

export function needsApproval(
  policy: ApprovalPolicy,
  risk: CommandRisk,
  outsideWorkspace: boolean,
  isMutation: boolean,
): boolean {
  if (policy === "yolo") return false;
  if (outsideWorkspace) return true;
  if (policy === "full-auto") return false;
  if (policy === "strict") return true;
  if (isMutation) return true;
  return risk !== "safe";
}

export function countLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
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
  const chosen = rel && !isAbsolute(rel) && !rel.startsWith("..") ? rel : path;
  return toPosixPath(chosen);
}

export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  change?: { added: number; removed: number },
): string {
  const pathValue =
    typeof args.path === "string" ? shortenPath(args.path, workspaceRoot) : "";
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
      const command =
        typeof args.command === "string" ? args.command : "command";
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
