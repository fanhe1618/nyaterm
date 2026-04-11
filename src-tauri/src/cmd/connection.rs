use crate::config::{self, Group, QuickCommandsConfig, SavedConnection, SavedPassword, SshKey};
use crate::error::{AppError, AppResult};
use crate::utils::crypto;
use tauri::Emitter;

#[tauri::command]
pub fn get_saved_connections(app: tauri::AppHandle) -> AppResult<Vec<SavedConnection>> {
    let cfg = config::load_config(&app)?;
    Ok(cfg.connections)
}

#[tauri::command]
pub fn save_connection(
    app: tauri::AppHandle,
    mut connection: SavedConnection,
) -> AppResult<String> {
    let mut cfg = config::load_config(&app)?;

    if connection.id.is_empty() {
        connection.id = uuid::Uuid::new_v4().to_string();
    }
    let target_id = connection.id.clone();
    let existing = cfg.connections.iter().find(|c| c.id == target_id);

    // Preserve existing password_id if not provided
    if let Some(ref mut auth) = connection.auth {
        if auth.password_id.is_none() {
            auth.password_id = existing
                .and_then(|e| e.auth.as_ref())
                .and_then(|a| a.password_id.clone());
        }
    }

    if let Some(ex) = cfg.connections.iter_mut().find(|c| c.id == target_id) {
        *ex = connection;
    } else {
        cfg.connections.push(connection);
    }
    config::save_config(&app, &cfg)?;
    let _ = app.emit("connections-changed", ());
    Ok(target_id)
}

#[tauri::command]
pub fn delete_connection(app: tauri::AppHandle, id: String) -> AppResult<()> {
    let mut cfg = config::load_config(&app)?;
    cfg.connections.retain(|c| c.id != id);
    config::save_config(&app, &cfg)?;
    let _ = app.emit("connections-changed", ());
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct SortOrderUpdate {
    pub id: String,
    pub sort_order: i32,
}

#[tauri::command]
pub fn reorder_items(
    app: tauri::AppHandle,
    connections: Vec<SortOrderUpdate>,
    groups: Vec<SortOrderUpdate>,
) -> AppResult<()> {
    let mut cfg = config::load_config(&app)?;
    for update in &connections {
        if let Some(conn) = cfg.connections.iter_mut().find(|c| c.id == update.id) {
            conn.sort_order = update.sort_order;
        }
    }
    for update in &groups {
        if let Some(grp) = cfg.groups.iter_mut().find(|g| g.id == update.id) {
            grp.sort_order = update.sort_order;
        }
    }
    config::save_config(&app, &cfg)?;
    let _ = app.emit("connections-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_ssh_keys(app: tauri::AppHandle) -> AppResult<Vec<SshKey>> {
    let mut cfg = config::load_keys(&app)?;
    for k in &mut cfg.keys {
        k.key = None;
        k.passphrase = None;
    }
    Ok(cfg.keys)
}

#[tauri::command]
pub fn get_ssh_key_passphrase(app: tauri::AppHandle, id: String) -> AppResult<Option<String>> {
    Ok(config::load_key_by_id(&app, &id)?.passphrase)
}

#[tauri::command]
pub fn save_ssh_key(app: tauri::AppHandle, mut key: SshKey) -> AppResult<String> {
    let mut cfg = config::load_keys(&app)?;

    if key.id.is_empty() {
        key.id = uuid::Uuid::new_v4().to_string();
    }
    let target_id = key.id.clone();
    let existing = cfg.keys.iter().find(|k| k.id == target_id);

    key.key = match key.key_file_path.as_deref() {
        Some(path) if !path.is_empty() => {
            let content = std::fs::read_to_string(path)
                .map_err(|e| AppError::Config(format!("failed to read key file: {e}")))?;
            Some(crypto::encrypt(&content)?)
        }
        _ => existing.and_then(|e| e.key.clone()),
    };

    key.passphrase = match key.passphrase.as_deref() {
        Some(plain) if !plain.is_empty() => Some(crypto::encrypt(plain)?),
        Some("") => None,
        _ => existing.and_then(|e| e.passphrase.clone()),
    };

    if let Some(ex) = cfg.keys.iter_mut().find(|k| k.id == target_id) {
        *ex = key;
    } else {
        cfg.keys.push(key);
    }
    config::save_keys(&app, &cfg)?;
    Ok(target_id)
}

#[tauri::command]
pub fn delete_ssh_key(app: tauri::AppHandle, id: String) -> AppResult<()> {
    let mut cfg = config::load_keys(&app)?;
    cfg.keys.retain(|k| k.id != id);
    config::save_keys(&app, &cfg)
}

#[tauri::command]
pub fn get_groups(app: tauri::AppHandle) -> AppResult<Vec<Group>> {
    let cfg = config::load_config(&app)?;
    Ok(cfg.groups)
}

#[tauri::command]
pub fn save_group(app: tauri::AppHandle, mut group: Group) -> AppResult<String> {
    let mut cfg = config::load_config(&app)?;

    if group.id.is_empty() {
        group.id = uuid::Uuid::new_v4().to_string();
    }
    let target_id = group.id.clone();

    if let Some(existing) = cfg.groups.iter_mut().find(|g| g.id == target_id) {
        *existing = group;
    } else {
        cfg.groups.push(group);
    }
    config::save_config(&app, &cfg)?;
    let _ = app.emit("connections-changed", ());
    Ok(target_id)
}

#[tauri::command]
pub fn delete_group(app: tauri::AppHandle, id: String) -> AppResult<()> {
    let mut cfg = config::load_config(&app)?;

    // Collect the target group and all descendant groups
    let mut ids_to_remove = vec![id.clone()];
    let mut i = 0;
    while i < ids_to_remove.len() {
        let parent = ids_to_remove[i].clone();
        for g in &cfg.groups {
            if g.parent_id.as_deref() == Some(&parent) && !ids_to_remove.contains(&g.id) {
                ids_to_remove.push(g.id.clone());
            }
        }
        i += 1;
    }

    cfg.groups.retain(|g| !ids_to_remove.contains(&g.id));

    for conn in &mut cfg.connections {
        if let Some(ref gid) = conn.group_id {
            if ids_to_remove.contains(gid) {
                conn.group_id = None;
            }
        }
    }

    config::save_config(&app, &cfg)?;
    let _ = app.emit("connections-changed", ());
    Ok(())
}

#[tauri::command]
pub fn clear_all_connections(app: tauri::AppHandle) -> AppResult<()> {
    let mut cfg = config::load_config(&app)?;
    cfg.connections.clear();
    cfg.groups.clear();
    config::save_config(&app, &cfg)?;
    let _ = app.emit("connections-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_quick_commands(app: tauri::AppHandle) -> AppResult<QuickCommandsConfig> {
    config::load_quick_commands(&app)
}

#[tauri::command]
pub fn save_quick_commands(app: tauri::AppHandle, config: QuickCommandsConfig) -> AppResult<()> {
    crate::config::save_quick_commands(&app, &config)
}

// --- Password management ---

#[tauri::command]
pub fn get_saved_passwords(app: tauri::AppHandle) -> AppResult<Vec<SavedPassword>> {
    let mut cfg = config::load_passwords(&app)?;
    for p in &mut cfg.passwords {
        p.password = None;
    }
    Ok(cfg.passwords)
}

#[tauri::command]
pub fn get_saved_password_value(app: tauri::AppHandle, id: String) -> AppResult<Option<String>> {
    Ok(config::load_password_by_id(&app, &id)?.password)
}

#[tauri::command]
pub fn save_password(app: tauri::AppHandle, mut entry: SavedPassword) -> AppResult<String> {
    let mut cfg = config::load_passwords(&app)?;

    if entry.id.is_empty() {
        entry.id = uuid::Uuid::new_v4().to_string();
    }
    let target_id = entry.id.clone();
    let existing = cfg.passwords.iter().find(|p| p.id == target_id);

    entry.password = match entry.password.as_deref() {
        Some(plain) if !plain.is_empty() => Some(crypto::encrypt(plain)?),
        _ => existing.and_then(|e| e.password.clone()),
    };

    if let Some(ex) = cfg.passwords.iter_mut().find(|p| p.id == target_id) {
        *ex = entry;
    } else {
        cfg.passwords.push(entry);
    }
    config::save_passwords(&app, &cfg)?;
    Ok(target_id)
}

#[tauri::command]
pub fn delete_password(app: tauri::AppHandle, id: String) -> AppResult<()> {
    let mut cfg = config::load_passwords(&app)?;
    cfg.passwords.retain(|p| p.id != id);
    config::save_passwords(&app, &cfg)
}
