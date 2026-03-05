use crate::config;
use crate::error::{AppError, AppResult};
use crate::fuzzy::{fuzzy_search_items, FuzzyResult};
use crate::pty;
use crate::session::{SessionCommand, SessionInfo, SessionManager};
use crate::ssh::{self, SshAuth, SshConfig};
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
pub async fn create_ssh_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    connection_id: String,
) -> AppResult<String> {
    let conn = config::load_connection_by_id(&app, &connection_id)?;

    let auth = match conn.auth_type.as_str() {
        "password" => SshAuth::Password {
            password: conn.password.ok_or_else(|| {
                AppError::Auth(
                    "No password saved for this connection. Please edit and re-save it."
                        .to_string(),
                )
            })?,
        },
        "key" => {
            let key_id = conn.key_id.as_deref().ok_or_else(|| {
                AppError::Auth("No SSH key assigned to this connection.".to_string())
            })?;
            let ssh_key = config::load_key_by_id(&app, key_id)?;
            let key_data = config::decrypt_key_pem(&ssh_key)?.ok_or_else(|| {
                AppError::Auth("No private key data stored for the assigned key.".to_string())
            })?;
            SshAuth::Key {
                key_data,
                passphrase: ssh_key.passphrase,
            }
        }
        other => return Err(AppError::Auth(format!("Unknown auth type: {}", other))),
    };

    let ssh_config = SshConfig {
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        auth,
    };

    ssh::create_ssh_session(app, state.inner().clone(), ssh_config).await
}

#[tauri::command]
pub async fn create_local_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
) -> AppResult<String> {
    pty::create_local_session(app, state.inner().clone()).await
}

#[tauri::command]
pub async fn write_to_session(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    state
        .send_command(&session_id, SessionCommand::Write(data.into_bytes()))
        .await
}

#[tauri::command]
pub async fn resize_session(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    state
        .send_command(&session_id, SessionCommand::Resize { cols, rows })
        .await
}

#[tauri::command]
pub async fn attach_session(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> AppResult<()> {
    state
        .send_command(&session_id, SessionCommand::Attach)
        .await
}

#[tauri::command]
pub async fn close_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> AppResult<()> {
    let session_id_clone = session_id.clone();

    let res = state.send_command(&session_id, SessionCommand::Close).await;

    // Concurrently tidy up any downloaded/watcher temporary files stored in the OS temp directory
    tauri::async_runtime::spawn(async move {
        if let Ok(temp_dir) = app.path().temp_dir() {
            let session_temp_dir = temp_dir.join("dragonfly").join(&session_id_clone);
            if session_temp_dir.exists() {
                if let Err(e) = tokio::fs::remove_dir_all(&session_temp_dir).await {
                    tracing::warn!(
                        "Failed to clean up temp directory {}: {}",
                        session_temp_dir.display(),
                        e
                    );
                } else {
                    tracing::info!(
                        "Successfully cleaned up temp directory for session: {}",
                        session_id_clone
                    );
                }
            }
        }
    });

    res
}

#[tauri::command]
pub async fn list_sessions(
    state: tauri::State<'_, Arc<SessionManager>>,
) -> AppResult<Vec<SessionInfo>> {
    Ok(state.list_sessions().await)
}

#[tauri::command]
pub async fn add_command_history(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    command: String,
) -> AppResult<()> {
    state.add_command(&session_id, command).await;
    Ok(())
}

#[tauri::command]
pub async fn get_command_history(
    state: tauri::State<'_, Arc<SessionManager>>,
) -> AppResult<Vec<String>> {
    Ok(state.get_all_history().await)
}

#[tauri::command]
pub async fn fuzzy_search_history(
    state: tauri::State<'_, Arc<SessionManager>>,
    pattern: String,
    limit: usize,
) -> AppResult<Vec<FuzzyResult>> {
    Ok(state.fuzzy_search(&pattern, limit).await)
}

#[tauri::command]
pub fn fuzzy_search_commands(
    app: tauri::AppHandle,
    pattern: String,
    limit: usize,
) -> AppResult<Vec<FuzzyResult>> {
    let cfg = config::load_quick_commands(&app)?;
    let items: Vec<(String, String)> = cfg
        .commands
        .into_iter()
        .map(|c| (c.label, c.command))
        .collect();
    Ok(fuzzy_search_items(&items, &pattern, "quickCommand", limit))
}
