import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "../lib/invoke";
import { logger } from "../lib/logger";
import type { AppSettings, Group, SavedConnection, SessionType, Tab, UiConfig } from "../types";

interface AppContextType {
  // Tabs
  tabs: Tab[];
  activeTabId: string | null;
  setActiveTabId: (id: string | null) => void;
  addTab: (sessionId: string, name: string, type: SessionType, connectionId?: string) => void;
  closeTab: (tabId: string) => void;

  // UI Config
  uiConfig: UiConfig;
  updateUiConfig: (updates: Partial<UiConfig>) => void;

  // App Settings
  appSettings: AppSettings;
  updateAppSettings: (updates: Partial<AppSettings>) => void;

  // Data
  savedConnections: SavedConnection[];
  savedGroups: Group[];
  refreshConnections: () => Promise<void>;

  // Dialogs
  showNewSession: boolean;
  setShowNewSession: (show: boolean) => void;
  editingConnection: SavedConnection | undefined;
  setEditingConnection: (conn: SavedConnection | undefined) => void;
  showSettingsDialog: boolean;
  setShowSettingsDialog: (show: boolean) => void;

  // Idle Lock
  isLocked: boolean;
  setIsLocked: (locked: boolean) => void;
}

/**
 * App-wide state: tabs, UI config (debounced save), saved connections (polled),
 * and dialog visibility. Updates via setState/useCallback; config persisted to backend.
 */
const AppContext = createContext<AppContextType | null>(null);

const DEFAULT_UI_CONFIG: UiConfig = {
  open_tabs: [],
  left_width: 256,
  right_width: 288,
  saved_conn_height: 240,
  history_height: 200,
  quick_cmd_height: 36,
  file_transfer_height: 240,
  show_file_explorer: true,
  show_file_transfer: true,
  show_saved_connections: true,
  show_active_sessions: true,
  show_command_history: true,
  show_quick_commands: true,
  zoom_level: 1.0,
  language: "en",
};

const DEFAULT_APP_SETTINGS: AppSettings = {
  general: {
    startup_restore: true,
    default_local_shell: navigator.userAgent.includes("Win") ? "powershell.exe" : "bash",
    minimize_to_tray: false,
    boss_key: null,
  },
  appearance: {
    theme: "github-dark",
    font_family: "JetBrains Mono, Fira Code, Consolas, monospace",
    font_size: 14,
    ligatures: false,
    background_opacity: 1.0,
    cursor_style: "block",
    cursor_blink: true,
  },
  proxy: {
    enabled: false,
    protocol: "socks5",
    host: "127.0.0.1",
    port: 1080,
  },
  search: {
    default_engine: "google",
    custom_engines: [
      { name: "Google", url_template: "https://google.com/search?q=%s" },
      { name: "Bing", url_template: "https://bing.com/search?q=%s" },
      { name: "GitHub", url_template: "https://github.com/search?q=%s" },
    ],
  },
  translation: {
    provider: "deepl",
    api_key: "",
  },
  security: {
    use_os_keyring: true,
    require_master_password: false,
    idle_lock_minutes: 0,
    host_key_policy: "prompt",
  },
  terminal: {
    scrollback_lines: 10000,
    keep_alive_interval: 60,
    hardware_acceleration: false,
  },
  interaction: {
    copy_on_select: true,
    right_click_paste: true,
    word_separators: " ()[]{}\"'",
    default_encoding: "UTF-8",
  },
};

/** Provides tabs, uiConfig, savedConnections, and dialog state to the app. */
export function AppProvider({ children }: { children: ReactNode }) {
  // Tabs State
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // UI Config State
  const [uiConfig, setUiConfig] = useState<UiConfig>(DEFAULT_UI_CONFIG);
  const uiConfigLoaded = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // App Settings State
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const appSettingsLoaded = useRef(false);
  const appSettingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Data State
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [savedGroups, setSavedGroups] = useState<Group[]>([]);

  // Dialog State
  const [showNewSession, setShowNewSession] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | undefined>(
    undefined,
  );
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);

  // Idle Lock State
  const [isLocked, setIsLocked] = useState(false);
  // 1. Load UI Config
  useEffect(() => {
    invoke<UiConfig>("get_ui_config")
      .then((cfg) => {
        setUiConfig(cfg);
        uiConfigLoaded.current = true;
      })
      .catch(() => {
        uiConfigLoaded.current = true;
      });
  }, []);

  // 1.5. Load App Settings
  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then((cfg) => {
        setAppSettings(cfg);
        appSettingsLoaded.current = true;
      })
      .catch(() => {
        appSettingsLoaded.current = true;
      });
  }, []);

  // 2. Save UI Config Debounced
  const updateUiConfig = useCallback((updates: Partial<UiConfig>) => {
    setUiConfig((prev) => {
      const next = { ...prev, ...updates };
      // Debounce save
      if (uiConfigLoaded.current) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          invoke("save_ui_config", { config: next }).catch((e) =>
            logger.error("Failed to save UI config", e),
          );
        }, 500);
      }
      return next;
    });
  }, []);

  // 2.5 Save App Settings Debounced
  const updateAppSettings = useCallback((updates: Partial<AppSettings>) => {
    setAppSettings((prev) => {
      const next = { ...prev, ...updates };
      if (appSettingsLoaded.current) {
        if (appSettingsSaveTimerRef.current) clearTimeout(appSettingsSaveTimerRef.current);
        appSettingsSaveTimerRef.current = setTimeout(() => {
          invoke("save_app_settings", { settings: next }).catch((e) =>
            logger.error("Failed to save app settings", e),
          );
        }, 500);
      }
      return next;
    });
  }, []);

  // 3. Load Connections
  const refreshConnections = useCallback(async () => {
    try {
      const [saved, groups] = await Promise.all([
        invoke<SavedConnection[]>("get_saved_connections"),
        invoke<Group[]>("get_groups"),
      ]);
      setSavedConnections(saved);
      setSavedGroups(groups);
    } catch (e) {
      logger.error("Failed to fetch connections", e);
    }
  }, []);

  useEffect(() => {
    refreshConnections();
    const interval = setInterval(refreshConnections, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, [refreshConnections]);

  // 4. Tab Logic
  const addTab = useCallback(
    (sessionId: string, name: string, type: SessionType, connectionId?: string) => {
      const tabId = `tab-${Date.now()}`;
      const newTab: Tab = { id: tabId, sessionId, name, type, connectionId };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);

      // Close dialogs when session starts
      setShowNewSession(false);
      setEditingConnection(undefined);
    },
    [],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId) {
          if (newTabs.length > 0) {
            setActiveTabId(newTabs[newTabs.length - 1].id);
          } else {
            setActiveTabId(null);
          }
        }
        return newTabs;
      });
    },
    [activeTabId],
  );
  // 5. Startup Restore Logic
  const hasRestored = useRef(false);

  useEffect(() => {
    if (!hasRestored.current && uiConfigLoaded.current && appSettingsLoaded.current) {
      hasRestored.current = true;
      if (
        appSettings.general.startup_restore &&
        uiConfig.open_tabs &&
        uiConfig.open_tabs.length > 0
      ) {
        uiConfig.open_tabs.forEach((tab) => {
          if (tab.session_type === "SSH" && tab.connection_id) {
            invoke<string>("create_ssh_session", { connectionId: tab.connection_id })
              .then((sessionId) => {
                addTab(sessionId, tab.title, "SSH", tab.connection_id);
              })
              .catch((e) => logger.error(`Restore SSH failed for ${tab.title}`, e));
          } else if (tab.session_type === "Local" || tab.session_type === "local") {
            invoke<string>("create_local_session")
              .then((sessionId) => {
                addTab(sessionId, tab.title, "Local");
              })
              .catch((e) => logger.error(`Restore Local failed`, e));
          }
        });
      }
    }
  }, [uiConfig, appSettings, addTab]);

  // 6. Sync opened tabs
  useEffect(() => {
    if (hasRestored.current && appSettings.general.startup_restore) {
      updateUiConfig({
        open_tabs: tabs.map((t) => ({
          title: t.name,
          session_type: t.type,
          connection_id: t.connectionId,
        })),
      });
    }
  }, [tabs, appSettings.general.startup_restore, updateUiConfig]);

  return (
    <AppContext.Provider
      value={{
        tabs,
        activeTabId,
        setActiveTabId,
        addTab,
        closeTab,
        uiConfig,
        updateUiConfig,
        appSettings,
        updateAppSettings,
        savedConnections,
        savedGroups,
        refreshConnections,
        showNewSession,
        setShowNewSession,
        editingConnection,
        setEditingConnection,
        showSettingsDialog,
        setShowSettingsDialog,
        isLocked,
        setIsLocked,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

/** Hook to access AppContext. Throws if used outside AppProvider. */
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}
