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

/** Group for organizing saved connections. */
export interface Group {
  id: string;
  name: string;
  sort_order: number;
}

/** Stored SSH connection with host, auth, and optional group. */
export interface SavedConnection {
  id: string;
  name: string;
  group?: string;
  description?: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password?: string;
  passphrase?: string;
  /** File path selected via the file picker — backend reads and encrypts. */
  key_file_path?: string;
  /** True when an encrypted private key is already stored on disk. */
  has_key_data?: boolean;
}

/** Saved tab state for startup restoration. */
export interface RestorableTab {
  title: string;
  session_type: string;
  connection_id?: string;
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
}

/** Labeled command shortcut for quick execution. */
export interface QuickCommand {
  id: string;
  label: string;
  command: string;
  category?: string;
  description?: string;
  color_tag?: string;
  icon_tag?: string;
  pinned?: boolean;
  execution_mode?: string;
}

/** Fuzzy search result with matched command and highlight indices. */
export interface FuzzyResult {
  command: string;
  score: number;
  indices: number[];
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
}

export interface SearchSettings {
  default_engine: string;
  custom_engines: SearchEngine[];
}

export interface TranslationSettings {
  provider: string;
  api_key: string;
}

export interface SecuritySettings {
  use_os_keyring: boolean;
  require_master_password: boolean;
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
}
