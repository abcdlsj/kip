/**
 * Interactive Kip TUI built on `@earendil-works/pi-tui`.
 * Supports two layouts:
 * - `inline` (`TuiMainScreen`): renders into native terminal scrollback.
 * - `fullscreen` (`TuiAltScreen`): fixed top bar, scrollable transcript with
 *   mouse/trackpad scrolling and search, and a pinned bottom composer dock.
 * Users can switch live via `/layout`, `/fullscreen`, `/inline`, CLI flags,
 * or Desktop Settings -> CLI.
 */
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  type SlashCommand,
  type TUI,
  type TerminalColorScheme,
} from "@earendil-works/pi-tui";
import { displayModelName } from "../../bun/agent/model-registry";
import { inspectGit } from "../../bun/system/git-inspector";
import { userHome } from "../../bun/system/platform";
import type {
  AgentStreamEvent,
  ApprovalPolicy,
  ChatTurn,
  CliTuiLayout,
  ContextUsage,
  ThinkingLevel,
  ThreadMode,
  ToolApprovalPayload,
} from "../../shared/types";
import {
  parseLayout,
  parsePolicy,
  parseThinking,
  resolveModelOption,
  shortPolicyLabel,
} from "../args";
import type { CliRuntime } from "../runtime";
import {
  ApprovalPromptComponent,
  AssistantTurnComponent,
  HeaderComponent,
  NoticeComponent,
  PickerOverlayComponent,
  StatusBarComponent,
  TopBarComponent,
  UserMessageComponent,
  WelcomeEmptyComponent,
  WorkingLineComponent,
} from "./components";
import {
  createKipTheme,
  detectSchemeFromColors,
  type KipTuiTheme,
} from "./theme";

const POLICY_ITEMS: Array<{
  value: ApprovalPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "strict",
    label: "Strict",
    description: "Ask before every read, edit, and command",
  },
  {
    value: "read-only-auto",
    label: "Ask (read-only auto)",
    description: "Auto-run safe reads; ask for edits and commands",
  },
  {
    value: "full-auto",
    label: "Auto (full-auto)",
    description: "Auto-run inside workspace; ask outside workspace",
  },
  {
    value: "yolo",
    label: "YOLO",
    description: "Never ask — run everything automatically",
  },
];

const THINKING_ITEMS: Array<{
  value: ThinkingLevel;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "Off",
    description: "Direct answers without reasoning trace",
  },
  {
    value: "low",
    label: "Low",
    description: "Light reasoning for quick tasks",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced reasoning (default)",
  },
  {
    value: "high",
    label: "High",
    description: "Deep reasoning for complex work",
  },
];

const LAYOUT_ITEMS: Array<{
  value: CliTuiLayout;
  label: string;
  description: string;
}> = [
  {
    value: "inline",
    label: "Inline",
    description: "Streams in native terminal scrollback",
  },
  {
    value: "fullscreen",
    label: "Fullscreen",
    description: "Fixed header, scrollable transcript, pinned composer",
  },
];

export interface RunTuiOptions {
  initialPrompt?: string | null;
  resumed?: boolean;
  layout?: CliTuiLayout;
}

type SessionOutcome =
  | { kind: "exit"; code: number }
  | {
      kind: "switch_layout";
      layout: CliTuiLayout;
      verbose: boolean;
      scheme: TerminalColorScheme;
      toast: string;
    };

export async function runTui(
  runtime: CliRuntime,
  options: RunTuiOptions = {},
): Promise<number> {
  let layout: CliTuiLayout = options.layout ?? runtime.getTuiLayout();
  let initialPrompt = options.initialPrompt ?? null;
  let loadHistory = Boolean(options.resumed);
  let verbose = false;
  let scheme: TerminalColorScheme = "dark";
  let initialToast: string | null = null;

  for (;;) {
    const outcome = await runTuiSession(runtime, {
      layout,
      initialPrompt,
      loadHistory,
      resumed: Boolean(options.resumed),
      verbose,
      scheme,
      initialToast,
    });
    if (outcome.kind === "exit") {
      return outcome.code;
    }
    // Live layout switch: carry over the exact thread, turns, theme, and verbosity.
    layout = outcome.layout;
    verbose = outcome.verbose;
    scheme = outcome.scheme;
    initialPrompt = null;
    loadHistory = true;
    initialToast = outcome.toast;
  }
}

async function runTuiSession(
  runtime: CliRuntime,
  opts: {
    layout: CliTuiLayout;
    initialPrompt: string | null;
    loadHistory: boolean;
    resumed: boolean;
    verbose: boolean;
    scheme: TerminalColorScheme;
    initialToast: string | null;
  },
): Promise<SessionOutcome> {
  const isFullscreen = opts.layout === "fullscreen";
  const terminal = new ProcessTerminal();
  let theme: KipTuiTheme = createKipTheme(opts.scheme);

  const tui: TUI = isFullscreen
    ? new TuiAltScreen(terminal, true, undefined, {
        mouse: true,
        wheelScrollLines: "auto",
        copyOnSelect: true,
        scrollToEndIndicator: () => theme.muted(" ↓ Jump to latest "),
      })
    : new TuiMainScreen(terminal, true);
  const altScreen = isFullscreen ? (tui as TuiAltScreen) : null;

  let verbose = opts.verbose;
  let running = false;
  let lastCtrlCAt = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let activeOverlay: OverlayHandle | null = null;
  let finishSession: ((outcome: SessionOutcome) => void) | null = null;

  const git = await inspectGit(runtime.workspace.rootPath);
  const currentModelLabel = () => {
    const model = runtime.currentModel;
    if (model) return model.displayName;
    if (runtime.thread.modelId) return displayModelName(runtime.thread.modelId);
    return "No model";
  };

  const transcript = new Container();
  const turnComponents: AssistantTurnComponent[] = [];
  const themedNodes: Array<{ setTheme(t: KipTuiTheme): void }> = [];
  let activeTurnComponent: AssistantTurnComponent | null = null;
  let currentUsage: ContextUsage = { usedTokens: 0, maxTokens: 0, ratio: 0 };

  let header: HeaderComponent | null = null;
  let topBar: TopBarComponent | null = null;
  let welcome: WelcomeEmptyComponent | null = null;
  let scrollView: ScrollView | null = null;

  if (isFullscreen) {
    topBar = new TopBarComponent(theme, {
      workspacePath: runtime.workspace.rootPath,
      homeDir: userHome(),
      gitBranch: git.branch,
      threadTitle: runtime.thread.title,
      modelLabel: currentModelLabel(),
      thinking: runtime.thread.thinkingLevel,
      policy: runtime.effectivePolicy,
      mode: runtime.thread.mode,
    });
    welcome = new WelcomeEmptyComponent(
      theme,
      runtime.workspace.rootPath,
      userHome(),
    );
    transcript.addChild(welcome);
    themedNodes.push(welcome);
  } else {
    header = new HeaderComponent(theme, {
      workspacePath: runtime.workspace.rootPath,
      homeDir: userHome(),
      gitBranch: git.branch,
      modelLabel: currentModelLabel(),
      thinking: runtime.thread.thinkingLevel,
      policy: runtime.effectivePolicy,
      mode: runtime.thread.mode,
      resumedTitle:
        opts.resumed && runtime.thread.title !== "New Thread"
          ? runtime.thread.title
          : undefined,
    });
    transcript.addChild(header);
    themedNodes.push(header);
  }

  const workingLine = new WorkingLineComponent(theme);
  const approvalSlot = new Container();
  const editor = new Editor(tui, theme.editor, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  const statusBar = new StatusBarComponent(theme, {
    workspaceName: runtime.workspace.name,
    gitBranch: git.branch,
    modelLabel: currentModelLabel(),
    thinking: runtime.thread.thinkingLevel,
    policy: runtime.effectivePolicy,
    mode: runtime.thread.mode,
    usage: currentUsage,
    layout: opts.layout,
  });

  if (isViewportTUI(tui) && topBar) {
    scrollView = new ScrollView(transcript, {
      follow: "end",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
      scrollbarTrackStyle: (s) => theme.faint(s),
      scrollbarThumbStyle: (s) => theme.muted(s),
    });
    const bottomDock = new VStack([
      workingLine,
      approvalSlot,
      editor,
      statusBar,
    ]);
    tui.setLayoutRoot(
      new VStack([
        { component: topBar, basis: "auto", shrink: 0 },
        { component: scrollView, basis: 0, grow: 1, minSize: 1 },
        { component: bottomDock, basis: "auto", shrink: 1, minSize: 1 },
      ]),
    );
  } else {
    tui.addChild(transcript);
    tui.addChild(workingLine);
    tui.addChild(approvalSlot);
    tui.addChild(editor);
    tui.addChild(statusBar);
  }

  const dismissWelcome = () => {
    if (!welcome) return;
    transcript.removeChild(welcome);
    welcome = null;
  };

  const applyTheme = (next: KipTuiTheme) => {
    theme = next;
    topBar?.setTheme(next);
    for (const node of themedNodes) node.setTheme(next);
    workingLine.setTheme(next);
    statusBar.setTheme(next);
    editor.borderColor = next.editor.borderColor;
    tui.invalidate();
    tui.requestRender(true);
  };

  const showToast = (
    text: string,
    tone: "muted" | "ok" | "warn" | "err" = "muted",
    ms = 2600,
  ) => {
    if (toastTimer) clearTimeout(toastTimer);
    statusBar.setToast(text, tone);
    tui.requestRender();
    toastTimer = setTimeout(() => {
      toastTimer = null;
      statusBar.setToast(null);
      tui.requestRender();
    }, ms);
  };

  const syncChrome = () => {
    const label = currentModelLabel();
    header?.update({
      modelLabel: label,
      thinking: runtime.thread.thinkingLevel,
      policy: runtime.effectivePolicy,
      mode: runtime.thread.mode,
    });
    topBar?.update({
      threadTitle: runtime.thread.title,
      modelLabel: label,
      thinking: runtime.thread.thinkingLevel,
      policy: runtime.effectivePolicy,
      mode: runtime.thread.mode,
    });
    statusBar.update({
      modelLabel: label,
      thinking: runtime.thread.thinkingLevel,
      policy: runtime.effectivePolicy,
      mode: runtime.thread.mode,
      usage: currentUsage,
    });
    tui.requestRender();
  };

  const addNotice = (
    lines: string | string[],
    tone: "muted" | "ok" | "warn" | "err" = "muted",
  ) => {
    dismissWelcome();
    const node = new NoticeComponent(
      theme,
      Array.isArray(lines) ? lines : [lines],
      tone,
    );
    transcript.addChild(node);
    themedNodes.push(node);
    tui.requestRender();
  };

  const addUserTurn = (text: string) => {
    dismissWelcome();
    const node = new UserMessageComponent(theme, text);
    transcript.addChild(node);
    themedNodes.push(node);
    scrollView?.scrollToEnd();
    tui.requestRender();
  };

  const syncFollowUps = () => {
    const last = turnComponents[turnComponents.length - 1];
    for (const comp of turnComponents) {
      comp.setShowFollowUps(!running && comp === last);
    }
  };

  const addAssistantTurn = (turn: ChatTurn): AssistantTurnComponent => {
    dismissWelcome();
    for (const comp of turnComponents) comp.setShowFollowUps(false);
    const comp = new AssistantTurnComponent(theme, turn, verbose);
    comp.setShowFollowUps(!running);
    transcript.addChild(comp);
    themedNodes.push(comp);
    turnComponents.push(comp);
    tui.requestRender();
    return comp;
  };

  const loadCurrentThreadHistory = async () => {
    const { turns, usage } = await runtime.orchestrator.loadTurns(
      runtime.thread.id,
    );
    currentUsage = usage;
    for (const turn of turns) {
      if (turn.role === "user") {
        const text = turn.blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) addUserTurn(text);
      } else {
        addAssistantTurn(turn);
      }
    }
    scrollView?.scrollToEnd();
    syncChrome();
  };

  const resetTranscriptView = (resumedTitle?: string) => {
    altScreen?.resetTextSelection();
    transcript.clear();
    turnComponents.length = 0;
    themedNodes.length = 0;
    activeTurnComponent = null;
    if (isFullscreen) {
      welcome = new WelcomeEmptyComponent(
        theme,
        runtime.workspace.rootPath,
        userHome(),
      );
      transcript.addChild(welcome);
      themedNodes.push(welcome);
    } else if (header) {
      header.update({
        modelLabel: currentModelLabel(),
        thinking: runtime.thread.thinkingLevel,
        policy: runtime.effectivePolicy,
        mode: runtime.thread.mode,
        resumedTitle,
      });
      transcript.addChild(header);
      themedNodes.push(header);
    }
    scrollView?.scrollToEnd();
    syncChrome();
    tui.requestRender(true);
  };

  // --- Inline Approval Queue ---
  const approvalQueue: ToolApprovalPayload[] = [];
  let currentApproval: ApprovalPromptComponent | null = null;

  const showNextApproval = () => {
    approvalSlot.clear();
    currentApproval = null;
    const next = approvalQueue.shift();
    if (!next) {
      if (!activeOverlay) tui.setFocus(editor);
      tui.requestRender();
      return;
    }
    const prompt = new ApprovalPromptComponent(
      theme,
      next,
      (approved, remember) => {
        runtime.orchestrator.resolveApproval(
          runtime.thread.id,
          next.toolCallId,
          approved,
          remember,
        );
        showNextApproval();
      },
    );
    currentApproval = prompt;
    approvalSlot.addChild(prompt);
    tui.setFocus(prompt);
    tui.requestRender();
  };

  // --- Overlay Pickers ---
  const closeOverlay = () => {
    if (activeOverlay) {
      activeOverlay.hide();
      activeOverlay = null;
    }
    tui.setFocus(currentApproval ?? editor);
    tui.requestRender();
  };

  const openPicker = (pickerOpts: {
    title: string;
    subtitle?: string;
    items: SelectItem[];
    initialIndex?: number;
    searchable?: boolean;
    onSelect: (item: SelectItem) => void;
  }) => {
    closeOverlay();
    const picker = new PickerOverlayComponent(theme, {
      ...pickerOpts,
      onSelect: (item) => {
        closeOverlay();
        pickerOpts.onSelect(item);
      },
      onCancel: () => closeOverlay(),
    });
    activeOverlay = tui.showOverlay(picker, {
      anchor: "center",
      width: "72%",
      minWidth: 44,
      maxHeight: "65%",
      margin: 2,
    });
    tui.requestRender();
  };

  const switchLayout = (target: CliTuiLayout) => {
    if (running) {
      showToast(
        "Wait for the current run to finish before switching layout",
        "warn",
      );
      return;
    }
    runtime.setTuiLayout(target);
    if (target === opts.layout) {
      showToast(`Already in ${target} layout`, "muted");
      return;
    }
    finishSession?.({
      kind: "switch_layout",
      layout: target,
      verbose,
      scheme: theme.scheme,
      toast: `Layout → ${target}`,
    });
  };

  const openModelPicker = async () => {
    await runtime.registry.syncWithDatabase();
    const models = runtime.availableModels;
    if (models.length === 0) {
      addNotice(
        "No models configured. Open Kip Desktop → Settings → Providers to add one.",
        "warn",
      );
      return;
    }
    const currentKey = `${runtime.thread.modelProvider}/${runtime.thread.modelId}`;
    const items: SelectItem[] = models.map((m) => {
      const key = `${m.provider}/${m.modelId}`;
      const ctx = m.contextWindow
        ? `${Math.round(m.contextWindow / 1000)}k`
        : "";
      const active = key === currentKey ? " · active" : "";
      return {
        value: key,
        label: m.displayName,
        description: `${m.provider}${ctx ? ` · ${ctx}` : ""}${active}`,
      };
    });
    const initialIndex = Math.max(
      0,
      items.findIndex((item) => item.value === currentKey),
    );
    openPicker({
      title: "Model",
      subtitle: `${models.length} available`,
      items,
      initialIndex,
      searchable: models.length > 6,
      onSelect: (item) => {
        const slash = item.value.indexOf("/");
        const provider = item.value.slice(0, slash);
        const modelId = item.value.slice(slash + 1);
        void runtime.setModel(provider, modelId).then(() => {
          syncChrome();
          showToast(`Model → ${item.label}`, "ok");
        });
      },
    });
  };

  const openPermissionPicker = () => {
    const current = runtime.effectivePolicy;
    const items: SelectItem[] = POLICY_ITEMS.map((item) => ({
      value: item.value,
      label: item.label,
      description:
        item.value === current
          ? `${item.description} (active)`
          : item.description,
    }));
    const initialIndex = Math.max(
      0,
      items.findIndex((item) => item.value === current),
    );
    openPicker({
      title: "Permission",
      subtitle: "applies to this session",
      items,
      initialIndex,
      onSelect: (item) => {
        const policy = item.value as ApprovalPolicy;
        runtime.setPolicy(policy);
        syncChrome();
        showToast(
          `Permission → ${shortPolicyLabel(policy)}`,
          policy === "yolo" ? "warn" : "ok",
        );
      },
    });
  };

  const openThinkingPicker = () => {
    const current = runtime.thread.thinkingLevel;
    const items: SelectItem[] = THINKING_ITEMS.map((item) => ({
      value: item.value,
      label: item.label,
      description:
        item.value === current
          ? `${item.description} (active)`
          : item.description,
    }));
    const initialIndex = Math.max(
      0,
      items.findIndex((item) => item.value === current),
    );
    openPicker({
      title: "Reasoning",
      items,
      initialIndex,
      onSelect: (item) => {
        const level = item.value as ThinkingLevel;
        runtime.setThinking(level);
        syncChrome();
        showToast(`Reasoning → ${level}`, "ok");
      },
    });
  };

  const openLayoutPicker = () => {
    const items: SelectItem[] = LAYOUT_ITEMS.map((item) => ({
      value: item.value,
      label: item.label,
      description:
        item.value === opts.layout
          ? `${item.description} (active)`
          : item.description,
    }));
    const initialIndex = Math.max(
      0,
      items.findIndex((item) => item.value === opts.layout),
    );
    openPicker({
      title: "TUI layout",
      subtitle: "saved as default",
      items,
      initialIndex,
      onSelect: (item) => {
        switchLayout(item.value as CliTuiLayout);
      },
    });
  };

  const openResumePicker = () => {
    const threads = runtime.listWorkspaceThreads();
    if (threads.length === 0) {
      showToast("No saved threads in this workspace", "muted");
      return;
    }
    const items: SelectItem[] = threads.slice(0, 20).map((t) => ({
      value: t.id,
      label: t.title || "New Thread",
      description: `${formatRelative(t.updatedAt)}${t.id === runtime.thread.id ? " · current" : ""}`,
    }));
    const initialIndex = Math.max(
      0,
      items.findIndex((item) => item.value === runtime.thread.id),
    );
    openPicker({
      title: "Resume thread",
      subtitle: runtime.workspace.name,
      items,
      initialIndex,
      searchable: threads.length > 6,
      onSelect: (item) => {
        if (item.value === runtime.thread.id) return;
        const switched = runtime.switchThread(item.value);
        resetTranscriptView(
          switched.title !== "New Thread" ? switched.title : undefined,
        );
        void loadCurrentThreadHistory().then(() => {
          showToast(`Resumed "${switched.title}"`, "ok");
        });
      },
    });
  };

  // --- Slash Commands ---
  const slashCommands: SlashCommand[] = [
    {
      name: "model",
      description: "Switch model (picker or /model <query>)",
      getArgumentCompletions: (prefix) => {
        const lower = prefix.toLowerCase();
        return runtime.availableModels
          .filter(
            (m) =>
              !lower ||
              m.modelId.toLowerCase().includes(lower) ||
              m.displayName.toLowerCase().includes(lower),
          )
          .slice(0, 12)
          .map((m) => ({
            value: `${m.provider}/${m.modelId}`,
            label: m.displayName,
            description: m.provider,
          }));
      },
    },
    {
      name: "permission",
      description: "Switch approval policy (strict, ask, auto, yolo)",
      getArgumentCompletions: (prefix) => {
        const lower = prefix.toLowerCase();
        return POLICY_ITEMS.filter(
          (p) =>
            !lower ||
            p.value.includes(lower) ||
            shortPolicyLabel(p.value).includes(lower),
        ).map((p) => ({
          value: shortPolicyLabel(p.value),
          label: p.label,
          description: p.description,
        }));
      },
    },
    {
      name: "thinking",
      description: "Set reasoning level (off, low, medium, high)",
      getArgumentCompletions: (prefix) => {
        const lower = prefix.toLowerCase();
        return THINKING_ITEMS.filter(
          (t) => !lower || t.value.startsWith(lower),
        ).map((t) => ({
          value: t.value,
          label: t.label,
          description: t.description,
        }));
      },
    },
    {
      name: "layout",
      description: "Switch TUI layout (inline or fullscreen)",
      getArgumentCompletions: (prefix) => {
        const lower = prefix.toLowerCase();
        return LAYOUT_ITEMS.filter(
          (item) => !lower || item.value.startsWith(lower),
        ).map((item) => ({
          value: item.value,
          label: item.label,
          description: item.description,
        }));
      },
    },
    { name: "fullscreen", description: "Switch to fullscreen viewport TUI" },
    { name: "inline", description: "Switch to inline scrollback TUI" },
    {
      name: "mode",
      description: "Switch between agent and chat mode (on a fresh thread)",
      getArgumentCompletions: () => [
        {
          value: "agent",
          label: "agent",
          description: "Tools and workspace context",
        },
        {
          value: "chat",
          label: "chat",
          description: "Conversation only, no tools",
        },
      ],
    },
    { name: "new", description: "Start a new thread" },
    { name: "resume", description: "Resume a previous thread in this folder" },
    { name: "compact", description: "Summarize earlier context to free space" },
    { name: "undo", description: "Undo file changes from the last run" },
    { name: "strict", description: "Permission → strict (ask everything)" },
    { name: "ask", description: "Permission → ask (read-only auto)" },
    { name: "auto", description: "Permission → auto (full-auto in workspace)" },
    { name: "yolo", description: "Permission → yolo (never ask)" },
    { name: "clear", description: "Redraw screen cleanly" },
    { name: "help", description: "Show commands and shortcuts" },
    { name: "exit", description: "Quit Kip CLI" },
  ];

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands, runtime.workspace.rootPath),
  );

  const requestExit = (code = 0) => {
    finishSession?.({ kind: "exit", code });
  };

  const handleSlashCommand = async (raw: string): Promise<boolean> => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return false;
    const spaceIdx = trimmed.indexOf(" ");
    const cmd = (
      spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
    ).toLowerCase();
    const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "exit":
      case "quit":
      case "q":
        requestExit(0);
        return true;

      case "help":
      case "?":
        addNotice([
          "Commands:",
          "  /model [query]       Switch model",
          "  /permission [mode]   strict · ask · auto · yolo  (or /strict /ask /auto /yolo)",
          "  /thinking [level]    off · low · medium · high",
          "  /layout [style]      inline · fullscreen  (or /fullscreen /inline)",
          "  /mode [agent|chat]   Switch mode on a fresh thread",
          "  /new  /resume        Start or resume a thread",
          "  /compact  /undo      Compact context or undo last run's edits",
          "  /clear  /exit        Redraw or quit",
          "",
          isFullscreen
            ? "Shortcuts: Enter send · Shift+Enter newline · Esc stop · ^O details · ^⇧F search · ^C quit"
            : "Shortcuts: Enter send · Shift+Enter newline · Esc stop · ^O details · ^C clear/quit",
        ]);
        return true;

      case "layout": {
        if (!arg) {
          openLayoutPicker();
          return true;
        }
        const parsed = parseLayout(arg);
        if (!parsed) {
          showToast("Use inline or fullscreen", "warn");
          return true;
        }
        switchLayout(parsed);
        return true;
      }

      case "fullscreen":
        switchLayout("fullscreen");
        return true;

      case "inline":
        switchLayout("inline");
        return true;

      case "model":
      case "m": {
        if (!arg) {
          await openModelPicker();
          return true;
        }
        await runtime.registry.syncWithDatabase();
        const resolved = resolveModelOption(runtime.availableModels, arg);
        if (resolved.match) {
          await runtime.setModel(
            resolved.match.provider,
            resolved.match.modelId,
          );
          syncChrome();
          showToast(`Model → ${resolved.match.displayName}`, "ok");
        } else if (resolved.candidates && resolved.candidates.length > 1) {
          openPicker({
            title: `Model matching "${arg}"`,
            items: resolved.candidates.map((m) => ({
              value: `${m.provider}/${m.modelId}`,
              label: m.displayName,
              description: m.provider,
            })),
            onSelect: (item) => {
              const slash = item.value.indexOf("/");
              void runtime
                .setModel(
                  item.value.slice(0, slash),
                  item.value.slice(slash + 1),
                )
                .then(() => {
                  syncChrome();
                  showToast(`Model → ${item.label}`, "ok");
                });
            },
          });
        } else {
          showToast(`No model matching "${arg}"`, "warn");
        }
        return true;
      }

      case "permission":
      case "policy":
      case "perm": {
        if (!arg) {
          openPermissionPicker();
          return true;
        }
        const parsed = parsePolicy(arg);
        if (!parsed) {
          showToast("Use strict, ask, auto, or yolo", "warn");
          return true;
        }
        runtime.setPolicy(parsed);
        syncChrome();
        showToast(
          `Permission → ${shortPolicyLabel(parsed)}`,
          parsed === "yolo" ? "warn" : "ok",
        );
        return true;
      }

      case "strict":
      case "ask":
      case "read-only-auto":
      case "auto":
      case "full-auto":
      case "yolo": {
        const parsed = parsePolicy(cmd);
        if (parsed) {
          runtime.setPolicy(parsed);
          syncChrome();
          showToast(
            `Permission → ${shortPolicyLabel(parsed)}`,
            parsed === "yolo" ? "warn" : "ok",
          );
        }
        return true;
      }

      case "thinking":
      case "think":
      case "t": {
        if (!arg) {
          openThinkingPicker();
          return true;
        }
        const parsed = parseThinking(arg);
        if (!parsed) {
          showToast("Use off, low, medium, or high", "warn");
          return true;
        }
        runtime.setThinking(parsed);
        syncChrome();
        showToast(`Reasoning → ${parsed}`, "ok");
        return true;
      }

      case "mode": {
        if (running) {
          showToast("Stop the current run before switching mode", "warn");
          return true;
        }
        const target: ThreadMode =
          arg === "chat"
            ? "chat"
            : arg === "agent"
              ? "agent"
              : runtime.thread.mode === "agent"
                ? "chat"
                : "agent";
        try {
          await runtime.setMode(target);
          syncChrome();
          showToast(`Mode → ${target}`, "ok");
        } catch (error) {
          showToast(
            error instanceof Error ? error.message : "Unable to switch mode",
            "warn",
          );
        }
        return true;
      }

      case "new": {
        if (running) {
          await runtime.orchestrator.abort(runtime.thread.id);
          running = false;
          workingLine.stop();
        }
        runtime.createNewThread();
        currentUsage = { usedTokens: 0, maxTokens: 0, ratio: 0 };
        resetTranscriptView();
        showToast("Started a new thread", "ok");
        return true;
      }

      case "resume":
      case "threads": {
        if (running) {
          showToast("Stop the current run before switching threads", "warn");
          return true;
        }
        openResumePicker();
        return true;
      }

      case "compact": {
        if (running) {
          showToast("Wait for the current run to finish", "warn");
          return true;
        }
        showToast("Compacting context…", "muted", 10_000);
        try {
          currentUsage = await runtime.orchestrator.compact(runtime.thread.id);
          syncChrome();
          showToast("Context compacted", "ok");
        } catch (error) {
          showToast(
            error instanceof Error ? error.message : "Compaction failed",
            "err",
          );
        }
        return true;
      }

      case "undo": {
        if (running) {
          showToast("Wait for the current run to finish", "warn");
          return true;
        }
        const latest = runtime.orchestrator.latestChanges(runtime.thread.id);
        if (!latest) {
          showToast("Nothing to undo in this thread", "muted");
          return true;
        }
        const outcome = await runtime.orchestrator.undoChanges(
          runtime.thread.id,
          latest.id,
        );
        if (outcome.ok) {
          const names = latest.files.map((f) => f.path).join(", ");
          addNotice(`Undid changes to ${names}`, "ok");
        } else {
          showToast(outcome.error ?? "Unable to undo", "warn");
        }
        return true;
      }

      case "clear":
        tui.requestRender(true);
        return true;

      default:
        showToast(`Unknown command /${cmd} — type /help`, "warn");
        return true;
    }
  };

  // --- Stream Handling ---
  const onStreamEvent = (threadId: string, event: AgentStreamEvent) => {
    if (threadId !== runtime.thread.id) return;
    switch (event.kind) {
      case "user_turn": {
        const text = event.turn.blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) addUserTurn(text);
        activeTurnComponent = null;
        return;
      }
      case "turn_start": {
        activeTurnComponent = addAssistantTurn(event.turn);
        return;
      }
      case "text_delta": {
        const turn = activeTurnComponent?.turn;
        if (!turn) return;
        let block = turn.blocks.find(
          (b) => b.type === "text" && b.id === event.blockId,
        );
        if (!block) {
          block = { type: "text", id: event.blockId, text: "" };
          turn.blocks.push(block);
        }
        if (block.type === "text") block.text += event.delta;
        tui.requestRender();
        return;
      }
      case "thinking_delta": {
        const turn = activeTurnComponent?.turn;
        if (!turn) return;
        let block = turn.blocks.find(
          (b) => b.type === "thinking" && b.id === event.blockId,
        );
        if (!block) {
          block = {
            type: "thinking",
            id: event.blockId,
            thinking: "",
            isComplete: false,
          };
          turn.blocks.push(block);
        }
        if (block.type === "thinking") block.thinking += event.delta;
        tui.requestRender();
        return;
      }
      case "thinking_done": {
        const turn = activeTurnComponent?.turn;
        if (!turn) return;
        const block = turn.blocks.find(
          (b) => b.type === "thinking" && b.id === event.blockId,
        );
        if (block?.type === "thinking") {
          block.isComplete = true;
          block.durationMs =
            event.durationMs > 0 ? event.durationMs : undefined;
        }
        tui.requestRender();
        return;
      }
      case "tool_start": {
        const turn = activeTurnComponent?.turn;
        if (!turn) return;
        turn.blocks.push(event.block);
        tui.requestRender();
        return;
      }
      case "tool_approval_required": {
        const turn = activeTurnComponent?.turn;
        const block = turn?.blocks.find(
          (b) => b.type === "tool_call" && b.id === event.approval.toolCallId,
        );
        if (block?.type === "tool_call") block.status = "awaiting_approval";
        approvalQueue.push(event.approval);
        if (!currentApproval) showNextApproval();
        tui.requestRender();
        return;
      }
      case "tool_approved": {
        const turn = activeTurnComponent?.turn;
        const block = turn?.blocks.find(
          (b) => b.type === "tool_call" && b.id === event.toolCallId,
        );
        if (
          block?.type === "tool_call" &&
          block.status === "awaiting_approval"
        ) {
          block.status = event.approved === false ? "denied" : "running";
        }
        if (currentApproval?.approval.toolCallId === event.toolCallId) {
          showNextApproval();
        }
        tui.requestRender();
        return;
      }
      case "tool_end": {
        const turn = activeTurnComponent?.turn;
        const block = turn?.blocks.find(
          (b) => b.type === "tool_call" && b.id === event.toolCallId,
        );
        if (block?.type === "tool_call") {
          block.status = event.status;
          block.durationMs =
            event.durationMs > 0 ? event.durationMs : undefined;
          block.summaryLabel = event.summaryLabel;
          block.output = event.output;
          block.diff = event.diff;
        }
        tui.requestRender();
        return;
      }
      case "queue_update": {
        workingLine.setQueuedCount(event.queued.length);
        tui.requestRender();
        return;
      }
      case "usage_update": {
        currentUsage = event.usage;
        syncChrome();
        return;
      }
      case "thread_title_updated": {
        runtime.thread =
          runtime.database.getThread(runtime.thread.id) ?? runtime.thread;
        syncChrome();
        return;
      }
      case "turn_complete": {
        running = false;
        workingLine.stop();
        activeTurnComponent = null;
        syncFollowUps();
        tui.requestRender();
        return;
      }
      case "turn_error": {
        running = false;
        workingLine.stop();
        if (activeTurnComponent) {
          activeTurnComponent.turn.error = event.message;
        } else {
          addNotice(`× ${event.message}`, "err");
        }
        activeTurnComponent = null;
        tui.requestRender();
        return;
      }
      default:
        return;
    }
  };

  runtime.setEventListener(onStreamEvent);

  // --- Prompt Submission ---
  const submitPrompt = (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    editor.addToHistory(trimmed);

    if (trimmed.startsWith("/")) {
      const followUpMatch = /^\/(\d+)$/.exec(trimmed);
      if (followUpMatch) {
        const index = Number(followUpMatch[1]) - 1;
        const followUps =
          turnComponents[turnComponents.length - 1]?.getFollowUps() ?? [];
        const picked = followUps[index];
        if (picked) {
          submitPrompt(picked.query);
          return;
        }
        showToast(
          followUps.length > 0
            ? `Pick /1 to /${followUps.length}`
            : "No follow-up suggestions available",
          "warn",
        );
        return;
      }
      void handleSlashCommand(trimmed);
      return;
    }

    for (const comp of turnComponents) comp.setShowFollowUps(false);

    const referencedFiles: string[] = [];
    const matches = trimmed.matchAll(/(?:^|\s)@([^\s]+)/g);
    for (const m of matches) {
      const ref = m[1];
      if (ref && !referencedFiles.includes(ref)) referencedFiles.push(ref);
    }

    const wasRunning = running;
    if (!wasRunning) {
      addUserTurn(trimmed);
      running = true;
      workingLine.start();
    } else {
      showToast("Queued for after current step", "muted");
    }

    tui.requestRender();
    void runtime.orchestrator
      .sendPrompt({
        threadId: runtime.thread.id,
        text: trimmed,
        referencedFiles: referencedFiles.length ? referencedFiles : undefined,
      })
      .catch((error: unknown) => {
        running = false;
        workingLine.stop();
        addNotice(
          `× ${error instanceof Error ? error.message : "Run failed"}`,
          "err",
        );
      });
  };

  editor.onSubmit = (text) => {
    editor.setText("");
    submitPrompt(text);
  };

  // --- Global Keyboard Shortcuts ---
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (activeOverlay) {
        closeOverlay();
        return { consume: true };
      }
      if (currentApproval) {
        runtime.orchestrator.resolveApproval(
          runtime.thread.id,
          currentApproval.approval.toolCallId,
          false,
        );
        showNextApproval();
        return { consume: true };
      }
      if (editor.getText().length > 0) {
        editor.setText("");
        tui.requestRender();
        return { consume: true };
      }
      if (running) {
        void runtime.orchestrator.abort(runtime.thread.id).then((restored) => {
          running = false;
          workingLine.stop();
          if (restored.length > 0) editor.setText(restored.join("\n"));
          showToast("Stopped", "muted");
        });
        return { consume: true };
      }
      const now = Date.now();
      if (now - lastCtrlCAt < 1800) {
        requestExit(0);
      } else {
        lastCtrlCAt = now;
        showToast("Press Ctrl+C again to exit", "muted", 1800);
      }
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+d")) {
      if (
        !activeOverlay &&
        !currentApproval &&
        editor.getText().length === 0 &&
        !running
      ) {
        requestExit(0);
        return { consume: true };
      }
    }

    if (matchesKey(data, "ctrl+o")) {
      verbose = !verbose;
      for (const comp of turnComponents) comp.setVerbose(verbose);
      showToast(verbose ? "Details expanded" : "Details collapsed", "muted");
      tui.requestRender();
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+l")) {
      tui.requestRender(true);
      return { consume: true };
    }

    if (
      matchesKey(data, "escape") &&
      !activeOverlay &&
      !currentApproval &&
      !editor.isShowingAutocomplete() &&
      running
    ) {
      void runtime.orchestrator.abort(runtime.thread.id).then((restored) => {
        running = false;
        workingLine.stop();
        if (restored.length > 0 && !editor.getText()) {
          editor.setText(restored.join("\n"));
        }
        showToast("Stopped", "muted");
      });
      return { consume: true };
    }

    return undefined;
  });

  const spinnerTimer = setInterval(() => {
    let dirty = false;
    if (workingLine.tick()) dirty = true;
    if (activeTurnComponent?.tickSpinner()) dirty = true;
    if (dirty) tui.requestRender();
  }, 90);

  tui.setFocus(editor);
  tui.start();

  void tui
    .queryTerminalColors({
      timeoutMs: 120,
      onLateReply: (colors) => {
        const detected = detectSchemeFromColors(colors, theme.scheme);
        if (detected !== theme.scheme) applyTheme(createKipTheme(detected));
      },
    })
    .then((colors) => {
      const detected = detectSchemeFromColors(colors, theme.scheme);
      if (detected !== theme.scheme) applyTheme(createKipTheme(detected));
    })
    .catch(() => undefined);

  tui.setTerminalColorSchemeNotifications(true);
  const stopSchemeWatch = tui.onTerminalColorSchemeChange((nextScheme) => {
    if (nextScheme !== theme.scheme) applyTheme(createKipTheme(nextScheme));
  });

  if (opts.loadHistory) {
    await loadCurrentThreadHistory();
  }

  if (opts.initialToast) {
    showToast(opts.initialToast, "ok");
  }

  if (runtime.availableModels.length === 0) {
    addNotice(
      "No model configured yet. Open Kip Desktop → Settings → Providers to add one.",
      "warn",
    );
  } else if (opts.initialPrompt) {
    submitPrompt(opts.initialPrompt);
  }

  const outcome = await new Promise<SessionOutcome>((resolveOutcome) => {
    finishSession = resolveOutcome;
  });

  clearInterval(spinnerTimer);
  if (toastTimer) clearTimeout(toastTimer);
  stopSchemeWatch();
  if (running) {
    await runtime.orchestrator.abort(runtime.thread.id).catch(() => undefined);
  }
  await terminal.drainInput(200, 30);
  tui.stop({ preserveScreen: outcome.kind === "switch_layout" });
  return outcome;
}

function formatRelative(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
