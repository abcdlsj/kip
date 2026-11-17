> **Implementation notes (read with the contract):**
>
> * The maintained Pi distribution used here is `@earendil-works/pi-coding-agent`
>   and `@earendil-works/pi-ai` (1.5.x); the API contracts are the same family
>   referenced in this document.
> * Electrobun is pinned to 1.18.1. Stable Electrobun packages record a macOS 14
>   deployment target, so the `postWrap` hook lowers the launcher minimum to 12.0
>   and macOS 13 uses the bundled CEF renderer.
> * Code blocks intentionally use a dark surface in both themes for contrast.
> * The chat surface adds a two-level disclosure (`WorkLog` then tool detail)
>   following the progressive-disclosure guidance in Anthropic's MCP Apps
>   design guidelines.

# Kip — Product and Engineering Specification

> Kip is a quiet, cross-platform desktop coding agent. The document below is the
> locked implementation contract. Every architecture, protocol, visual, and
> delivery decision in it is final. The application ships under the name **Kip**
> and stores its data in `~/.kip/`.

这份开发规范文档专为本地自动化 Coding Agent 编写，已锁定全部架构选型、RPC 通信协议、数据结构、视觉 Token 与分阶段验收指令。你可以将其保存为项目根目录下的 `SPEC.md` 或 `PROMPT.md` 直接喂给本地 Agent 执行。

## 0. Agent 执行铁律（Execution Directives）

> **致本地执行 Agent：**
> 1. **零提问原则（Zero-Question Policy）：** 本规范已做出所有架构、技术栈、路径、命名及设计决策。严禁向人类开发者反问任何选型或细节问题；遇到边缘情况时，按本规范的“极简、克制、类型安全”原则自行闭环决策。
> 2. **SDK 真实性校验：** 开始编写集成代码前，先运行 `bun add` 安装依赖，并直接读取 `node_modules/electrobun` 与 `node_modules/@mariozechner/pi-coding-agent`（及 `@mariozechner/pi-ai`）中的 `.d.ts` 类型声明文件，以包内真实导出的 API 签名为准，通过 **Adapter 层** 对齐本文档定义的接口契约，严禁凭空臆造不存在的方法名。
> 3. **渐进式自检：** 每完成一个 Phase，必须执行 `bun run typecheck` 和构建验证，修复所有编译错误后再进入下一阶段。
> 4. **克制与纯粹：** 拒绝过度设计，严禁引入未在技术栈中声明的重量级 UI 组件库（如 AntD、MUI、Chakra），所有界面元素基于 Tailwind CSS + 轻量无头原语手写实现，确保纯粹的极简美学。
> 
> 

## 1. 项目定位与技术栈锁定

本项目代号 **Kip**，是一款基于 **Electrobun + Pi** 构建的跨平台原生感极简桌面 Agent 客户端。主进程基于 Bun 运行时直接原生嵌入 `Pi` SDK（零外部子进程开销、零 Node 环境依赖），渲染进程采用系统原生 WebView 承载高定级极简界面。

### 1.1 核心技术栈（严禁擅自替换）

| 层级 | 选型 | 详细说明 |
| --- | --- | --- |
| **桌面容器与运行时** | `electrobun` + `Bun` (>= 1.2) | 主进程全量运行于 Bun，原生调用 `bun:sqlite` 与系统 API |
| **Agent 底层内核** | `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` | 进程内直接 `import` 调用，接管会话树、多模型流式输出与工具调用 |
| **前端视图框架** | `React 19` + `TypeScript 5.x` + `Vite 6` | 开启 `strict: true`，构建产物嵌入 Electrobun `views://` 协议 |
| **状态管理** | `Zustand` + `immer` | 维护流式消息增量缓冲、会话树状态与工具执行队列 |
| **样式与动效** | `Tailwind CSS v4` + `Motion` (`framer-motion`) | CSS 变量驱动主题，物理弹簧曲线控制微交互 |
| **无头交互与图标** | `@radix-ui` (Dialog/Popover/Tooltip) + `lucide-react` | 图标统一限制 `strokeWidth={1.5}`，保持纤细克制 |
| **富文本与代码渲染** | `react-markdown` + `remark-gfm` + `shiki` | Shiki 双主题（`vitesse-light` / `vitesse-dark`）异步高亮 |
| **本地持久化** | `bun:sqlite` + `~/.kip/` 文件系统 | SQLite 存储工作区、元数据与密钥索引；会话 JSONL 与 Pi 标准格式兼容 |

## 2. 目录结构规范

初始化项目必须严格遵循以下目录树：

```text
kip/
├── package.json
├── tsconfig.json
├── electrobun.config.ts              # Electrobun 构建、窗口打包与平台签名配置
├── vite.config.ts                    # 渲染进程 Vite 构建配置（输出至 build/views/main）
├── src/
│   ├── shared/                       # 主进程与渲染进程共享纯类型与常量（零运行时依赖）
│   │   ├── rpc-schema.ts             # Electrobun 双端强类型 RPC 契约定义
│   │   ├── types.ts                  # 会话、消息块、工具状态、模型配置核心数据结构
│   │   └── constants.ts              # 默认快捷键、内置模型列表、默认系统提示词
│   ├── bun/                          # Electrobun 主进程代码（Bun 环境）
│   │   ├── index.ts                  # 应用入口：生命周期、窗口创建、原生菜单与快捷键
│   │   ├── rpc-handler.ts            # 绑定并分发前端 RPC 请求，向前端推送流式事件
│   │   ├── agent/
│   │   │   ├── pi-Orchestrator.ts    # Pi SDK 核心适配器：管理多会话实例与 AbortController
│   │   │   ├── tool-interceptor.ts   # 工具拦截器：处理只读自动放行与写操作挂起审批
│   │   │   └── session-bridge.ts     # 将 Pi 树状 Session 映射为前端扁平/分支视图结构
│   │   ├── storage/
│   │   │   ├── db.ts                 # bun:sqlite 初始化与 CRUD（workspaces, settings, models）
│   │   │   └── keychain.ts           # API Key 安全读写（优先系统钥匙串，降级 AES-GCM 本地加密）
│   │   └── system/
│   │       ├── fs-dialog.ts          # 原生文件夹选择、外部链接打开、Finder/Explorer 定位
│   │       └── git-inspector.ts      # 轻量读取当前工作区 Git 分支名与变更文件计数
│   └── webview/                      # 渲染进程代码（浏览器/WebView 环境）
│       ├── index.html
│       ├── main.tsx
│       ├── rpc-client.ts             # Electrobun Electroview RPC 客户端单例与事件订阅器
│       ├── styles/
│       │   ├── tokens.css            # 色彩、字体、阴影、圆角 CSS 变量定义
│       │   └── globals.css           # Tailwind 引入、Avenir Next 字体栈、自定义滚动条与选中态
│       ├── stores/
│       │   ├── workspace-store.ts    # 工作区与会话列表状态
│       │   ├── chat-store.ts         # 当前会话消息流、思考折叠态、待审批工具栈
│       │   └── ui-store.ts           # 侧边栏折叠、主题模式、Command+K 面板、设置弹窗状态
│       └── components/
│           ├── layout/
│           │   ├── AppShell.tsx      # 顶层无边框窗口骨架、自定义标题栏拖拽区
│           │   ├── Sidebar.tsx       # 可折叠极简侧边栏（工作区切换 + 会话历史）
│           │   └── TopBar.tsx        # 悬浮顶栏（面包屑、Git 分支徽章、上下文用量环）
│           ├── chat/
│           │   ├── ThreadCanvas.tsx  # 居中叙事流画布（自动贴底锁与回到底部悬浮胶囊）
│           │   ├── MessageTurn.tsx   # 单轮对话渲染（用户胶囊 vs 无气泡 Agent 排版流）
│           │   ├── ThinkingTrace.tsx # 思考过程单行呼吸折叠条
│           │   ├── ToolStepPill.tsx  # 工具调用行内胶囊与点击展开的原生 Diff 抽屉
│           │   └── ApprovalBanner.tsx# 危险操作/写文件内联审批卡片
│           ├── composer/
│           │   ├── Composer.tsx      # 底部悬浮自适应输入框（支持 @文件 引用与图片粘贴）
│           │   └── ModelSelector.tsx # 底部微缩模型与推理强度切换器
│           └── modals/
│               ├── CommandPalette.tsx# Cmd/Ctrl + K 全局指令面板
│               └── SettingsModal.tsx # 极简分栏设置中心（API Keys / 外观 / 安全策略）

```

## 3. UI/UX 美学与视觉规范（核心灵魂）

整体设计哲学对标 **Linear + Craft + Braun（博朗工业设计）**：**以排版和留白取代边框与色块，安静、克制、零视觉噪音。**

### 3.1 字体系统：`Avenir Next` 排版引擎

全局严禁使用系统默认粗劣的无衬线回退链，所有字号、字重、字距必须严格受控。在 `src/webview/styles/globals.css` 中写入：

```css
:root {
  --font-sans: "Avenir Next", "Avenir", "Plus Jakarta Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "Menlo", "Consolas", monospace;
}

html, body {
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  letter-spacing: -0.011em;
  user-select: none; /* UI 壳层默认不可选中，像真正原生应用；仅对话正文与代码块开启 select-text */
}

```

* **字阶规范：**
* **工作区大标题 / 空状态问候语：** `22px` (`font-weight: 500`, `letter-spacing: -0.022em`, `line-height: 1.3`)
* **对话正文（Markdown 阅读流）：** `15px` (`font-weight: 400`, `line-height: 1.68`, 段落间距 `14px`)
* **UI 导航 / 侧边栏条目 / 输入框：** `13.5px` (`font-weight: 500`, `line-height: 1.4`)
* **辅助元数据 / 快捷键角标 / 工具耗时：** `11.5px` (`font-weight: 500`, `letter-spacing: 0.02em`, 开启 `tabular-nums`)
* **代码块与路径：** `12.5px` (`var(--font-mono)`, `line-height: 1.6`)


* **粗细禁令：** 全局最高字重只允许用到 `600` (`semibold`)，严禁出现 `700/800` 的笨重粗体，确保 `Avenir Next` 几何人文主义的优雅呼吸感。

### 3.2 色彩系统：暖调纸张（Alabaster）与深邃黑曜石（Obsidian）

严禁使用刺眼的纯白 (`#FFFFFF`) 作为背景或纯黑 (`#000000`) 作为文字。在 `src/webview/styles/tokens.css` 中定义双主题语义变量：

```css
:root, [data-theme="light"] {
  --bg-canvas: #FAF9F6;           /* 主画布：暖白宣纸色 */
  --bg-sidebar: #F3F1EC;          /* 侧边栏：微暖亚麻灰 */
  --bg-elevated: #FFFFFF;         /* 悬浮输入框/弹窗：纯净浮层 */
  --bg-subtle: rgba(24, 24, 27, 0.04); /* 悬停态与用户消息浅底 */
  --bg-code: #F4F3EF;             /* 代码块底色 */

  --text-primary: #18181B;        /* 主文字：深炭黑 */
  --text-secondary: #52525B;      /* 次要说明文字 */
  --text-muted: #A1A1AA;          /* 占位符与弱化时间戳 */

  --border-hairline: rgba(24, 24, 27, 0.07); /* 0.5px 级隐形发丝分割线 */
  --border-focus: rgba(24, 24, 27, 0.22);    /* 输入框聚焦边框 */

  --accent-ink: #18181B;          /* 主按钮：深墨色实心 */
  --accent-ink-fg: #FAF9F6;
  --accent-brand: #4F5D75;        /* 克制的雾霾蓝灰点缀色 */
  --status-ok: #2D6A4F;
  --status-warn: #B45309;
  --status-err: #BE123C;

  --shadow-composer: 0 8px 30px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.03);
  --shadow-modal: 0 24px 60px rgba(0, 0, 0, 0.10), 0 0 0 1px rgba(0, 0, 0, 0.05);
}

[data-theme="dark"] {
  --bg-canvas: #111113;           /* 主画布：深曜石黑 */
  --bg-sidebar: #0B0B0C;          /* 侧边栏：深邃底衬 */
  --bg-elevated: #19191C;         /* 悬浮输入框/弹窗 */
  --bg-subtle: rgba(255, 255, 255, 0.045);
  --bg-code: #161619;

  --text-primary: #EDEDEF;
  --text-secondary: #9E9EA9;
  --text-muted: #5C5C66;

  --border-hairline: rgba(255, 255, 255, 0.065);
  --border-focus: rgba(255, 255, 255, 0.20);

  --accent-ink: #EDEDEF;
  --accent-ink-fg: #111113;
  --accent-brand: #8FA3BF;
  --status-ok: #52B788;
  --status-warn: #F59E0B;
  --status-err: #FB7185;

  --shadow-composer: 0 12px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.06);
  --shadow-modal: 0 28px 70px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
}

```

### 3.3 空间布局与核心组件交互细节

1. **原生无边框窗口（Frameless Chrome）：**
* macOS 启用 `titleBarStyle: 'hiddenInset'`，红黄绿交通灯按钮内嵌于左上角 `(x: 16, y: 16)`；Windows/Linux 隐藏系统原生丑陋标题栏，在右上角手写极简最小化/最大化/关闭三个 `14px` 细线图标。顶部预留 `38px` 高度设置 Electrobun 窗口拖拽属性。


2. **两栏呼吸式架构（无右侧繁杂面板）：**
* **左侧栏（宽度 `232px`，支持 `Cmd/Ctrl + B` 丝滑收起至 `0px`）：** 顶部为当前 Workspace 文件夹下拉切换器；中部为按“Today / Previous 7 Days / Older”分组的极简会话列表（无图标堆砌，仅单行标题，悬停渐显归档小圆点）；底部仅放置一个“New Thread (`Cmd+N`)”与左下角微缩齿轮图标。
* **主画布（阅读最大宽度锁定 `740px` 居中）：** 拒绝全屏宽拉满导致的眼球疲劳。顶栏采用背景半透明 `backdrop-blur-md` 悬浮设计，右侧仅展示当前 Git 分支名与一枚 `14px` 圆环进度条（实时显示 Pi 当前 Context Window 占用百分比，点击可手动触发 Pi 的 `compact` 上下文压缩）。


3. **去气泡化的杂志级对话流（Editorial Stream）：**
* **严禁使用左右聊天气泡和机器人头像！**
* **用户消息：** 右对齐或左对齐均可，推荐采用**左对齐浅底内聚胶囊**（`bg-[var(--bg-subtle)] rounded-2xl px-4 py-2.5 text-[var(--text-primary)]`），干净利落。
* **Agent 回复：** 直接铺展在 `--bg-canvas` 画布之上，无头像、无背景框。代码块顶部带极细栏显示语言名称与一键复制图标（复制后变为对勾持续 `1.5s`）。


4. **思考链与工具调用的“降噪折叠”：**
* **Thinking Trace：** 模型输出思考过程时，仅渲染为一行柔和呼吸微光的灰色斜体小字 `Reasoning · 2.4s ▸`，生成完毕自动保持折叠，点击才以弹簧动画向下展开阅读详情。
* **Tool Step Pill（核心亮点）：** `Pi` 调用 `read`、`bash`、`edit`、`write` 时，**严禁直接把几百行终端输出刷在主聊天流里**！统一渲染为高颜值单行胶囊：
* 示例：`[ ⌘ Executed bun test · 420ms ✓ ]` 或 `[ ✎ Edited src/bun/index.ts (+18 -4) ]`
* 点击该胶囊，平滑展开一个高度受限 (`max-h-72`) 的内联抽屉：如果是 `edit`/`write`，用双色行级 Diff 视图展示增删对比；如果是 `bash`，用等宽暗色微终端展示 ANSI 清洗后的输出。




5. **悬浮创作者输入框（Floating Composer）：**
* 距离窗口底部悬浮 `20px`，居中最大宽度 `740px`，圆角 `18px`，背景 `--bg-elevated`，配 `--shadow-composer` 与 `1px` `--border-hairline`。
* 上半部分为自适应高度 `textarea`（最小 2 行，最高 `220px`，`Enter` 发送，`Shift+Enter` 换行，输入 `@` 弹出当前工作区文件模糊搜索列表）。
* 下半部分底栏（高度 `32px`）：左侧为极简药丸形的模型切换器（如 `Claude Sonnet 4 · Medium`）与附件按钮；右侧在空闲时为深墨色圆形上箭头发送钮 (`28x28px`)，在 Agent 运行中平滑变形为带呼吸边框的方形停止钮（支持按 `Esc` 立即中断流式生成）。


6. **动效曲线铁律：**
* 全局所有布局展开、侧边栏收起、弹窗浮现统一使用物理阻尼弹簧 `{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }`，严禁使用生硬的线性过渡或夸张弹跳。



## 4. 双进程架构与底层设计（Bun ↔ Pi ↔ WebView）

### 4.1 共享数据类型（`src/shared/types.ts`）

```typescript
export type ThemeMode = 'light' | 'dark' | 'system';
export type ApprovalPolicy = 'read-only-auto' | 'full-auto' | 'strict';

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  gitBranch: string | null;
  lastOpenedAt: number;
}

export interface ThreadSummary {
  id: string;
  workspaceId: string;
  title: string;
  sessionFilePath: string;
  modelProvider: string;
  modelId: string;
  updatedAt: number;
  isRunning: boolean;
}

export type ContentBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; thinking: string; durationMs?: number; isComplete: boolean }
  | {
      type: 'tool_call';
      id: string;
      toolName: 'read' | 'write' | 'edit' | 'bash' | string;
      args: Record<string, unknown>;
      status: 'running' | 'awaiting_approval' | 'completed' | 'error' | 'denied';
      summaryLabel: string; // 例如 "Edited src/app.tsx (+12 -3)"
      output?: string;
      diff?: { before: string; after: string; filePath: string };
      durationMs?: number;
    };

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  attachments?: Array<{ name: string; path: string; mimeType: string }>;
  createdAt: number;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  ratio: number; // 0 ~ 1
}

```

### 4.2 Electrobun 强类型 RPC 契约（`src/shared/rpc-schema.ts`）

利用 Electrobun 的双端 RPC 机制，严格划分请求（Request-Response）与单向流式消息（Message Push）：

```typescript
import type {
  Workspace, ThreadSummary, ChatTurn, ContextUsage, ApprovalPolicy, ThemeMode
} from './types';

export interface KipRPCSchema {
  bun: {
    requests: {
      // 工作区与系统交互
      listWorkspaces: { params: void; response: Workspace[] };
      pickAndCreateWorkspace: { params: void; response: Workspace | null };
      removeWorkspace: { params: { workspaceId: string }; response: void };
      listWorkspaceFiles: { params: { workspaceId: string; query: string }; response: string[] };

      // 会话生命周期
      listThreads: { params: { workspaceId: string }; response: ThreadSummary[] };
      createThread: { params: { workspaceId: string; modelProvider?: string; modelId?: string }; response: ThreadSummary };
      loadThreadTurns: { params: { threadId: string }; response: { turns: ChatTurn[]; usage: ContextUsage } };
      deleteThread: { params: { threadId: string }; response: void };
      compactThread: { params: { threadId: string }; response: ContextUsage };

      // Agent 执行控制
      sendPrompt: {
        params: {
          threadId: string;
          text: string;
          referencedFiles?: string[];
          images?: Array<{ mimeType: string; base64Data: string }>;
        };
        response: { accepted: boolean };
      };
      abortThread: { params: { threadId: string }; response: void };
      resolveToolApproval: {
        params: { threadId: string; toolCallId: string; approved: boolean; rememberForSession?: boolean };
        response: void;
      };

      // 模型、设置与密钥管理
      getSettings: {
        params: void;
        response: {
          theme: ThemeMode;
          approvalPolicy: ApprovalPolicy;
          defaultProvider: string;
          defaultModelId: string;
          configuredProviders: string[];
          availableModels: Array<{ provider: string; modelId: string; displayName: string; contextWindow: number }>;
        };
      };
      updateSettings: {
        params: Partial<{ theme: ThemeMode; approvalPolicy: ApprovalPolicy; defaultProvider: string; defaultModelId: string }>;
        response: void;
      };
      setProviderApiKey: { params: { provider: string; apiKey: string }; response: { valid: boolean } };
      windowControl: { params: { action: 'minimize' | 'maximize' | 'close' }; response: void };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      // 主进程向前端推送的高频流式事件（必须做 16ms 帧合并节流防抖）
      agentStreamEvent: {
        threadId: string;
        event:
          | { kind: 'turn_start'; turn: ChatTurn }
          | { kind: 'text_delta'; turnId: string; blockId: string; delta: string }
          | { kind: 'thinking_delta'; turnId: string; blockId: string; delta: string }
          | { kind: 'thinking_done'; turnId: string; blockId: string; durationMs: number }
          | { kind: 'tool_start'; turnId: string; block: Extract<ChatTurn['blocks'][number], { type: 'tool_call' }> }
          | { kind: 'tool_approval_required'; turnId: string; toolCallId: string; commandOrPath: string; previewDiff?: string }
          | { kind: 'tool_end'; turnId: string; toolCallId: string; status: 'completed' | 'error' | 'denied'; output?: string; diff?: { before: string; after: string; filePath: string }; durationMs: number; summaryLabel: string }
          | { kind: 'usage_update'; usage: ContextUsage }
          | { kind: 'thread_title_updated'; title: string }
          | { kind: 'turn_complete' }
          | { kind: 'turn_error'; message: string };
      };
    };
  };
}

```

### 4.3 Pi SDK 嵌入式编排器设计（`src/bun/agent/pi-orchestrator.ts`）

严禁通过 `Bun.spawn(["pi", ...])` 子进程调用！必须在 Bun 主进程内直接实例化 `Pi` 的 `AgentSession`（通过 `createAgentSession` 或包内导出的等价工厂方法）：

1. **多会话并发池：** 维护 `Map<threadId, ActivePiSession>`，允许用户在工作区 A 让 Agent 后台跑重构的同时，切换到工作区 B 开启另一个会话提问，互不阻塞。
2. **自定义安全工具包装（Tool Interceptor）：**
* 默认加载 `Pi` 内置的 `read`、`write`、`edit`、`bash`（及可选 `grep`/`find`/`ls`）工具，并将 `cwd` 严格锁定在当前 `Workspace.rootPath` 内（校验路径防止越界逃逸）。
* 根据用户的 `approvalPolicy` 进行拦截：
* `read-only-auto`（**默认开启**）：`read`/`ls`/`grep` 自动静默执行；当触发 `write`/`edit`（先在内存中计算修改前后的 `before/after` 文本快照生成 Diff）或非只读 `bash` 命令时，在工具 `execute` 函数内部构造一个未决 `Promise` 挂起执行，同时通过 RPC 向前端发送 `tool_approval_required` 事件；待用户点击“Allow (`Cmd+Enter`)”或“Deny”调用 `resolveToolApproval` 后，再 resolve 该 Promise 继续或抛出拒绝信息返回给模型。




3. **16ms 流式帧缓冲（Frame Coalescing）：**
* 模型输出的 `text_delta` 和 `thinking_delta` 频率极高（每秒上百次），`pi-orchestrator` 必须在 Bun 侧建立 `16ms`（约 60fps）的字符串累加缓冲器，合并后再通过 Electrobun IPC 发往 WebView，彻底杜绝 IPC 通道拥塞与 React 高频重排卡顿。


4. **首轮对话自动拟定标题：**
* 新建会话收到第一条用户消息并开始回复时，后台异步用轻量小模型（或直接截取提炼前 28 个字符做降级兜底）生成简短优雅的标题（不带引号与句号），更新 SQLite 并推送 `thread_title_updated`。



### 4.4 本地存储与安全设计（`~/.kip/`）

* 数据目录统一存放于系统用户目录 `~/.kip/`：
* `~/.kip/kip.sqlite`：使用 `bun:sqlite` 开启 `PRAGMA journal_mode = WAL;`，创建三张表：`workspaces`、`threads`、`kv_settings`。
* `~/.kip/sessions/<workspaceId>/<threadId>.jsonl`：直接交给 `Pi` 的 `SessionManager` 持久化树状会话上下文。
* **API Key 安全存储（`keychain.ts`）：** macOS 下优先通过 `security add-generic-password / find-generic-password` 存入 macOS Keychain；Windows/Linux 下使用基于机器硬件标识派生的 `WebCrypto AES-256-GCM` 加密后存入 `~/.kip/credentials.enc`，**严禁将明文 API Key 写入 SQLite 或日志**，并在运行时动态注入给 `Pi` 的 `AuthStorage` / 模型实例。



## 5. 分阶段自动化实施路线（Implementation Roadmap）

本地 Agent 必须严格按照以下 5 个阶段顺序推进，每步完成后自检：

### Phase 1：工程脚手架与双进程构建链路打通

1. 初始化 `package.json`，安装核心依赖：`electrobun`、`@mariozechner/pi-coding-agent`、`@mariozechner/pi-ai`、`react`、`react-dom`、`zustand`、`immer`、`motion`、`lucide-react`、`react-markdown`、`remark-gfm`、`shiki`、`tailwindcss`、`@tailwindcss/vite` 以及对应的 `@types/*` 与 `typescript`。
2. 仔细查阅 `node_modules/electrobun` 的文档与类型声明，配置好 `electrobun.config.ts` 与 `vite.config.ts`，确保 Vite 构建的静态资源正确输出至 Electrobun 视图目录。
3. 编写最小化的 `src/bun/index.ts`（创建宽 `1180px`、高 `780px`、最小尺寸 `820x560` 的无边框窗口）与 `src/webview/App.tsx`，打通 `rpc-schema.ts` 的一次端到端心跳调用。
4. **阶段验收：** `bun run typecheck` 零报错，构建脚本成功产出桌面应用包体。

### Phase 2：本地存储层与系统能力封装

1. 实现 `src/bun/storage/db.ts`（`bun:sqlite` 建表、迁移与类型安全的 DAO 方法）。
2. 实现 `src/bun/storage/keychain.ts` 多平台密钥安全存取，支持 Anthropic、OpenAI、Google Gemini、DeepSeek 及自定义 OpenAI-Compatible BaseURL 配置。
3. 实现 `src/bun/system/fs-dialog.ts`（调用 Electrobun 原生文件夹选择对话框、读取工作区文件列表并自动过滤 `.git` 与 `node_modules`）以及 `git-inspector.ts`（非阻塞获取分支名）。
4. **阶段验收：** 为 `db.ts` 和 `keychain.ts` 编写 `bun test` 单元测试并全部跑通。

### Phase 3：Pi SDK 核心适配与工具审批拦截器

1. 阅读 `node_modules/@mariozechner/pi-coding-agent` 真实导出接口，编写 `pi-orchestrator.ts`、`tool-interceptor.ts` 与 `session-bridge.ts`。
2. 实现会话创建、历史 `.jsonl` 恢复、`16ms` 节流流式输出、按 `AbortController` 毫秒级中断、手动上下文压缩（`compact`）以及写文件/执行命令的 Promise 挂起审批机制。
3. 将所有能力挂载至 `src/bun/rpc-handler.ts`。
4. **阶段验收：** 编写无界面集成测试脚本，模拟工具拦截挂起与恢复流程，验证 `bun run typecheck` 与 `bun test` 全部通过。

### Phase 4：Avenir Next 极简设计系统与高定界面实现

1. 落地 `tokens.css` 与 `globals.css`，严格校准 `Avenir Next` 字阶、暖白/深曜石配色、自定义极细隐藏式滚动条与亮暗主题无缝切换。
2. 构建 `AppShell`、`Sidebar`、`TopBar`（含上下文圆环进度指示器与 Git 分支胶囊）。
3. 构建 `ThreadCanvas`（实现智能阅读锚点：用户向上滚动阅读历史时自动解除强制贴底，底部浮现柔和胶囊按钮 `↓ Jump to latest`；位于底部时随流式输出平滑贴底）。
4. 构建无气泡 `MessageTurn`、Shiki 代码高亮块、呼吸折叠 `ThinkingTrace`、可展开 Diff 抽屉的 `ToolStepPill` 以及内联 `ApprovalBanner`。
5. 构建悬浮 `Composer`（支持 `@` 文件检索弹窗、拖拽/粘贴图片预览、模型与推理等级切换）。

### Phase 5：全局快捷键、空状态仪式感与边缘打磨

1. 实现 `CommandPalette` (`Cmd/Ctrl + K`)：支持快速切换工作区、搜索历史会话、新建对话、触发上下文压缩、切换亮暗主题、打开设置。
2. 绑定全局快捷键：`Cmd/Ctrl + N`（新建会话）、`Cmd/Ctrl + B`（折叠侧边栏）、`Cmd/Ctrl + ,`（打开设置弹窗）、`Esc`（中断当前正在运行的 Agent 流）、`Cmd/Ctrl + Enter`（快捷批准当前挂起的工具调用）。
3. **空状态与首次启动引导（Zero-Key Onboarding）：**
* 若检测到尚未配置任何模型 API Key，居中展示极具呼吸感的极简欢迎卡片，引导一键填入首个 API Key 并立即验证连通性，拒绝生硬的报错弹窗。
* 新建空会话时，画布中央仅呈现一句随时间变化的克制问候（如 `Good evening. Ready in ~/projects/kip.`）及 3 个单行胶囊快捷建议，一旦发送首条消息立即优雅淡出。


4. **最终交付自检清单：**
* 全仓库执行 `bun run typecheck` 零错误、零 `any` 逃逸。
* 检查所有文本样式是否 100% 继承 `Avenir Next` 字体栈且无粗体泛滥。
* 验证亮色（Alabaster）与暗色（Obsidian）两套主题下对比度、边框发丝线、代码块高亮均精致无瑕。
* 执行 `electrobun build` 完成应用完整打包验证，并输出简明启动说明 `README.md`。

将以下内容作为下半部分（第 6 至第 10 节）直接追加到刚才的 `SPEC.md` 末尾。这部分补齐了数据库精确表结构、安全边界与命令判定规则、前端流式状态机、组件级像素参数以及打包与验收红线，彻底封死本地 Agent 自由发挥导致跑偏的空间。

## 6. 数据库 Schema 与本地存储精确定义（`src/bun/storage/db.ts`）

SQLite 数据库文件固定存储于 `~/.kip/kip.sqlite`。初始化连接时必须立即执行以下 Pragma 与建表 DDL，严禁使用第三方重量级 ORM（如 Prisma/TypeORM），直接使用 `bun:sqlite` 原生预编译语句（Prepared Statements）：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  last_opened_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  session_file_path TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  thinking_level TEXT NOT NULL DEFAULT 'medium', -- 'off' | 'low' | 'medium' | 'high'
  is_archived INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated 
  ON threads(workspace_id, is_archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS kv_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_providers (
  id TEXT PRIMARY KEY,               -- 例如 'openrouter', 'ollama-local'
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_protocol TEXT NOT NULL DEFAULT 'openai-completions', -- 'openai-completions' | 'anthropic-messages'
  models_json TEXT NOT NULL,         -- JSON 数组：[{ id, name, contextWindow }]
  created_at INTEGER NOT NULL
);

```

### 6.1 默认设置种子数据（首次启动自动写入 `kv_settings`）

* `theme`: `"system"`
* `approvalPolicy`: `"read-only-auto"`
* `defaultProvider`: `"anthropic"`
* `defaultModelId`: `"claude-sonnet-4-20250514"`（若包内内置最新模型枚举，优先取对应 Provider 旗舰编码模型）
* `sidebarCollapsed`: `false`

## 7. 安全沙箱、路径逃逸防护与危险命令判定（`src/bun/agent/tool-interceptor.ts`）

本地 Agent 在实现 `tool-interceptor.ts` 时，必须逐条落实以下底层安全逻辑，不得简化跳过：

### 7.1 工作区路径越界校验（Path Traversal Guard）

每次拦截 `read`、`write`、`edit`、`ls`、`grep`、`find` 工具时，提取目标路径参数 `targetPath`：

1. 使用 `path.resolve(workspaceRootPath, targetPath)` 解析绝对路径，并通过 `fs.realpathSync`（若目标文件尚不存在则校验其父目录 `path.dirname`）解析软链接真实路径。
2. 判定真实路径是否严格以 `workspaceRootPath + path.sep` 开头（或等于 `workspaceRootPath`）：
* **在工作区内：** 按当前 `approvalPolicy` 正常走自动放行或写操作挂起。
* **越出工作区外：** 无论当前策略是否为 `full-auto`，**强制降级为 `awaiting_approval` 挂起状态**，并在审批卡片中以醒目琥珀色标签提示 `Outside Workspace Access`。


3. **敏感文件硬拦截：** 任何试图读取 `~/.ssh/*`、`~/.aws/*`、`~/.gnupg/*` 或 `~/.kip/credentials.enc` 的调用直接拒绝并返回权限错误给模型。

### 7.2 Bash 命令静态分级器（Command Risk Classifier）

在 `read-only-auto` 模式下，收到 `bash` 工具调用请求时，先解析命令字符串（若包含 `&&`、`;`、`|`、`$()` 或反引号子 shell，拆解所有子命令逐一取最高风险等级）：

* **白名单自动放行（Safe Read-Only）：** 仅限纯查询命令，包括 `pwd`、`ls`、`cat`、`head`、`tail`、`wc`、`stat`、`which`、`echo`（不含重定向 `>`/`>>`）、`rg`、`grep`、`find`（不含 `-exec`/`-delete`）、`git status`、`git diff`、`git log`、`git branch --show-current`。
* **常规挂起审批（Standard Approval）：** 包管理安装、测试构建、普通文件移动、带重定向命令（如 `bun test`、`npm install`、`git commit`、`mkdir`、`mv`）。支持勾选“本次会话允许同类测试/构建命令”。
* **高危红色警告（High-Risk Destructive）：** 命中 `rm -rf`、`sudo`、`chmod 777`、`mkfs`、`dd`、`git reset --hard`、`git push --force`、`curl ... | sh` 时，审批横幅必须渲染为 `--status-err` 警示态，且禁用“记住选择”，必须每次手动点击确认。

### 7.3 行级 Diff 计算规范

当拦截到 `edit` 或 `write` 工具时：

1. 在实际落盘或挂起审批前，先读取原文件 UTF-8 文本记为 `before`（若为新建文件则 `before = ""`；若文件大于 `512KB` 或检测到 `\0` 字节判定为二进制文件，则跳过全文 Diff 仅展示文件大小变化）。
2. 在内存中计算出变更后的完整文本记为 `after`，统计新增行数 `+N` 与删除行数 `-M`，拼装 `summaryLabel`（如 `Edited src/webview/App.tsx (+24 -6)`）。
3. 将 `{ before, after, filePath }` 随 `tool_approval_required` 与 `tool_end` 推送至前端，供内联 Diff 抽屉做行级对比渲染（无需引入笨重的 Monaco Editor，手写基于最长公共子序列 LCS 或引入轻量库 `diff` 实现百行以内极速双色行对比视图，配行号列与语法高亮）。

## 8. 前端流式状态机与性能优化细节（`src/webview/stores/`）

### 8.1 `chat-store.ts` 高频流式更新准则

* **按会话隔离缓存：** Store 结构采用 `threadsMap: Record<threadId, ThreadViewState>`，保证后台会话收到流式推送时静默更新内存，不触发当前前台无关会话组件的 Re-render。
* **细粒度 Selector 订阅：** `MessageTurn` 组件必须使用 `React.memo` 包裹，且仅按 `turnId` 订阅自身数据；历史已完成的 `ChatTurn` 在新一轮流式输出期间 **重渲染次数必须严格为 0**。
* **Shiki 异步流式高亮防抖：**
* 在代码块尚未闭合（流式输出进行中）时，先使用极速纯文本等宽样式渲染代码，仅每 `180ms` 节流触发一次 Shiki 增量高亮；代码块一旦闭合或 `turn_complete` 触发，立即完成最终精确语法着色，避免每个字符 delta 重跑完整词法分析导致掉帧。



### 8.2 智能滚动锚点算法（`ThreadCanvas.tsx`）

严禁使用生硬的 `scrollIntoView()` 定时器轮询：

1. 监听滚动容器的 `onScroll` 事件，计算距离底部的像素差：`distanceToBottom = scrollHeight - scrollTop - clientHeight`。
2. 当 `distanceToBottom <= 48px` 时，标记 `isPinnedToBottom = true`；一旦用户主动向上滚轮滚动且 `distanceToBottom > 48px`，立即置 `isPinnedToBottom = false`，并在底部 Composer 上方 `12px` 处以弹簧动画浮现半透明毛玻璃胶囊 `[ ↓ Jump to latest ]`。
3. 当收到 `text_delta` / `tool_start` 内容增高时，仅在 `isPinnedToBottom === true` 时于 `requestAnimationFrame` 中同步设置 `container.scrollTop = container.scrollHeight`。

## 9. 核心组件像素级视觉详规（Component Micro-Specs）

为确保最终界面呈现出极其纯粹优雅的 `Avenir Next` 极简质感，所有组件尺寸、间距、圆角严格按以下参数硬编码实现：

| 组件名称 | 尺寸与间距参数 | 视觉与交互微细节 |
| --- | --- | --- |
| **窗口顶栏 `TopBar**` | 高度 `44px`，左右内边距 `16px` | 背景 `color-mix(in srgb, var(--bg-canvas) 82%, transparent)` + `backdrop-filter: blur(14px)`；底部**不画分割线**，仅在页面发生向下滚动 (`scrollTop > 8`) 时渐显 `1px` `--border-hairline` |
| **侧边栏 `Sidebar**` | 展开宽度 `232px`，收起宽度 `0px`，内边距 `12px 10px` | 与主画布之间用 `1px solid var(--border-hairline)` 分隔；会话项高度 `32px`，圆角 `8px`，字号 `13px`，单行 `truncate`；选中态背景为 `--bg-subtle` 且文字变为 `--text-primary` (`font-weight: 500`)，**严禁在左侧画彩色竖条** |
| **用户消息块** | 最大宽度 `82%`，圆角 `16px`，内边距 `10px 16px`，上下外边距 `20px` | 背景 `--bg-subtle`，无边框，文字 `15px`；若附带 `@file` 引用，在正文上方渲染高度 `22px` 的极细圆角小标签展示文件名 |
| **Agent 正文流** | 容器最大宽度 `740px` 居中，水平留白 `28px` | 无背景、无头像；一级标题 `19px`，二级标题 `16.5px`，列表项缩进 `18px`，行内代码 `bg-[var(--bg-code)] px-1.5 py-0.5 rounded-[5px] text-[13px]` |
| **思考折叠条 `ThinkingTrace**` | 行高 `26px`，外边距 `6px 0` | 折叠态仅显示 `✦ Thought for 1.8s`（生成中显示柔和 CSS 线性渐变扫光动画 `Thinking...`）；展开后左侧带一条 `1.5px` 宽的 `--border-hairline` 竖向引导线，内嵌 `13.5px` `--text-secondary` 文字 |
| **工具胶囊 `ToolStepPill**` | 高度 `28px`，圆角 `9999px`（全胶囊），内边距 `0 11px` | 边框 `1px solid var(--border-hairline)`，背景透明，悬停变为 `--bg-subtle`；左侧 `13px` 单色细图标，中部等宽路径/命令摘要，右侧耗时 `320ms`（`tabular-nums`）与状态微标 |
| **内联审批卡 `ApprovalBanner**` | 圆角 `12px`，内边距 `14px 16px` | 嵌入在当前工具步骤正下方，边框 `1px solid var(--border-focus)`，背景 `--bg-elevated`；顶部说明待执行操作，中部可选预览 Diff/命令，右下角两个极简按钮：`Deny`（纯文字次级钮）与 `Allow ⌘↵`（`--accent-ink` 实心墨色胶囊钮，高 `28px`） |
| **悬浮输入框 `Composer**` | 底部留白 `20px`，宽度 `min(740px, calc(100% - 48px))`，圆角 `18px`，内边距 `12px 14px 10px` | 聚焦时边框从 `--border-hairline` 柔和过渡至 `--border-focus`（过渡时长 `150ms`），**严禁出现浏览器默认的蓝色外发光 `outline` 环** |
| **指令面板 `CommandPalette**` | 宽 `560px`，距窗口顶部 `16vh`，圆角 `14px` | 遮罩层采用极轻柔暗化 `rgba(0,0,0,0.18)` + `blur(4px)`；顶部搜索框字号 `15px`，列表项高 `36px`，右侧快捷键统一用 `<kbd>` 渲染微缩字符 `⌘ K` |

## 10. 构建配置、异常兜底与最终验收红线

### 10.1 关键脚本定义（`package.json`）

必须在 `package.json` 的 `scripts` 中配置齐全以下标准命令，确保人类开发者接手后一键可跑：

```json
{
  "name": "kip",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:view": "vite build --watch",
    "dev": "bun run build:view && electrobun dev",
    "build:view": "vite build",
    "build": "bun run typecheck && bun run build:view && electrobun build",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}

```

*(注：若安装的 `electrobun` 版本 CLI 命令参数有细微差异，根据 `node_modules/.bin/electrobun --help` 实测结果校准 `dev` 与 `build` 脚本，保证 `bun run dev` 一条命令即可拉起桌面窗口。)*

### 10.2 异常兜底与鲁棒性要求

1. **流式网络断连与 429/5xx 错误恢复：** 当 `Pi` 底层请求模型抛出鉴权失败、速率限制或网络中断时，严禁导致 Bun 主进程未捕获异常崩溃（全局注册 `process.on('unhandledRejection')` 安全日志兜底）。错误需捕获并转换为 `turn_error` 推送给前端，在当前对话轮底部渲染一行克制的红色微提示条及 `[ Retry ]` 按钮。
2. **窗口优雅退出：** 监听应用退出信号，逐一调用所有运行中 `ActivePiSession` 的 `abort()`，刷盘关闭 SQLite WAL 连接，清理未决子进程后再退出主进程。
3. **空工作区兜底：** 首次打开尚未添加任何本地文件夹时，默认在 `~/.kip/scratchpad/` 自动创建一个默认沙盒工作区并初始化选中，保证用户配置完 API Key 后无需先选文件夹就能直接发消息体验，随后随时可通过左上角切换至真实代码仓库。

### 10.3 交付禁止事项（Hard Prohibitions）

* **严禁留下 `TODO`、`FIXME`、`mockData` 或伪造的假流式 `setTimeout` 演示代码**——所有 RPC 接口必须真实接通 `Pi` SDK、SQLite 与文件系统。
* **严禁引入任何 Emoji 作为 UI 装饰图标**——所有界面图标必须 100% 使用 `lucide-react` 统一 `1.5px` 线宽矢量图标。
* **严禁使用高饱和度渐变色（如紫粉 AI 渐变字、霓虹发光边框）**——保持纯粹的纸墨极简工业设计克制感。

> **执行启动指令：** 阅读完本文档全部 10 个章节后，立即从 **Phase 1** 开始在当前目录初始化工程、安装依赖、核对 `electrobun` 与 `@mariozechner/pi-coding-agent` 类型定义，并一路自动化编码、测试、修复直至 **Phase 5** 全部打包验收通过后再向人类汇报最终成果。将以下**第 11 至第 14 节补充规范**直接追加到 `SPEC.md` 的最末尾。由于文档末尾采用**最高优先级覆盖声明（Override Clause）**，你无需回头手动修改前 10 节内容，本地 Agent 读取到最后会自动以此处的增量规则覆盖冲突项。

---

## 11. 补充覆盖规范：统一模型网关与 OpenAI-Compatible 优先策略（Override）

> **优先级声明：** 本节及后续第 11–14 节为增量修订条款，凡与前文第 1–10 节存在冲突之处，**一律以第 11–14 节为准**。

### 11.1 基于 `@mariozechner/pi-ai` 的可插拔模型注册表

严禁手写裸 `fetch` 对接各家大模型，统一使用 `Pi` 生态自带的底层多模型统一通信库 **`@mariozechner/pi-ai`** 作为唯一模型网关（该库原生内置统一的 `Model<Api>` 描述结构与 `openai-completions` / `openai-responses` 流式协议解析器，天然支持后续无缝扩展 Anthropic、Google Gemini、Bedrock 等任意协议而无需改动业务层）。

### 11.2 OpenAI-Compatible 优先落地（MVP 聚焦）

首期模型配置界面与底层适配器优先打通 **OpenAI-Compatible 通用协议**——只要目标服务兼容标准 OpenAI 接口格式（包括但不限于 OpenAI 官方、OpenRouter、DeepSeek、SiliconFlow、Groq、vLLM、Ollama、LiteLLM 等），填入三要素即可即插即用：

* **`Base URL`**（例如 `[https://api.openai.com/v1](https://api.openai.com/v1)` 或 `[https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)`）
* **`API Key`**（存入第 4.4 节定义的安全存储，本地 Ollama 等免鉴权服务允许留空）
* **`Model ID`**（支持手动输入任意模型 ID 字符串，并提供 `[ Fetch Models ]` 按钮自动请求 `${baseUrl}/models` 拉取候选列表）

### 11.3 面向扩展的 `ModelRegistry` 抽象（`src/bun/agent/model-registry.ts`）

设计简洁高内聚的 `ModelRegistry` 类，将数据库中的 `custom_providers` 记录动态映射为 `@mariozechner/pi-ai` 所需的 `Model` 对象并注入 `Pi` 的 `AgentSession`：

```typescript
export interface ProviderEndpointConfig {
  id: string;
  name: string;
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  baseUrl: string;
  models: Array<{
    id: string;
    displayName: string;
    contextWindow: number;
    maxOutputTokens: number;
    supportsVision: boolean;
    supportsReasoning: boolean;
  }>;
}

```

* 当前阶段 UI 默认激活 `openai-completions` 协议表单，同时在数据结构与下拉枚举中保留其他协议扩展槽位，确保未来新增原生协议只需配置映射，零重构成本。
* 提供 `[ Test Connection ]` 极简连通性校验按钮：发送一条 `max_tokens: 1` 的最小化流式探测请求，实时显示延迟毫秒数（如 `Connected · 184ms`）。

## 12. 本地数据导出与 S3 云端同步引擎（`src/bun/sync/`）

在 `src/bun/sync/` 目录下新增轻量级数据归档与云同步模块，完全复用 **Bun 原生内置的 `Bun.S3Client`（`bun` 内置 S3 API，零臃肿 AWS SDK 依赖）**，兼容 AWS S3、Cloudflare R2、MinIO、Backblaze B2 及阿里云 OSS。

### 12.1 目录扩充与核心模块

* `src/bun/sync/exporter.ts`：负责本地全量快照打包与恢复导入，以及单会话干净导出（导出为纯英文排版的 `.md` Markdown 文稿或 `.json` 原始结构）。
* `src/bun/sync/s3-sync.ts`：封装基于 `Bun.S3Client` 的增量同步与远端清单比对逻辑。

### 12.2 S3 同步协议与防冲突设计

1. **配置参数（存入设置面板 `Sync & Backup` 分页）：**
* `Endpoint`、`Region`、`Bucket`、`Key Prefix`（默认 `kip-sync/`）；`Access Key ID` 与 `Secret Access Key` 严禁明文落库，统一走 `keychain.ts` 加密存储。
* **安全底线：** API Keys 凭证文件（`credentials.enc`）**绝对禁止上传至 S3**；云端仅同步工作区元数据、设置偏好（不含密钥）、自定义 Provider 非敏感结构以及全部历史会话 `.jsonl` 文件。


2. **远端对象布局：**
```text
<prefix>/
├── manifest.json                         # 记录最后同步时间戳、设备标识及各文件 SHA-256 哈希与 updatedAt
├── metadata/
│   └── snapshot.json                     # SQLite 中 workspaces / threads / custom_providers / kv_settings 序列化快照
└── sessions/
    └── <workspaceId>/<threadId>.jsonl    # 按 SHA-256 哈希增量上传，未变动会话跳过传输

```


3. **同步触发策略：**
* 支持在 `Settings -> Sync` 或 `CommandPalette` (`Cmd/Ctrl + K` 输入 `Sync Now`) 一键手动触发双向同步，状态栏仅以微缩圆点呼吸动效静默展示进度。
* 开启自动同步开关后，每当单轮对话 `turn_complete` 结束且静置 `10s` 防抖后，后台异步执行增量 Push。
* 合并策略采用清晰的 **Last-Write-Wins (`updated_at` 时间戳比对)**，启动应用时自动拉取远端更新的会话与元数据无缝合并至本地 SQLite。



### 12.3 新增 RPC 接口契约（追加至 `src/shared/rpc-schema.ts`）

```typescript
// 追加至 KipRPCSchema['bun']['requests']：
exportThreadMarkdown: { params: { threadId: string }; response: { savedPath: string | null } };
exportFullBackupBundle: { params: void; response: { savedPath: string | null } };
importBackupBundle: { params: void; response: { importedThreads: number } };
getS3SyncConfig: {
  params: void;
  response: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    hasCredentials: boolean;
    lastSyncedAt: number | null;
  };
};
updateS3SyncConfig: {
  params: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  response: { connected: boolean; error?: string };
};
triggerS3Sync: { params: void; response: { pushed: number; pulled: number; syncedAt: number } };

```

## 13. 极简纯色应用图标设计规范（`assets/icons/`）

严禁生成花哨渐变、3D 拟物或复杂插画图标。由本地 Agent 直接通过代码编写精准几何比例的 **纯色极简矢量源图 `assets/icon.svg**`，并编写构建辅助脚本 `scripts/generate-icons.ts` 自动生成 Electrobun 多平台所需的图标资源（macOS `.icns` / Iconset、Windows `.ico`、Linux `.png` 及窗口托盘单色 Template Icon）：

* **图形语言（Monochrome Geometric Minimalism）：**
* **底板：** 标准 macOS 连续曲率圆角矩形（Squircle，`1024x1024` 画布，留出标准安全边距），纯墨黑实心底色 `#141416`（无渐变、无高光纹理）。
* **中心符号：** 一枚几何比例考究的纯暖白（`#FAF9F6`）极简“光隙 / 棱镜孔径（Kip Aperture）”——例如居中旋转 `45°` 的锋利菱形负空间或精准黄金分割比例的极简双几何切面，线条干净克制，缩放到 `16x16` 菜单栏尺寸依然清晰锐利、一眼可辨。



## 14. 全英文语境、代码品味与 Git 自动化工作流铁律

### 14.1 100% 纯英文工程铁律（English-Only Codebase & Copy）

* **界面文案全英文：** 应用内所有按钮、导航、占位符、空状态问候、设置项说明、错误提示、快捷键提示以及 `README.md` **一律使用地道、克制、洗练的现代英文**（例如用 `New Thread`、`Approval Policy`、`Compact Context`、`Synced just now`），严禁在源码或界面中混入任何中文字符。
* **注释与日志全英文：** 所有源码文件顶部的模块职责说明、JSDoc 注释、行内关键原理解释、单元测试描述、`console` 日志及异常堆栈信息**全部使用清晰简洁的英文编写**。注释只解释“Why（设计意图与边界考量）”，不写解释“What”的废话注释。

### 14.2 高扩展性极简代码架构（Clean & Extensible Code Style）

* **单一职责与短小文件：** 单个 `.ts` / `.tsx` 源文件严格控制在 **`250` 行以内**（复杂编排器上限不超过 `350` 行）；超出即按职责拆分为独立子模块，严禁出现上千行的上帝文件（God Object）。
* **面向接口解耦（Registry / Strategy Pattern）：** 模型供应商（`ModelRegistry`）、工具安全审计规则（`ToolPolicyRule`）、云同步后端（定义 `SyncProvider` 接口，当前提供 `S3SyncProvider` 实现，后续可零侵入挂载 WebDAV 或 Git Sync）均采用轻量接口抽象 + 依赖注入，保持极高的可维护性与扩展弹性。
* **严格类型与纯函数优先：** 全面启用 TypeScript `strict: true`、`noUnusedLocals: true`，杜绝 `any`；数据转换、Diff 解析、命令风险分级等核心逻辑全部写成无副作用纯函数，便于独立运行 `bun test`。

### 14.3 渐进式 Git Commit + Push 纪律

开发全过程必须保持清晰的 Git 演进历史，**严禁把所有代码憋到最后一次性大爆炸提交**：

1. **初始化检查：** 开始编码前先执行 `git status` 与 `git remote -v` 确认当前仓库分支与远端配置，并立即完善 `.gitignore`（确保忽略 `node_modules/`、`build/`、`dist/`、`.DS_Store`、`*.sqlite*`、`.env*`）。
2. **里程碑原子提交：** 每完成一个独立子模块或 Phase 里程碑（例如：`Phase 1 脚手架打通`、`SQLite 与 Keychain 完成`、`OpenAI-Compatible 模型注册表与 Pi 编排器打通`、`S3 同步与导出模块落地`、`Avenir Next 设计系统与主画布完工`、`图标生成与最终打包验收`），在确认 `bun run typecheck` 与 `bun test` 全部绿灯后，立即执行 `git add` 并提交。
3. **英文 Conventional Commits 规范：** Commit Message 一律采用小写英文标准前缀（如 `feat(agent): integrate pi-ai openai-compatible model registry`、`feat(sync): implement incremental s3 backup via bun s3 client`、`feat(ui): craft avenir next editorial thread canvas`）。
4. **即时推送远端：** 每次 `git commit` 完成后，若 `git remote` 已配置有效远端仓库地址，立即执行 `git push` 推送至当前远端分支（若遇网络瞬时抖动自动重试一次；若本地尚未绑定 `origin` 远端则保留完整本地原子提交链并在最终汇报中说明）。