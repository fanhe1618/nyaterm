/** Type of terminal session: SSH remote or local shell. */
export type SessionType = "SSH" | "Local";

/** Metadata for a connected or disconnected session. */
export interface SessionInfo {
  id: string;
  name: string;
  session_type: SessionType;
  connected: boolean;
}

/** UI tab representing a terminal session. */
export interface Tab {
  id: string;
  sessionId: string;
  name: string;
  type: SessionType;
  connectionId?: string;
  /** True while the backend session is being established. XTerminal is not rendered yet. */
  connecting?: boolean;
}

/** SSH connection config for creating a session. */
export interface SshConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
}

/** SSH authentication: password or private key (PEM content). */
export type SshAuth =
  | { type: "password"; password: string }
  | { type: "key"; key_data: string; passphrase?: string };

/** Group for organizing saved connections. Groups form a tree via parent_id. */
export interface Group {
  id: string;
  name: string;
  parent_id?: string;
  sort_order: number;
}

/** Managed SSH private key stored in keys.json. */
export interface SshKey {
  id: string;
  name: string;
  /** True when encrypted key data exists on disk. */
  has_key_data?: boolean;
  /** Transient: file path from the UI file picker. */
  key_file_path?: string;
  /** Passphrase for this key (only sent when creating/updating). */
  passphrase?: string;
}

/** Stored SSH connection with host, auth, and optional group. */
export interface SavedConnection {
  id: string;
  name: string;
  group_id?: string;
  description?: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password?: string;
  /** References a managed SSH key by id. */
  key_id?: string;
  sort_order?: number;
  /** Icon key referencing a named icon from QUICK_ICONS (e.g. "docker", "ubuntu"). */
  icon?: string;
}

/** Saved tab state for startup restoration. */
export interface RestorableTab {
  title: string;
  session_type: string;
  connection_id?: string;
}

export type PanelId = "fileExplorer" | "fileTransfer" | "savedConnections" | "activeSessions" | "commandHistory";

export interface PanelLayout {
  left: PanelId[];
  right: PanelId[];
}

/** Layout preferences: panel widths, visibility flags, theme. */
export interface UiConfig {
  open_tabs: RestorableTab[];
  left_width: number;
  right_width: number;
  saved_conn_height: number;
  history_height: number;
  quick_cmd_height: number;
  file_transfer_height: number;
  show_file_explorer: boolean;
  show_file_transfer: boolean;
  show_saved_connections: boolean;
  show_active_sessions: boolean;
  show_command_history: boolean;
  show_quick_commands: boolean;
  zoom_level: number;
  language?: string;
  panel_layout: PanelLayout;
  show_remote_stats: boolean;
  saved_connections_sort_mode?: string;
}

/** Resource usage stats fetched from the active remote SSH host. */
export interface RemoteStats {
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
}

/** Labeled command shortcut for quick execution. */
export interface QuickCommandCategory {
  id: string;
  name: string;
}

export interface QuickCommand {
  id: string;
  label: string;
  command: string;
  category_id?: string;
  description?: string;
  color_tag?: string;
  icon_tag?: string;
  pinned?: boolean;
  execution_mode?: string;
}

export interface QuickCommandsConfig {
  commands: QuickCommand[];
  categories: QuickCommandCategory[];
}

/** Fuzzy search result with matched command and highlight indices. */
export interface FuzzyResult {
  command: string;
  score: number;
  indices: number[];
  /** Provider tag: "history" | "quickCommand" | future sources. */
  source: string;
  /** Text shown in the suggestion panel (may differ from command). */
  display: string;
}

export interface GeneralSettings {
  startup_restore: boolean;
  default_local_shell: string;
  minimize_to_tray: boolean;
  boss_key: string | null;
}

export interface AppearanceSettings {
  theme: string;
  font_family: string;
  font_size: number;
  ligatures: boolean;
  background_opacity: number;
  cursor_style: string;
  cursor_blink: boolean;
  ui_font_size: number;
}

export interface ProxySettings {
  enabled: boolean;
  protocol: string;
  host: string;
  port: number;
}

export interface SearchEngine {
  name: string;
  url_template: string;
  icon?: string;
}

export interface SearchSettings {
  custom_engines: SearchEngine[];
}

export interface TranslationSettings {
  target_language: string;
  deepl_api_key: string;
  baidu_app_id: string;
  baidu_app_key: string;
  ali_app_id: string;
  ali_app_key: string;
  youdao_app_id: string;
  youdao_app_key: string;
}

export interface TranslateResult {
  original: string;
  translated: string;
  detected_language: string;
  provider: string;
}

export interface SecuritySettings {
  use_os_keyring: boolean;
  require_master_password: boolean;
  enable_screen_lock: boolean;
  idle_lock_minutes: number;
  lock_password?: string;
  host_key_policy: string;
}

export interface TerminalSettings {
  scrollback_lines: number;
  keep_alive_interval: number;
  hardware_acceleration: boolean;
}

export interface InteractionSettings {
  copy_on_select: boolean;
  right_click_paste: boolean;
  word_separators: string;
  default_encoding: string;
}

export interface AppSettings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  proxy: ProxySettings;
  search: SearchSettings;
  translation: TranslationSettings;
  security: SecuritySettings;
  terminal: TerminalSettings;
  interaction: InteractionSettings;
  ui: UiConfig;
}
