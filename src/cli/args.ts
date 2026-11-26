/**
 * Zero-dependency argument parser and option resolvers for the Kip CLI.
 * Kept minimal so common invocations stay short and predictable.
 */
import type {
  ApprovalPolicy,
  CliTuiLayout,
  ModelOption,
  ThinkingLevel,
} from "../shared/types";

export interface ParsedCliArgs {
  command: "run" | "models" | "help" | "version";
  print: boolean;
  prompt: string | null;
  model?: string;
  thinking?: ThinkingLevel;
  policy?: ApprovalPolicy;
  layout?: CliTuiLayout;
  continueLast: boolean;
  chat: boolean;
  cwd?: string;
  quiet: boolean;
}

const POLICY_ALIASES: Record<string, ApprovalPolicy> = {
  strict: "strict",
  ask: "read-only-auto",
  "read-only-auto": "read-only-auto",
  "read-only": "read-only-auto",
  auto: "full-auto",
  "full-auto": "full-auto",
  yolo: "yolo",
};

const THINKING_ALIASES: Record<string, ThinkingLevel> = {
  off: "off",
  none: "off",
  low: "low",
  med: "medium",
  medium: "medium",
  high: "high",
};

export function parsePolicy(raw: string): ApprovalPolicy | null {
  return POLICY_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function parseThinking(raw: string): ThinkingLevel | null {
  return THINKING_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function parseLayout(raw: string): CliTuiLayout | null {
  const lower = raw.trim().toLowerCase();
  if (lower === "fullscreen" || lower === "full" || lower === "alt") {
    return "fullscreen";
  }
  if (lower === "inline" || lower === "scroll" || lower === "main") {
    return "inline";
  }
  return null;
}

export function shortPolicyLabel(policy: ApprovalPolicy): string {
  switch (policy) {
    case "strict":
      return "strict";
    case "read-only-auto":
      return "ask";
    case "full-auto":
      return "auto";
    case "yolo":
      return "yolo";
  }
}

export function shortThinkingLabel(level: ThinkingLevel): string {
  return level === "medium" ? "med" : level;
}

/**
 * Matches a user-supplied model query against configured models:
 * 1. Exact `provider/modelId` or exact `modelId`
 * 2. Case-insensitive exact display name or modelId
 * 3. Unique substring match on `provider/modelId`, `modelId`, or `displayName`
 */
export function resolveModelOption(
  models: ModelOption[],
  query: string,
): { match?: ModelOption; candidates?: ModelOption[] } {
  const trimmed = query.trim();
  if (!trimmed) return {};
  const lower = trimmed.toLowerCase();

  const exact = models.find(
    (item) =>
      `${item.provider}/${item.modelId}`.toLowerCase() === lower ||
      item.modelId.toLowerCase() === lower ||
      item.displayName.toLowerCase() === lower,
  );
  if (exact) return { match: exact };

  const prefix = models.filter(
    (item) =>
      item.modelId.toLowerCase().startsWith(lower) ||
      item.displayName.toLowerCase().startsWith(lower) ||
      `${item.provider}/${item.modelId}`.toLowerCase().startsWith(lower),
  );
  if (prefix.length === 1) return { match: prefix[0] };

  const contains = models.filter(
    (item) =>
      item.modelId.toLowerCase().includes(lower) ||
      item.displayName.toLowerCase().includes(lower) ||
      `${item.provider}/${item.modelId}`.toLowerCase().includes(lower),
  );
  if (contains.length === 1) return { match: contains[0] };
  if (contains.length > 1) return { candidates: contains };
  return {};
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    command: "run",
    print: false,
    prompt: null,
    continueLast: false,
    chat: false,
    quiet: false,
  };

  const positional: string[] = [];
  let stopFlags = false;

  const takeValue = (flag: string, index: number): [string, number] => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (stopFlags) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      stopFlags = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      result.command = "help";
      return result;
    }
    if (token === "-v" || token === "--version") {
      result.command = "version";
      return result;
    }
    if (token === "-c" || token === "--continue") {
      result.continueLast = true;
      continue;
    }
    if (token === "--chat") {
      result.chat = true;
      continue;
    }
    if (token === "-q" || token === "--quiet") {
      result.quiet = true;
      continue;
    }
    if (token === "--yolo") {
      result.policy = "yolo";
      continue;
    }
    if (token === "-f" || token === "--fullscreen") {
      result.layout = "fullscreen";
      continue;
    }
    if (token === "--inline") {
      result.layout = "inline";
      continue;
    }
    if (token === "-p" || token === "--print") {
      result.print = true;
      const peek = argv[i + 1];
      if (peek !== undefined && !peek.startsWith("-")) {
        positional.push(peek);
        i += 1;
      }
      continue;
    }
    if (token.startsWith("--print=")) {
      result.print = true;
      const val = token.slice("--print=".length);
      if (val) positional.push(val);
      continue;
    }
    if (token === "-m" || token === "--model") {
      const [val, nextIdx] = takeValue(token, i);
      result.model = val;
      i = nextIdx;
      continue;
    }
    if (token.startsWith("--model=")) {
      result.model = token.slice("--model=".length);
      continue;
    }
    if (token === "-t" || token === "--thinking") {
      const [val, nextIdx] = takeValue(token, i);
      const parsed = parseThinking(val);
      if (!parsed) {
        throw new Error(
          `Invalid thinking level "${val}". Use off, low, medium, or high.`,
        );
      }
      result.thinking = parsed;
      i = nextIdx;
      continue;
    }
    if (token.startsWith("--thinking=")) {
      const val = token.slice("--thinking=".length);
      const parsed = parseThinking(val);
      if (!parsed) {
        throw new Error(
          `Invalid thinking level "${val}". Use off, low, medium, or high.`,
        );
      }
      result.thinking = parsed;
      continue;
    }
    if (token === "--permission" || token === "--policy") {
      const [val, nextIdx] = takeValue(token, i);
      const parsed = parsePolicy(val);
      if (!parsed) {
        throw new Error(
          `Invalid permission "${val}". Use strict, ask, auto, or yolo.`,
        );
      }
      result.policy = parsed;
      i = nextIdx;
      continue;
    }
    if (token.startsWith("--permission=") || token.startsWith("--policy=")) {
      const val = token.slice(token.indexOf("=") + 1);
      const parsed = parsePolicy(val);
      if (!parsed) {
        throw new Error(
          `Invalid permission "${val}". Use strict, ask, auto, or yolo.`,
        );
      }
      result.policy = parsed;
      continue;
    }
    if (token === "-C" || token === "--cwd") {
      const [val, nextIdx] = takeValue(token, i);
      result.cwd = val;
      i = nextIdx;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      result.cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(
        `Unknown option: ${token}. Run \`kip --help\` for usage.`,
      );
    }
    positional.push(token);
  }

  if (!result.print && positional.length === 1 && positional[0] === "models") {
    result.command = "models";
    return result;
  }

  if (positional.length > 0) {
    result.prompt = positional.join(" ").trim() || null;
  }

  return result;
}

export function formatHelp(version: string): string {
  return [
    `kip ${version} — quiet terminal assistant`,
    "",
    "Usage:",
    "  kip                         Start interactive TUI in current directory",
    '  kip -p "prompt"             Ask once, print answer, and exit',
    '  git diff | kip -p "review"  Pipe context into a one-shot prompt',
    "  kip models                  List models configured in Kip",
    "",
    "Options:",
    "  -p, --print [prompt]        One-shot mode: print response to stdout and exit",
    "  -m, --model <query>         Override model (id, name, or provider/model)",
    "  -t, --thinking <level>      Reasoning level: off, low, medium, high",
    "      --permission <mode>     Permission mode: strict, ask, auto, yolo",
    "      --yolo                  Shorthand for --permission yolo",
    "  -f, --fullscreen            Open TUI in fullscreen viewport mode",
    "      --inline                Open TUI in inline scrollback mode",
    "  -c, --continue              Resume the most recent thread in this directory",
    "      --chat                  Chat-only mode (no tools or system prompt)",
    "  -C, --cwd <dir>             Run in a different directory",
    "  -q, --quiet                 Suppress status lines on stderr in print mode",
    "  -v, --version               Print version",
    "  -h, --help                  Show this help",
    "",
    "Interactive commands:",
    "  /model  /permission  /thinking  /layout  /new  /resume  /compact  /undo  /help  /exit",
  ].join("\n");
}
