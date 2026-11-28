/** Chrome, theme, preferences, and palette state. */
import { create } from "zustand";
import type {
  ApprovalPolicy,
  CliTuiLayout,
  ProviderRecord,
  SettingsSnapshot,
  ThemeMode,
  ThinkingLevel,
  UpdateStatus,
} from "../../shared/types";
import { request } from "../rpc-client";
import { applyTheme, watchSystemTheme } from "../lib/theme";

type SettingsTab =
  "providers" | "plugins" | "appearance" | "safety" | "tui" | "sync";

interface UiState {
  settings: SettingsSnapshot | null;
  providers: ProviderRecord[];
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  commandOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  syncState: "idle" | "running" | "error";
  syncMessage: string | null;
  /** Maximized state of the window, for the in-app buttons off macOS. */
  windowMaximized: boolean;
  /** Last known update status; null until the first reply arrives. */
  update: UpdateStatus | null;
  /** True while frontend state is flushing to `update-handoff.json` before exit. */
  updateFlushing: boolean;
  /** Transient notice when a restart is deferred or an update check fails. */
  updateNotice: string | null;
  /** Unsent composer text per thread; NEW_THREAD_DRAFT holds text before a thread exists. */
  drafts: Record<string, string>;
  setDraft: (key: string, draft: string) => void;
  restoreDrafts: (drafts: Record<string, string>) => void;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  setApprovalPolicy: (policy: ApprovalPolicy) => Promise<void>;
  setDefaultThinking: (level: ThinkingLevel) => Promise<void>;
  setCliTuiLayout: (layout: CliTuiLayout) => Promise<void>;
  toggleSidebar: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setCommandOpen: (open: boolean) => void;
  setSyncState: (state: "idle" | "running" | "error", message?: string) => void;
  setWindowMaximized: (maximized: boolean) => void;
  setUpdate: (update: UpdateStatus) => void;
  setUpdateFlushing: (flushing: boolean) => void;
  setUpdateNotice: (notice: string | null) => void;
}

let systemListenerAttached = false;

export const NEW_THREAD_DRAFT = "__new__";

export const useUiStore = create<UiState>((set, get) => ({
  settings: null,
  providers: [],
  theme: "system",
  sidebarCollapsed: false,
  commandOpen: false,
  settingsOpen: false,
  settingsTab: "providers",
  syncState: "idle",
  syncMessage: null,
  windowMaximized: false,
  update: null,
  updateFlushing: false,
  updateNotice: null,
  drafts: {},

  setDraft: (key, draft) =>
    set((state) => {
      const drafts = { ...state.drafts };
      if (draft) drafts[key] = draft;
      else delete drafts[key];
      return { drafts };
    }),

  restoreDrafts: (incoming) =>
    set((state) => {
      const drafts = { ...state.drafts };
      for (const [key, value] of Object.entries(incoming)) {
        if (typeof value === "string" && value.length > 0) {
          drafts[key] = value;
        }
      }
      return { drafts };
    }),

  initialize: async () => {
    const settings = await request("getSettings", undefined);
    applyTheme(settings.theme);
    set({
      settings,
      theme: settings.theme,
      sidebarCollapsed: settings.sidebarCollapsed,
    });
    const providers = await request("listProviders", undefined);
    set({ providers });
    // The first check may finish before the view exists; ask once on boot.
    const update = await request("updaterGetStatus", undefined);
    set({ update });
    if (!systemListenerAttached) {
      systemListenerAttached = true;
      watchSystemTheme(() => get().theme);
    }
  },

  refresh: async () => {
    const settings = await request("getSettings", undefined);
    set({
      settings,
      theme: settings.theme,
      sidebarCollapsed: settings.sidebarCollapsed,
    });
    applyTheme(settings.theme);
  },

  refreshProviders: async () => {
    const providers = await request("listProviders", undefined);
    set({ providers });
  },

  setTheme: async (theme) => {
    set({ theme });
    applyTheme(theme);
    const settings = await request("updateSettings", { theme });
    set({ settings });
    await get().refreshProviders();
  },

  setApprovalPolicy: async (approvalPolicy) => {
    const settings = await request("updateSettings", { approvalPolicy });
    set({ settings });
  },

  setDefaultThinking: async (defaultThinkingLevel) => {
    const settings = await request("updateSettings", { defaultThinkingLevel });
    set({ settings });
  },

  setCliTuiLayout: async (cliTuiLayout) => {
    const settings = await request("updateSettings", { cliTuiLayout });
    set({ settings });
  },

  toggleSidebar: async () => {
    const sidebarCollapsed = !get().sidebarCollapsed;
    set({ sidebarCollapsed });
    const settings = await request("updateSettings", { sidebarCollapsed });
    set({ settings });
  },

  openSettings: (tab) => {
    set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab });
    void get().refreshProviders();
  },

  closeSettings: () => set({ settingsOpen: false }),

  setCommandOpen: (open) => set({ commandOpen: open }),

  setSyncState: (syncState, syncMessage) =>
    set({ syncState, syncMessage: syncMessage ?? null }),

  setWindowMaximized: (windowMaximized) => set({ windowMaximized }),

  setUpdate: (update) => set({ update }),

  setUpdateFlushing: (updateFlushing) => set({ updateFlushing }),

  setUpdateNotice: (updateNotice) => set({ updateNotice }),
}));
