/**
 * Minimalist TUI components built on `@earendil-works/pi-tui`.
 * Every component strictly respects `width` via `truncateToWidth` / `wrapTextWithAnsi`
 * so differential rendering stays crisp across terminal resizes and CJK text.
 */
import { diffLines } from "diff";
import {
  Input,
  Markdown,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type {
  ApprovalPolicy,
  ChatTurn,
  CliTuiLayout,
  ContentBlock,
  ContextUsage,
  ThinkingBlock,
  ThinkingLevel,
  ThreadMode,
  ToolApprovalPayload,
  ToolCallBlock,
} from "../../shared/types";
import {
  mergeCitations,
  parseReplyContent,
  type CitationSource,
  type ElicitationItem,
  type ElicitationsGroup,
} from "../../shared/citations";
import {
  formatThinkingDuration,
  formatToolDuration,
  formatWorkDuration,
} from "../../shared/duration";
import { shortPolicyLabel, shortThinkingLabel } from "../args";
import type { KipTuiTheme } from "./theme";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function compactHome(path: string, home: string): string {
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length) || ""}`;
  }
  return path;
}

function renderDiffSnippet(
  diff: { before: string; after: string },
  theme: KipTuiTheme,
  maxLines: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const parts = diffLines(diff.before, diff.after);
  for (const part of parts) {
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? "+ " : "- ";
    const paint = part.added ? theme.diffAdd : theme.diffDel;
    const rawLines = part.value.replace(/\r?\n$/, "").split(/\r?\n/);
    for (const raw of rawLines) {
      if (out.length >= maxLines) {
        out.push(theme.muted("  │ …"));
        return out;
      }
      const content = truncateToWidth(
        `${prefix}${raw}`,
        Math.max(10, maxWidth - 4),
      );
      out.push(`  ${theme.faint("│")} ${paint(content)}`);
    }
  }
  return out;
}

/** Quiet 2-line opening header; scrolls away naturally as the chat grows. */
export class HeaderComponent implements Component {
  constructor(
    private theme: KipTuiTheme,
    private info: {
      workspacePath: string;
      homeDir: string;
      gitBranch: string | null;
      modelLabel: string;
      thinking: ThinkingLevel;
      policy: ApprovalPolicy;
      mode: ThreadMode;
      resumedTitle?: string;
    },
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  update(patch: Partial<HeaderComponent["info"]>): void {
    this.info = { ...this.info, ...patch };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeW = Math.max(20, width);
    const dir = compactHome(this.info.workspacePath, this.info.homeDir);
    const branch = this.info.gitBranch
      ? this.theme.muted(` (${this.info.gitBranch})`)
      : "";
    const line1 = truncateToWidth(
      ` ${this.theme.accentBold("kip")} ${this.theme.faint("·")} ${this.theme.text(dir)}${branch}`,
      safeW,
    );

    const policyText =
      this.info.policy === "yolo"
        ? this.theme.err("yolo")
        : this.info.policy === "full-auto"
          ? this.theme.warn("auto")
          : this.theme.muted(shortPolicyLabel(this.info.policy));
    const modeTag =
      this.info.mode === "chat"
        ? ` ${this.theme.faint("·")} ${this.theme.brand("chat")}`
        : "";
    const resumed = this.info.resumedTitle
      ? ` ${this.theme.faint("·")} ${this.theme.muted(`resumed "${this.info.resumedTitle}"`)}`
      : "";
    const meta =
      ` ${this.theme.muted(this.info.modelLabel)}` +
      ` ${this.theme.faint("·")} ${this.theme.muted(shortThinkingLabel(this.info.thinking))}` +
      ` ${this.theme.faint("·")} ${policyText}${modeTag}${resumed}`;
    const hint = this.theme.faint("/help · ^O details");
    const line2 = composeRow(meta, hint, safeW);

    return ["", line1, line2, ""];
  }
}

/** Pinned 1-line header + hairline rule for fullscreen viewport mode. */
export class TopBarComponent implements Component {
  constructor(
    private theme: KipTuiTheme,
    private info: {
      workspacePath: string;
      homeDir: string;
      gitBranch: string | null;
      threadTitle: string;
      modelLabel: string;
      thinking: ThinkingLevel;
      policy: ApprovalPolicy;
      mode: ThreadMode;
    },
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  update(patch: Partial<TopBarComponent["info"]>): void {
    this.info = { ...this.info, ...patch };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeW = Math.max(20, width);
    const dir = compactHome(this.info.workspacePath, this.info.homeDir);
    const branch = this.info.gitBranch
      ? this.theme.muted(` (${this.info.gitBranch})`)
      : "";
    const title =
      this.info.threadTitle && this.info.threadTitle !== "New Thread"
        ? ` ${this.theme.faint("·")} ${this.theme.muted(this.info.threadTitle)}`
        : "";
    const left = ` ${this.theme.accentBold("kip")} ${this.theme.faint("·")} ${this.theme.text(dir)}${branch}${title}`;

    const rightParts: string[] = [this.theme.muted(this.info.modelLabel)];
    if (this.info.mode === "chat") {
      rightParts.push(this.theme.brand("chat"));
    } else {
      rightParts.push(this.theme.muted(shortThinkingLabel(this.info.thinking)));
      const policyLabel = shortPolicyLabel(this.info.policy);
      rightParts.push(
        this.info.policy === "yolo"
          ? this.theme.err(policyLabel)
          : this.info.policy === "full-auto"
            ? this.theme.warn(policyLabel)
            : this.theme.muted(policyLabel),
      );
    }
    const right = `${rightParts.join(` ${this.theme.faint("·")} `)} `;
    const bar = composeRow(left, right, safeW);
    const rule = this.theme.faint("─".repeat(safeW));
    return [bar, rule];
  }
}

/** Quiet empty-state greeting shown inside fullscreen mode before the first turn. */
export class WelcomeEmptyComponent implements Component {
  constructor(
    private theme: KipTuiTheme,
    private readonly workspacePath: string,
    private readonly homeDir: string,
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeW = Math.max(20, width);
    const hour = new Date().getHours();
    const greeting =
      hour < 12
        ? "Good morning."
        : hour < 18
          ? "Good afternoon."
          : "Good evening.";
    const dir = compactHome(this.workspacePath, this.homeDir);
    return [
      "",
      truncateToWidth(
        ` ${this.theme.text(greeting)} ${this.theme.muted(`Ready in ${dir}.`)}`,
        safeW,
      ),
      truncateToWidth(
        ` ${this.theme.faint("Type a message, or / for commands · /layout to switch view")}`,
        safeW,
      ),
      "",
    ];
  }
}

/** Editorial user message marked with a single subtle left bar. */
export class UserMessageComponent implements Component {
  constructor(
    private theme: KipTuiTheme,
    private readonly text: string,
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeW = Math.max(16, width);
    const bar = this.theme.accent("▎");
    const wrapped = wrapTextWithAnsi(this.text.trim(), Math.max(8, safeW - 3));
    return ["", ...wrapped.map((line) => ` ${bar} ${line}`), ""];
  }
}

/** Single-line quiet system notice in the transcript (for slash command feedback). */
export class NoticeComponent implements Component {
  constructor(
    private theme: KipTuiTheme,
    private readonly lines: string[],
    private readonly tone: "muted" | "ok" | "warn" | "err" = "muted",
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeW = Math.max(16, width);
    const paint =
      this.tone === "ok"
        ? this.theme.ok
        : this.tone === "warn"
          ? this.theme.warn
          : this.tone === "err"
            ? this.theme.err
            : this.theme.muted;
    const out: string[] = [];
    for (const line of this.lines) {
      if (!line) {
        out.push("");
        continue;
      }
      for (const wrapped of wrapTextWithAnsi(line, Math.max(8, safeW - 2))) {
        out.push(` ${paint(wrapped)}`);
      }
    }
    return out;
  }
}

/**
 * Renders one assistant turn: thinking traces, compact tool steps (expandable
 * via Ctrl+O), markdown prose, and optional error line.
 */
export class AssistantTurnComponent implements Component {
  private readonly markdownCache = new Map<string, Markdown>();
  private spinnerFrame = 0;
  private showFollowUps = false;

  constructor(
    private theme: KipTuiTheme,
    readonly turn: ChatTurn,
    private verbose: boolean,
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
    this.markdownCache.clear();
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  setShowFollowUps(show: boolean): void {
    this.showFollowUps = show;
  }

  getFollowUps(): ElicitationItem[] {
    for (let i = this.turn.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.turn.blocks[i];
      if (block?.type !== "text") continue;
      const group = parseReplyContent(block.text).elicitations;
      if (group && group.items.length > 0) return group.items;
    }
    return [];
  }

  tickSpinner(): boolean {
    const hasRunning = this.turn.blocks.some(
      (b) =>
        (b.type === "tool_call" && b.status === "running") ||
        (b.type === "thinking" && !b.isComplete),
    );
    if (!hasRunning) return false;
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    return true;
  }

  invalidate(): void {
    for (const md of this.markdownCache.values()) md.invalidate();
  }

  render(width: number): string[] {
    const safeW = Math.max(20, width);
    const out: string[] = [];
    const collectedSources: CitationSource[][] = [];
    let elicitations: ElicitationsGroup | null = null;
    let lastKind: ContentBlock["type"] | null = null;

    for (const block of this.turn.blocks) {
      if (block.type === "thinking") {
        if (lastKind === "text") out.push("");
        out.push(...this.renderThinking(block, safeW));
        lastKind = "thinking";
      } else if (block.type === "tool_call") {
        if (lastKind === "text") out.push("");
        out.push(...this.renderTool(block, safeW));
        lastKind = "tool_call";
      } else if (block.type === "text") {
        if (!block.text.trim()) continue;
        const parsed = parseReplyContent(block.text);
        if (parsed.sources.length > 0) collectedSources.push(parsed.sources);
        if (parsed.elicitations && parsed.elicitations.items.length > 0) {
          elicitations = parsed.elicitations;
        }
        if (!parsed.body.trim()) continue;
        if (lastKind !== null && lastKind !== "text") out.push("");
        let md = this.markdownCache.get(block.id);
        if (!md) {
          md = new Markdown(parsed.body, 1, 0, this.theme.markdown);
          this.markdownCache.set(block.id, md);
        } else {
          md.setText(parsed.body);
        }
        out.push(...md.render(safeW));
        lastKind = "text";
      }
    }

    const sources = mergeCitations(collectedSources);
    if (sources.length > 0) {
      if (out.length > 0) out.push("");
      out.push(...this.renderSources(sources, safeW));
    }

    if (this.showFollowUps && elicitations && elicitations.items.length > 0) {
      if (out.length > 0) out.push("");
      out.push(...this.renderFollowUps(elicitations, safeW));
    }

    if (this.turn.error) {
      if (out.length > 0) out.push("");
      const wrapped = wrapTextWithAnsi(
        this.turn.error,
        Math.max(10, safeW - 4),
      );
      wrapped.forEach((line, idx) => {
        const lead = idx === 0 ? `${this.theme.err("×")} ` : "  ";
        out.push(` ${lead}${this.theme.err(line)}`);
      });
    }

    return out;
  }

  private renderSources(sources: CitationSource[], width: number): string[] {
    const limit = this.verbose ? sources.length : Math.min(4, sources.length);
    const hidden = sources.length - limit;
    const lines = [truncateToWidth(` ${this.theme.faint("Sources")}`, width)];
    for (let i = 0; i < limit; i += 1) {
      const source = sources[i]!;
      const num = source.id ?? i + 1;
      const prefix = ` ${this.theme.faint(`[${num}]`)} `;
      const label =
        source.title && source.title !== source.url
          ? source.title
          : source.domain;
      const combined = `${prefix}${this.theme.muted(label)} ${this.theme.faint(source.url)}`;
      if (visibleWidth(combined) <= width) {
        lines.push(combined);
      } else {
        lines.push(
          truncateToWidth(`${prefix}${this.theme.muted(label)}`, width),
        );
        lines.push(
          truncateToWidth(`     ${this.theme.faint(source.url)}`, width),
        );
      }
    }
    if (hidden > 0) {
      lines.push(
        truncateToWidth(` ${this.theme.faint(`+${hidden} more  ^O`)}`, width),
      );
    }
    return lines;
  }

  private renderFollowUps(group: ElicitationsGroup, width: number): string[] {
    const lines: string[] = [];
    if (group.message) {
      lines.push(truncateToWidth(` ${this.theme.faint(group.message)}`, width));
    }
    group.items.forEach((item, index) => {
      const cmd = this.theme.faint(`/${index + 1}`);
      lines.push(
        truncateToWidth(` ${cmd}  ${this.theme.muted(item.label)}`, width),
      );
    });
    return lines;
  }

  private renderThinking(block: ThinkingBlock, width: number): string[] {
    if (block.isComplete && !block.thinking.trim()) return [];
    const duration = formatThinkingDuration(block.durationMs);
    const label = block.isComplete
      ? duration
        ? `Thought for ${duration}`
        : "Thought"
      : "Thinking…";
    const icon = block.isComplete
      ? this.theme.muted("✦")
      : this.theme.accent(SPINNER_FRAMES[this.spinnerFrame] ?? "⠋");
    const lines = [
      truncateToWidth(
        ` ${icon} ${this.theme.muted(label)}${!this.verbose && block.isComplete && block.thinking.trim() ? this.theme.faint("  ^O") : ""}`,
        width,
      ),
    ];

    if (this.verbose && block.thinking.trim()) {
      const textLines = block.thinking.trim().split(/\r?\n/).slice(0, 24);
      for (const raw of textLines) {
        const wrapped = wrapTextWithAnsi(raw, Math.max(10, width - 5));
        for (const row of wrapped) {
          lines.push(`  ${this.theme.faint("│")} ${this.theme.muted(row)}`);
        }
      }
    }
    return lines;
  }

  private renderTool(block: ToolCallBlock, width: number): string[] {
    let icon: string;
    let statusSuffix = "";
    switch (block.status) {
      case "running":
        icon = this.theme.accent(SPINNER_FRAMES[this.spinnerFrame] ?? "⠋");
        break;
      case "awaiting_approval":
        icon = this.theme.warn("?");
        statusSuffix = ` ${this.theme.warn("approval required")}`;
        break;
      case "completed":
        icon = this.theme.ok("✓");
        break;
      case "denied":
        icon = this.theme.warn("×");
        statusSuffix = ` ${this.theme.warn("denied")}`;
        break;
      case "error":
        icon = this.theme.err("×");
        statusSuffix = ` ${this.theme.err("error")}`;
        break;
    }

    const ms = formatToolDuration(block.durationMs);
    const timeText = ms ? ` ${this.theme.faint(ms)}` : "";
    const header = truncateToWidth(
      ` ${icon} ${this.theme.muted(block.summaryLabel)}${statusSuffix}${timeText}`,
      width,
    );
    const lines = [header];

    if (this.verbose) {
      if (block.diff) {
        lines.push(...renderDiffSnippet(block.diff, this.theme, 16, width));
      } else if (block.output?.trim()) {
        const outLines = block.output.trim().split(/\r?\n/);
        const shown = outLines.slice(0, 10);
        for (const raw of shown) {
          lines.push(
            `  ${this.theme.faint("│")} ${this.theme.muted(truncateToWidth(raw, Math.max(10, width - 5)))}`,
          );
        }
        if (outLines.length > shown.length) {
          lines.push(
            `  ${this.theme.faint("│")} ${this.theme.faint(`… ${outLines.length - shown.length} more lines`)}`,
          );
        }
      }
    }

    return lines;
  }
}

/** Live one-line activity bar shown above the composer while a run is active. */
export class WorkingLineComponent implements Component {
  private active = false;
  private startedAt = 0;
  private frame = 0;
  private queuedCount = 0;
  private retryNote: string | null = null;

  constructor(private theme: KipTuiTheme) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  start(): void {
    this.active = true;
    this.startedAt = Date.now();
    this.frame = 0;
  }

  stop(): void {
    this.active = false;
    this.queuedCount = 0;
    this.retryNote = null;
  }

  setQueuedCount(count: number): void {
    this.queuedCount = count;
  }

  /** Shows a pending automatic retry instead of an unexplained spinner. */
  setRetry(note: string | null): void {
    this.retryNote = note;
  }

  tick(): boolean {
    if (!this.active) return false;
    this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.active) return [];
    const elapsed = formatWorkDuration(Date.now() - this.startedAt);
    const spinner = this.theme.accent(SPINNER_FRAMES[this.frame] ?? "⠋");
    const queued =
      this.queuedCount > 0
        ? ` ${this.theme.faint("·")} ${this.theme.muted(`${this.queuedCount} queued`)}`
        : "";
    const status = this.retryNote
      ? this.retryNote
      : elapsed
        ? `Working · ${elapsed}`
        : "Working";
    const left = ` ${spinner} ${this.theme.muted(status)}${queued}`;
    const right = this.theme.faint("esc to stop ");
    return [composeRow(left, right, Math.max(20, width))];
  }
}

/**
 * Inline approval bar shown above the composer when a tool call suspends for
 * confirmation. Matches Kip's exact safety rules: high-risk and outside-workspace
 * calls disable "always in session".
 */
export class ApprovalPromptComponent implements Component {
  readonly canRemember: boolean;

  constructor(
    private theme: KipTuiTheme,
    readonly approval: ToolApprovalPayload,
    private readonly onDecision: (
      approved: boolean,
      rememberForSession: boolean,
    ) => void,
  ) {
    this.canRemember =
      approval.risk !== "high-risk" && !approval.outsideWorkspace;
  }

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "return") ||
      data === "y" ||
      data === "Y"
    ) {
      this.onDecision(true, false);
      return;
    }
    if (this.canRemember && (data === "a" || data === "A")) {
      this.onDecision(true, true);
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.onDecision(false, false);
    }
  }

  render(width: number): string[] {
    const safeW = Math.max(24, width);
    const rule = this.theme.faint("─".repeat(safeW));
    const lines: string[] = [rule];

    const badge =
      this.approval.risk === "high-risk"
        ? ` ${this.theme.errBold("HIGH RISK")}`
        : this.approval.outsideWorkspace
          ? ` ${this.theme.warn("OUTSIDE WORKSPACE")}`
          : "";
    lines.push(
      truncateToWidth(
        ` ${this.theme.warn("?")} ${this.theme.bold(this.approval.summaryLabel)}${badge}`,
        safeW,
      ),
    );

    if (this.approval.commandOrPath) {
      for (const wrapped of wrapTextWithAnsi(
        this.approval.commandOrPath,
        Math.max(12, safeW - 4),
      ).slice(0, 3)) {
        lines.push(`   ${this.theme.muted(wrapped)}`);
      }
    }

    if (this.approval.previewDiff) {
      lines.push(
        ...renderDiffSnippet(this.approval.previewDiff, this.theme, 10, safeW),
      );
    }

    const actions = [
      `${this.theme.accentBold("[y]")} ${this.theme.text("Allow")}`,
      ...(this.canRemember
        ? [`${this.theme.bold("[a]")} ${this.theme.muted("Always in session")}`]
        : []),
      `${this.theme.bold("[n]")} ${this.theme.muted("Deny")}`,
    ].join("   ");

    lines.push("");
    lines.push(truncateToWidth(` ${actions}`, safeW));
    lines.push(rule);
    return lines;
  }
}

/**
 * Quiet single-line status footer below the composer.
 * Left: workspace + branch (or transient toast feedback).
 * Right: model · thinking · permission · context %.
 */
export class StatusBarComponent implements Component {
  private toast: {
    text: string;
    tone: "muted" | "ok" | "warn" | "err";
  } | null = null;

  constructor(
    private theme: KipTuiTheme,
    private state: {
      workspaceName: string;
      gitBranch: string | null;
      modelLabel: string;
      thinking: ThinkingLevel;
      policy: ApprovalPolicy;
      mode: ThreadMode;
      usage: ContextUsage;
      layout?: CliTuiLayout;
    },
  ) {}

  setTheme(theme: KipTuiTheme): void {
    this.theme = theme;
  }

  update(patch: Partial<StatusBarComponent["state"]>): void {
    this.state = { ...this.state, ...patch };
  }

  setToast(
    text: string | null,
    tone: "muted" | "ok" | "warn" | "err" = "muted",
  ): void {
    this.toast = text ? { text, tone } : null;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeW = Math.max(20, width);
    const isFullscreen = this.state.layout === "fullscreen";
    let left: string;
    if (this.toast) {
      const paint =
        this.toast.tone === "ok"
          ? this.theme.ok
          : this.toast.tone === "warn"
            ? this.theme.warn
            : this.toast.tone === "err"
              ? this.theme.err
              : this.theme.muted;
      left = ` ${paint(this.toast.text)}`;
    } else if (isFullscreen) {
      left = ` ${this.theme.faint("/help · ^O details · ^⇧F search")}`;
    } else {
      const branch = this.state.gitBranch ? ` (${this.state.gitBranch})` : "";
      left = ` ${this.theme.muted(`${this.state.workspaceName}${branch}`)}`;
    }

    const parts: string[] = [];
    if (!isFullscreen) {
      parts.push(this.theme.muted(this.state.modelLabel));
      if (this.state.mode === "chat") {
        parts.push(this.theme.brand("chat"));
      } else {
        parts.push(this.theme.muted(shortThinkingLabel(this.state.thinking)));
        const policyLabel = shortPolicyLabel(this.state.policy);
        parts.push(
          this.state.policy === "yolo"
            ? this.theme.err(policyLabel)
            : this.state.policy === "full-auto"
              ? this.theme.warn(policyLabel)
              : this.theme.muted(policyLabel),
        );
      }
    }
    if (this.state.usage.maxTokens > 0 && this.state.usage.usedTokens > 0) {
      const pct = Math.min(100, Math.round(this.state.usage.ratio * 100));
      const pctStr = `${pct}%`;
      parts.push(
        pct >= 80 ? this.theme.warn(pctStr) : this.theme.faint(pctStr),
      );
    }
    if (isFullscreen) {
      parts.push(this.theme.faint("fullscreen"));
    }

    const sep = ` ${this.theme.faint("·")} `;
    const right = parts.length ? `${parts.join(sep)} ` : "";
    return [composeRow(left, right, safeW)];
  }
}

/**
 * Clean centered modal picker for `/model`, `/permission`, `/thinking`,
 * `/mode`, and `/resume`. Optionally includes a live search filter when
 * there are many items.
 */
export class PickerOverlayComponent implements Component, Focusable {
  readonly capturesViewportInput = true;
  private _focused = false;
  private readonly list: SelectList;
  private readonly searchInput: Input | null;
  private readonly allItems: SelectItem[];

  constructor(
    private theme: KipTuiTheme,
    private readonly options: {
      title: string;
      subtitle?: string;
      items: SelectItem[];
      initialIndex?: number;
      searchable?: boolean;
      onSelect: (item: SelectItem) => void;
      onCancel: () => void;
    },
  ) {
    this.allItems = options.items;
    this.list = new SelectList(
      options.items,
      Math.min(10, Math.max(4, options.items.length)),
      theme.selectList,
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 36 },
    );
    if (
      options.initialIndex !== undefined &&
      options.initialIndex >= 0 &&
      options.initialIndex < options.items.length
    ) {
      this.list.setSelectedIndex(options.initialIndex);
    }
    this.list.onSelect = options.onSelect;
    this.list.onCancel = options.onCancel;

    if (options.searchable) {
      this.searchInput = new Input();
      this.searchInput.onEscape = options.onCancel;
      this.searchInput.onSubmit = () => {
        const picked = this.list.getSelectedItem();
        if (picked) options.onSelect(picked);
        else options.onCancel();
      };
    } else {
      this.searchInput = null;
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.searchInput) this.searchInput.focused = value;
  }

  invalidate(): void {
    this.list.invalidate();
    this.searchInput?.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.options.onCancel();
      return;
    }
    if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "return")
    ) {
      this.list.handleInput(data);
      return;
    }
    if (this.searchInput) {
      this.searchInput.handleInput(data);
      const query = this.searchInput.getValue().trim().toLowerCase();
      this.applyFilter(query);
      return;
    }
    this.list.handleInput(data);
  }

  private applyFilter(query: string): void {
    if (!query) {
      this.list.setFilter("");
      return;
    }
    // SelectList.setFilter filters by prefix on label/value; match substring too
    // by passing raw query when prefix matches, or filtering on description/value.
    this.list.setFilter(query);
    if (!this.list.getSelectedItem()) {
      const fallback = this.allItems.find(
        (item) =>
          item.label.toLowerCase().includes(query) ||
          item.value.toLowerCase().includes(query) ||
          (item.description?.toLowerCase().includes(query) ?? false),
      );
      if (fallback) {
        this.list.setFilter("");
        const idx = this.allItems.indexOf(fallback);
        if (idx >= 0) this.list.setSelectedIndex(idx);
      }
    }
  }

  render(width: number): string[] {
    const safeW = Math.max(28, width);
    const innerW = Math.max(20, safeW - 4);
    const top = this.theme.faint(`╭${"─".repeat(safeW - 2)}╮`);
    const bottom = this.theme.faint(`╰${"─".repeat(safeW - 2)}╯`);
    const sep = this.theme.faint(`├${"─".repeat(safeW - 2)}┤`);
    const frame = (content: string) => {
      const clipped = truncateToWidth(content, innerW);
      const pad = Math.max(0, innerW - visibleWidth(clipped));
      return `${this.theme.faint("│")} ${clipped}${" ".repeat(pad)} ${this.theme.faint("│")}`;
    };

    const lines: string[] = [top];
    const titleLine = this.options.subtitle
      ? `${this.theme.bold(this.options.title)}  ${this.theme.muted(this.options.subtitle)}`
      : this.theme.bold(this.options.title);
    lines.push(frame(titleLine));

    if (this.searchInput) {
      const renderedInput = this.searchInput.render(Math.max(12, innerW - 2));
      const queryLine = renderedInput[0] ?? "";
      const placeholder = !this.searchInput.getValue()
        ? this.theme.faint("type to filter…")
        : "";
      lines.push(frame(`${this.theme.accent("›")} ${queryLine}${placeholder}`));
    }

    lines.push(sep);

    const listLines = this.list.render(innerW);
    for (const row of listLines) {
      lines.push(frame(row));
    }

    lines.push(sep);
    lines.push(frame(this.theme.faint("↑↓ navigate · ↵ select · esc cancel")));
    lines.push(bottom);
    return lines;
  }
}

/** Composes left and right strings onto a single line within `width`. */
function composeRow(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  if (rightW >= width - 2) {
    return truncateToWidth(right, width);
  }
  const availLeft = Math.max(1, width - rightW - 1);
  const clippedLeft = truncateToWidth(left, availLeft);
  const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightW);
  return `${clippedLeft}${" ".repeat(gap)}${right}`;
}
