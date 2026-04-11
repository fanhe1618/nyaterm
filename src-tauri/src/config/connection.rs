use super::{
    get_config_dir, load_app_settings, load_proxies, save_app_settings, save_json, save_proxies,
    uuid_v4, ProxyConfig, ProxySettings,
};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ── Connection type discriminator ───────────────────────────────────────────

/// Type-specific configuration for each connection kind.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionType {
    Ssh {
        host: String,
        #[serde(default = "default_ssh_port")]
        port: u16,
        #[serde(default = "default_ssh_user")]
        username: String,
    },
    LocalTerminal {
        #[serde(default)]
        shell_path: String,
        #[serde(default)]
        working_dir: Option<String>,
    },
    Telnet {
        host: String,
        #[serde(default = "default_telnet_port")]
        port: u16,
    },
    Serial {
        port_name: String,
        #[serde(default = "default_baud_rate")]
        baud_rate: u32,
        #[serde(default = "default_data_bits")]
        data_bits: u8,
        #[serde(default = "default_parity")]
        parity: String,
        #[serde(default = "default_stop_bits")]
        stop_bits: String,
    },
}

fn default_ssh_port() -> u16 {
    22
}
fn default_ssh_user() -> String {
    "root".to_string()
}
fn default_telnet_port() -> u16 {
    23
}
fn default_baud_rate() -> u32 {
    115_200
}
fn default_data_bits() -> u8 {
    8
}
fn default_parity() -> String {
    "none".to_string()
}
fn default_stop_bits() -> String {
    "1".to_string()
}

// ── Auth block ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionAuth {
    #[serde(default = "default_auth_mode")]
    pub mode: String,
    #[serde(default)]
    pub password_id: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub otp_id: Option<String>,
    #[serde(default)]
    pub auto_fill_otp: bool,
}

fn default_auth_mode() -> String {
    "password".to_string()
}

// ── Network block ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionNetwork {
    #[serde(default)]
    pub proxy_id: Option<String>,
}

// ── Saved connection ────────────────────────────────────────────────────────

/// Unified saved connection: common fields + type-discriminated config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    #[serde(default = "uuid_v4")]
    pub id: String,
    pub name: String,

    #[serde(flatten)]
    pub config: ConnectionType,

    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub icon: Option<String>,

    #[serde(default)]
    pub auth: Option<ConnectionAuth>,
    #[serde(default)]
    pub network: Option<ConnectionNetwork>,
}

/// Group for organizing saved connections in the UI.
/// Groups form a tree via `parent_id`; root groups have `parent_id = None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    #[serde(default = "uuid_v4")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

/// Root config for groups and saved connections (sessions.json).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionsConfig {
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub connections: Vec<SavedConnection>,
}

/// Alias for the main app config (sessions + groups).
pub type AppConfig = SessionsConfig;

// ── Loading / saving ────────────────────────────────────────────────────────

pub fn load_sessions(app: &AppHandle) -> AppResult<SessionsConfig> {
    let dir = get_config_dir(app)?;
    let path = dir.join("sessions.json");

    if !path.exists() {
        return Ok(SessionsConfig::default());
    }

    let content = std::fs::read_to_string(&path)?;
    let raw: serde_json::Value = serde_json::from_str(&content)?;

    let groups: Vec<Group> = raw
        .get("groups")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let raw_connections = raw
        .get("connections")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut connections = Vec::new();
    for raw_conn in raw_connections {
        if raw_conn.get("type").is_none() {
            tracing::warn!("Skipping unsupported legacy connection entry without type");
            continue;
        }

        match serde_json::from_value::<SavedConnection>(raw_conn) {
            Ok(conn) => connections.push(conn),
            Err(e) => tracing::warn!("Skipping malformed connection: {e}"),
        }
    }

    Ok(SessionsConfig {
        groups,
        connections,
    })
}

/// Saves sessions config to disk.
pub fn save_sessions(app: &AppHandle, config: &SessionsConfig) -> AppResult<()> {
    let dir = get_config_dir(app)?;
    save_json(&dir.join("sessions.json"), config)
}

/// Loads the main app config (sessions + groups).
/// Also runs one-time migrations.
pub fn load_config(app: &AppHandle) -> AppResult<AppConfig> {
    let mut cfg = load_sessions(app)?;

    migrate_global_proxy_to_connections(app, &mut cfg)?;
    migrate_connection_proxies_to_standalone(app, &mut cfg)?;

    Ok(cfg)
}

// ── Config migrations ───────────────────────────────────────────────────────

fn migrate_global_proxy_to_connections(app: &AppHandle, cfg: &mut SessionsConfig) -> AppResult<()> {
    let mut settings = load_app_settings(app)?;
    if !settings.proxy.enabled || cfg.connections.is_empty() {
        return Ok(());
    }

    let legacy_proxy = settings.proxy.clone();
    let mut migrated = false;

    let mut proxies = load_proxies(app).unwrap_or_default();
    let proxy_id = uuid::Uuid::new_v4().to_string();
    proxies.push(ProxyConfig {
        id: proxy_id.clone(),
        name: "Migrated Global Proxy".to_string(),
        protocol: legacy_proxy.protocol,
        host: legacy_proxy.host,
        port: legacy_proxy.port,
        username: None,
        password: None,
    });

    for conn in &mut cfg.connections {
        let has_proxy = conn.network.as_ref().is_some_and(|n| n.proxy_id.is_some());
        if !has_proxy {
            let net = conn.network.get_or_insert_with(ConnectionNetwork::default);
            net.proxy_id = Some(proxy_id.clone());
            migrated = true;
        }
    }

    if migrated {
        save_proxies(app, &proxies)?;
        save_sessions(app, cfg)?;
    }

    settings.proxy = ProxySettings::default();
    save_app_settings(app, &settings)?;

    tracing::info!("Migrated legacy global proxy settings to per-connection proxy configs");
    Ok(())
}

fn migrate_connection_proxies_to_standalone(
    _app: &AppHandle,
    _cfg: &mut SessionsConfig,
) -> AppResult<()> {
    // Legacy `network.proxy` inline objects are no longer present in the new format.
    // The old migration already ran before this format change, so nothing to do.
    Ok(())
}

/// Loads a single connection by ID.
///
/// Returns `AppError::SessionNotFound` if no connection with that ID exists.
pub fn load_connection_by_id(app: &AppHandle, id: &str) -> AppResult<SavedConnection> {
    let cfg = load_config(app)?;
    let conn = cfg
        .connections
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::SessionNotFound(format!("Connection '{}' not found", id)))?;
    Ok(conn)
}

/// Saves the main app config.
pub fn save_config(app: &AppHandle, config: &AppConfig) -> AppResult<()> {
    save_sessions(app, config)
}
