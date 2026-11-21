/** Chrome, theme, preferences, and palette state. */
import { create } from "zustand";
import type {
  ApprovalPolicy,
  ProviderRecord,
  SettingsSnapshot,
  ThemeMode,
  ThinkingLevel,
  UpdateStatus,
} from "../../shared/types";
import { request } from "../rpc-client";

type SettingsTab = "providers" | "plugins" | "appearance" | "safety" | "sync";

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
  /** Last known update check result; null until the first reply arrives. */
  update: UpdateStatus | null;
  /** Unsent composer text per thread; NEW_THREAD_DRAFT holds text before a thread exists. */
  drafts: Record<string, string>;
  setDraft: (key: string, draft: string) => void;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  setApprovalPolicy: (policy: ApprovalPolicy) => Promise<void>;
  setDefaultThinking: (level: ThinkingLevel) => Promise<void>;
  toggleSidebar: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setCommandOpen: (open: boolean) => void;
  setSyncState: (state: "idle" | "running" | "error", message?: string) => void;
  setWindowMaximized: (maximized: boolean) => void;
  setUpdate: (update: UpdateStatus) => void;
  openUpdatePage: () => Promise<void>;
  restartForUpdate: () => Promise<void>;
}

function resolvedTheme(theme: ThemeMode): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = resolvedTheme(theme);
  document.documentElement.style.colorScheme = resolvedTheme(theme);
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
  drafts: {},

  setDraft: (key, draft) =>
    set((state) => {
      const drafts = { ...state.drafts };
      if (draft) drafts[key] = draft;
      else delete drafts[key];
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
    const update = await request("getUpdateStatus", undefined);
    set({ update });
    if (!systemListenerAttached) {
      systemListenerAttached = true;
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => {
          if (get().theme === "system") applyTheme("system");
        });
    }
  },

  refresh: async () => {
    const settings = await request("getSettings", undefined);
    set({ settings, theme: settings.theme, sidebarCollapsed: settings.sidebarCollapsed });
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

  setSyncState: (syncState, syncMessage) => set({ syncState, syncMessage: syncMessage ?? null }),

  setWindowMaximized: (windowMaximized) => set({ windowMaximized }),

  setUpdate: (update) => set({ update }),

  openUpdatePage: async () => {
    await request("openUpdatePage", undefined);
  },

  restartForUpdate: async () => {
    await request("restartForUpdate", undefined);
  },
}));
