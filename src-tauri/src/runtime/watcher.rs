use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::error::AppResult;

#[derive(Clone, Serialize)]
pub struct FileModifiedPayload {
    pub session_id: String,
    pub local_path: String,
    pub remote_path: String,
}

struct WatchState {
    _watcher: Option<RecommendedWatcher>,
}

lazy_static::lazy_static! {
    static ref ACTIVE_WATCHERS: Arc<Mutex<std::collections::HashMap<String, WatchState>>> = Arc::new(Mutex::new(std::collections::HashMap::new()));
}

#[tauri::command]
pub async fn start_file_watch(
    app: AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> AppResult<()> {
    // Generate a unique key for this watch instance
    let watch_key = format!("{}:{}", session_id, local_path);
    let mut watchers = ACTIVE_WATCHERS.lock().unwrap();

    // If we are already watching this file, don't start another watcher
    if watchers.contains_key(&watch_key) {
        return Ok(());
    }

    let (tx, rx) = channel();

    // Create the watcher (this has to happen synchronously or via std thread)
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| {
        crate::error::AppError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        ))
    })?;

    watcher
        .watch(Path::new(&local_path), RecursiveMode::NonRecursive)
        .map_err(|e| {
            crate::error::AppError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    // Store the watcher to keep it alive
    watchers.insert(
        watch_key.clone(),
        WatchState {
            _watcher: Some(watcher),
        },
    );

    let app_clone = app.clone();
    let session_id_clone = session_id.clone();
    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();

    tracing::info!("Starting file watch for local path: {}", local_path);

    // Spawn a blocking thread to listen for notify events
    std::thread::spawn(move || {
        let mut last_emit = std::time::Instant::now() - Duration::from_secs(5);
        for res in rx {
            match res {
                Ok(event) => {
                    tracing::info!("Notify event received: {:?}", event.kind);

                    // Most text editors do atomic saves (save to temp file, then rename/move)
                    // We need to catch Any/Data modify events inside the file OR rename events on the filepath
                    if let EventKind::Modify(_) = event.kind {
                        tracing::info!("Detected Modify event on: {:?}", event.paths);
                        // Debounce: prevent emitting multiple times for a single save operation (common in editors)
                        if last_emit.elapsed() > Duration::from_millis(500) {
                            tracing::info!("Debounce passed, emitting 'file-modified' payload...");
                            last_emit = std::time::Instant::now();
                            let payload = FileModifiedPayload {
                                session_id: session_id_clone.clone(),
                                local_path: local_path_clone.clone(),
                                remote_path: remote_path_clone.clone(),
                            };
                            if let Err(e) = app_clone.emit("file-modified", payload) {
                                tracing::error!("Failed to emit file-modified event: {:?}", e);
                            }
                        } else {
                            tracing::info!("Event debounced (too soon since last emit).");
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("watch error: {:?}", e);
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_file_watch(session_id: String, local_path: String) -> AppResult<()> {
    let watch_key = format!("{}:{}", session_id, local_path);
    let mut watchers = ACTIVE_WATCHERS.lock().unwrap();
    watchers.remove(&watch_key);
    Ok(())
}
