//! Remote file operations via the SFTP subsystem (russh-sftp).
//!
//! Reuses the existing SSH connection via channel multiplexing instead of
//! creating a new TCP connection for each operation.

use super::SshConnectionHandles;
use crate::core::SessionManager;
use crate::error::{AppError, AppResult};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::Notify;

const SFTP_FILE_TYPE_MASK: u32 = 0o170000;
const POSIX_MODE_MASK: u32 = 0o7777;
const TRANSFER_CANCELLED_MESSAGE: &str = "Transfer cancelled";

lazy_static::lazy_static! {
    static ref ACTIVE_TRANSFERS: Arc<Mutex<HashMap<String, Arc<TransferController>>>> =
        Arc::new(Mutex::new(HashMap::new()));
}

/// Event payload emitted to the frontend to track file transfer lifecycle.
#[derive(Debug, Clone, Serialize)]
pub struct TransferEvent {
    pub id: String,
    pub session_id: String,
    pub file_name: String,
    pub remote_path: String,
    pub local_path: String,
    /// "upload" or "download"
    pub direction: String,
    /// "started", "progress", "paused", "resumed", "completed", "cancelled", or "error"
    pub status: String,
    pub size: u64,
    pub bytes_transferred: u64,
    pub total_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_msg: Option<String>,
}

/// Parsed entry from SFTP readdir for the file explorer.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub permissions: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileProperties {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub permissions: String,
    pub owner: String,
    pub group: String,
    pub uid: String,
    pub gid: String,
    pub mtime: u64,
    pub atime: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferControlState {
    Running,
    Paused,
    Cancelled,
}

#[derive(Debug)]
struct TransferRuntime {
    id: String,
    session_id: String,
    file_name: String,
    remote_path: String,
    local_path: String,
    direction: String,
    bytes_transferred: u64,
    total_size: u64,
    control_state: TransferControlState,
}

#[derive(Debug)]
struct TransferController {
    runtime: Mutex<TransferRuntime>,
    notify: Notify,
}

impl TransferController {
    fn new(
        id: String,
        session_id: String,
        file_name: String,
        remote_path: String,
        local_path: String,
        direction: String,
    ) -> Self {
        Self {
            runtime: Mutex::new(TransferRuntime {
                id,
                session_id,
                file_name,
                remote_path,
                local_path,
                direction,
                bytes_transferred: 0,
                total_size: 0,
                control_state: TransferControlState::Running,
            }),
            notify: Notify::new(),
        }
    }

    fn id(&self) -> String {
        self.runtime.lock().unwrap().id.clone()
    }

    fn update_progress(&self, bytes_transferred: u64, total_size: u64) {
        let mut runtime = self.runtime.lock().unwrap();
        runtime.bytes_transferred = bytes_transferred;
        runtime.total_size = total_size;
    }

    fn build_event(&self, status: &str, size: u64, error_msg: Option<String>) -> TransferEvent {
        let runtime = self.runtime.lock().unwrap();
        TransferEvent {
            id: runtime.id.clone(),
            session_id: runtime.session_id.clone(),
            file_name: runtime.file_name.clone(),
            remote_path: runtime.remote_path.clone(),
            local_path: runtime.local_path.clone(),
            direction: runtime.direction.clone(),
            status: status.to_string(),
            size,
            bytes_transferred: runtime.bytes_transferred,
            total_size: runtime.total_size,
            error_msg,
        }
    }

    fn pause(&self) -> Option<TransferEvent> {
        {
            let mut runtime = self.runtime.lock().unwrap();
            if runtime.control_state != TransferControlState::Running {
                return None;
            }
            runtime.control_state = TransferControlState::Paused;
        }
        Some(self.build_event("paused", 0, None))
    }

    fn resume(&self) -> Option<TransferEvent> {
        {
            let mut runtime = self.runtime.lock().unwrap();
            if runtime.control_state != TransferControlState::Paused {
                return None;
            }
            runtime.control_state = TransferControlState::Running;
        }
        self.notify.notify_waiters();
        Some(self.build_event("resumed", 0, None))
    }

    fn cancel(&self) -> Option<TransferEvent> {
        {
            let mut runtime = self.runtime.lock().unwrap();
            if runtime.control_state == TransferControlState::Cancelled {
                return None;
            }
            runtime.control_state = TransferControlState::Cancelled;
        }
        self.notify.notify_waiters();
        Some(self.build_event("cancelled", 0, None))
    }

    fn control_state(&self) -> TransferControlState {
        self.runtime.lock().unwrap().control_state
    }
}

fn register_transfer(controller: Arc<TransferController>) {
    ACTIVE_TRANSFERS
        .lock()
        .unwrap()
        .insert(controller.id(), controller);
}

fn unregister_transfer(id: &str) {
    ACTIVE_TRANSFERS.lock().unwrap().remove(id);
}

fn find_transfer(id: &str) -> Option<Arc<TransferController>> {
    ACTIVE_TRANSFERS.lock().unwrap().get(id).cloned()
}

async fn wait_for_transfer_ready(controller: &Arc<TransferController>) -> AppResult<()> {
    loop {
        let notified = controller.notify.notified();
        match controller.control_state() {
            TransferControlState::Running => return Ok(()),
            TransferControlState::Cancelled => {
                return Err(AppError::Cancelled(TRANSFER_CANCELLED_MESSAGE.to_string()))
            }
            TransferControlState::Paused => notified.await,
        }
    }
}

async fn cleanup_cancelled_download(local_path: &str) {
    if tokio::fs::remove_file(local_path).await.is_err() {
        let _ = tokio::fs::remove_dir_all(local_path).await;
    }
}

async fn cleanup_cancelled_upload(
    manager: &SessionManager,
    session_id: &str,
    remote_path: &str,
) -> AppResult<()> {
    let sftp = open_sftp(manager, session_id).await?;
    if sftp.metadata(remote_path).await.is_ok() {
        let _ = sftp.remove_file(remote_path).await;
    }
    let _ = sftp.close().await;
    Ok(())
}

pub async fn pause_transfer(app: tauri::AppHandle, transfer_id: &str) -> AppResult<()> {
    if let Some(controller) = find_transfer(transfer_id) {
        if let Some(event) = controller.pause() {
            let _ = app.emit("transfer-event", &event);
        }
    }
    Ok(())
}

pub async fn resume_transfer(app: tauri::AppHandle, transfer_id: &str) -> AppResult<()> {
    if let Some(controller) = find_transfer(transfer_id) {
        if let Some(event) = controller.resume() {
            let _ = app.emit("transfer-event", &event);
        }
    }
    Ok(())
}

pub async fn cancel_transfer(app: tauri::AppHandle, transfer_id: &str) -> AppResult<()> {
    if let Some(controller) = find_transfer(transfer_id) {
        if let Some(event) = controller.cancel() {
            let _ = app.emit("transfer-event", &event);
        }
    }
    Ok(())
}

/// Opens an SFTP session by reusing the existing SSH connection's handle.
async fn open_sftp(manager: &SessionManager, session_id: &str) -> AppResult<SftpSession> {
    let ssh_handle = {
        let sessions = manager.sessions.lock().await;
        let session = sessions.get(session_id).ok_or_else(|| {
            AppError::SessionNotFound(format!("Session '{}' not found", session_id))
        })?;

        session
            .ssh_handle
            .as_ref()
            .ok_or_else(|| AppError::Config("Not an SSH session".to_string()))?
            .clone()
            .downcast::<SshConnectionHandles>()
            .map_err(|_| AppError::Config("Failed to get SSH handle".to_string()))?
    };
    let handle_mtx = ssh_handle.target_handle();

    let channel = {
        let handle = handle_mtx.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Channel(format!("Failed to open SFTP channel: {}", e)))?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Channel(format!("Failed to start SFTP subsystem: {}", e)))?;

    let sftp = SftpSession::new(channel.into_stream()).await?;
    Ok(sftp)
}

/// Convert a SFTP permission bitmask (u32) to the classic `ls -l` string like `-rwxr-xr-x`.
/// `type_char` should be `'d'` for directories, `'l'` for symlinks, or `'-'` for regular files.
fn permissions_to_string(mode: u32, type_char: char) -> String {
    let mut s = String::with_capacity(10);

    s.push(type_char);

    // Owner
    s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    s.push(match (mode & 0o100 != 0, mode & 0o4000 != 0) {
        (true, true) => 's',
        (false, true) => 'S',
        (true, false) => 'x',
        (false, false) => '-',
    });

    // Group
    s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    s.push(match (mode & 0o010 != 0, mode & 0o2000 != 0) {
        (true, true) => 's',
        (false, true) => 'S',
        (true, false) => 'x',
        (false, false) => '-',
    });

    // Other
    s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    s.push(match (mode & 0o001 != 0, mode & 0o1000 != 0) {
        (true, true) => 't',
        (false, true) => 'T',
        (true, false) => 'x',
        (false, false) => '-',
    });

    s
}

fn type_char_from_mode(mode: u32) -> char {
    match mode & SFTP_FILE_TYPE_MASK {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    }
}

fn describe_permissions(mode: Option<u32>) -> String {
    match mode {
        Some(mode) => format!(
            "{mode:#06o} ({})",
            permissions_to_string(mode, type_char_from_mode(mode))
        ),
        None => "none".to_string(),
    }
}

/// Resolves `$HOME` on the remote host via SFTP `canonicalize(".")`.
pub async fn get_home_dir(manager: Arc<SessionManager>, session_id: &str) -> AppResult<String> {
    let sftp = open_sftp(&manager, session_id).await?;
    let home = sftp.canonicalize(".").await?;
    let _ = sftp.close().await;

    if home.is_empty() {
        Err(AppError::Config(
            "Failed to determine home directory".to_string(),
        ))
    } else {
        Ok(home)
    }
}

/// Lists a remote directory via SFTP `read_dir`.
pub async fn list_remote_dir(
    manager: Arc<SessionManager>,
    session_id: &str,
    path: &str,
) -> AppResult<Vec<FileEntry>> {
    let sftp = open_sftp(&manager, session_id).await?;

    let dir = sftp.read_dir(path).await?;
    let _ = sftp.close().await;

    let mut entries = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        // read_dir uses lstat semantics per SFTP spec, so FileType correctly reflects
        // the entry itself (a symlink will be Symlink, not the type of its target).
        let file_type = entry.file_type();
        let is_dir = file_type == FileType::Dir;
        let is_symlink = file_type == FileType::Symlink;
        let type_char = if is_dir {
            'd'
        } else if is_symlink {
            'l'
        } else {
            '-'
        };

        let attrs = entry.metadata();
        let size = attrs.size.unwrap_or(0);
        let perms = attrs.permissions.unwrap_or(0);
        let permissions = permissions_to_string(perms, type_char);

        entries.push(FileEntry {
            name,
            is_dir,
            is_symlink,
            size,
            permissions,
        });
    }

    tracing::debug!(
        target: "user_action",
        action = "list",
        entity = "remote_directory",
        session_id = %session_id,
        remote_path = path,
        item_count = entries.len(),
        "User listed remote directory"
    );

    Ok(entries)
}

pub async fn delete_remote_file(
    manager: Arc<SessionManager>,
    session_id: &str,
    path: &str,
) -> AppResult<()> {
    let sftp = open_sftp(&manager, session_id).await?;

    let meta = sftp.metadata(path).await?;
    // Use the full POSIX type mask (S_IFMT = 0o170000) so that symlinks and other
    // special files are never mistakenly treated as directories.
    let is_dir = meta
        .permissions
        .map_or(false, |p| (p & 0o170000) == 0o040000);

    if is_dir {
        remove_dir_recursive(&sftp, path).await?;
    } else {
        // Covers regular files, symlinks, devices, etc.
        sftp.remove_file(path).await?;
    }

    let _ = sftp.close().await;

    tracing::debug!(
        target: "user_action",
        action = "delete",
        entity = "remote_entry",
        session_id = %session_id,
        remote_path = path,
        "User deleted remote entry"
    );

    Ok(())
}

/// Recursively remove a directory and all its contents via SFTP.
///
/// Continues deleting as many entries as possible on partial permission failures,
/// collecting all errors and returning them as one combined message at the end.
/// Symlinks are removed directly without following their targets.
async fn remove_dir_recursive(sftp: &SftpSession, path: &str) -> AppResult<()> {
    // Strip any trailing slashes to avoid double-slash paths like /var/www//file
    let path = path.trim_end_matches('/');

    let dir = sftp.read_dir(path).await?;
    let mut errors: Vec<String> = Vec::new();

    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = format!("{}/{}", path, name);
        let file_type = entry.file_type();

        if file_type == FileType::Dir {
            if let Err(e) = Box::pin(remove_dir_recursive(sftp, &child)).await {
                errors.push(e.to_string());
            }
        } else {
            // Symlinks and regular files are both removed with remove_file so we
            // never accidentally recurse into a symlinked directory.
            if let Err(e) = sftp.remove_file(&child).await {
                errors.push(format!("'{}': {}", child, e));
            }
        }
    }

    if !errors.is_empty() {
        return Err(AppError::Channel(format!(
            "{} item(s) could not be deleted:\n{}",
            errors.len(),
            errors.join("\n")
        )));
    }

    sftp.remove_dir(path)
        .await
        .map_err(|e| AppError::Channel(format!("Failed to remove directory '{}': {}", path, e)))
}

pub async fn rename_remote_file(
    manager: Arc<SessionManager>,
    session_id: &str,
    old_path: &str,
    new_path: &str,
) -> AppResult<()> {
    let sftp = open_sftp(&manager, session_id).await?;
    sftp.rename(old_path, new_path).await?;
    let _ = sftp.close().await;

    tracing::debug!(
        target: "user_action",
        action = "update",
        entity = "remote_entry",
        session_id = %session_id,
        old_path = old_path,
        new_path = new_path,
        "User renamed or moved remote entry"
    );

    Ok(())
}

pub async fn download_remote_file(
    app: tauri::AppHandle,
    manager: Arc<SessionManager>,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
) -> AppResult<()> {
    let transfer_settings = crate::config::load_app_settings(&app)
        .map(|s| s.transfer)
        .unwrap_or_default();
    let max_retries = transfer_settings.max_transfer_retries;
    let actual_local_path =
        match resolve_local_path(local_path, &transfer_settings.duplicate_strategy) {
            Some(path) => path,
            None => {
                let file_name = remote_path.split('/').last().unwrap_or(remote_path);
                let transfer_id = uuid::Uuid::new_v4().to_string();
                let _ = app.emit(
                    "transfer-event",
                    &TransferEvent {
                        id: transfer_id,
                        session_id: session_id.to_string(),
                        file_name: file_name.to_string(),
                        remote_path: remote_path.to_string(),
                        local_path: local_path.to_string(),
                        direction: "download".to_string(),
                        status: "completed".to_string(),
                        size: 0,
                        bytes_transferred: 0,
                        total_size: 0,
                        error_msg: None,
                    },
                );
                return Ok(());
            }
        };

    let mut last_err = None;
    for attempt in 0..=max_retries {
        if attempt > 0 {
            tracing::info!(attempt, "Retrying download of {}", remote_path);
        }
        match download_remote_file_inner(
            &app,
            &manager,
            session_id,
            remote_path,
            &actual_local_path,
            &transfer_settings,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                if matches!(e, AppError::Cancelled(_)) {
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap())
}

/// Resolve the actual local path, applying duplicate strategy.
fn resolve_local_path(local_path: &str, strategy: &str) -> Option<String> {
    let path = std::path::Path::new(local_path);
    if !path.exists() {
        return Some(local_path.to_string());
    }
    match strategy {
        "skip" => None,
        "rename" => {
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            let ext = path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let parent = path.parent().unwrap_or(std::path::Path::new("."));
            for i in 1..=999 {
                let candidate = parent.join(format!("{}({}){}", stem, i, ext));
                if !candidate.exists() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
            Some(local_path.to_string())
        }
        // "overwrite" or unknown => proceed with original path
        _ => Some(local_path.to_string()),
    }
}

async fn download_remote_file_inner(
    app: &tauri::AppHandle,
    manager: &SessionManager,
    session_id: &str,
    remote_path: &str,
    actual_path: &str,
    ts: &crate::config::TransferSettings,
) -> AppResult<()> {
    use std::io::SeekFrom;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    use tokio::task::JoinSet;

    let file_name = remote_path
        .split('/')
        .last()
        .unwrap_or(remote_path)
        .to_string();
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let controller = Arc::new(TransferController::new(
        transfer_id,
        session_id.to_string(),
        file_name,
        remote_path.to_string(),
        actual_path.to_string(),
        "download".to_string(),
    ));
    register_transfer(controller.clone());
    let _ = app.emit("transfer-event", &controller.build_event("started", 0, None));

    let chunk_size = (ts.transfer_buffer_size as u64).max(1) * 1024;
    let concurrency = (ts.download_threads as usize).max(1);

    let result: AppResult<u64> = async {
        if let Some(parent) = std::path::Path::new(&actual_path).parent() {
            if !parent.exists() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::Channel(format!("Failed to create local dir: {}", e)))?;
            }
        }

        let sftp = open_sftp(manager, session_id).await?;

        let remote_attrs = sftp.metadata(remote_path).await.ok();
        let total_size = remote_attrs.as_ref().and_then(|m| m.size).unwrap_or(0);
        controller.update_progress(0, total_size);

        let mut local_file = tokio::fs::File::create(&actual_path)
            .await
            .map_err(|e| AppError::Channel(format!("Failed to create local file: {}", e)))?;

        if total_size > 0 {
            let _ = local_file.set_len(total_size).await;
        }

        const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
        let mut last_progress = Instant::now();
        let mut bytes_transferred: u64 = 0;

        if total_size > 0 {
            let num_chunks = ((total_size + chunk_size - 1) / chunk_size) as usize;
            let concurrency = concurrency.min(num_chunks);

            let mut handle_pool: Vec<russh_sftp::client::fs::File> =
                Vec::with_capacity(concurrency);
            for _ in 0..concurrency {
                handle_pool.push(sftp.open(remote_path).await.map_err(|e| {
                    AppError::Channel(format!("Failed to open remote file: {}", e))
                })?);
            }

            type Task = AppResult<(u64, Vec<u8>, russh_sftp::client::fs::File)>;
            let mut join_set: JoinSet<Task> = JoinSet::new();
            let mut next_offset: u64 = 0;

            while let Some(fh) = handle_pool.pop() {
                if next_offset >= total_size {
                    break;
                }
                wait_for_transfer_ready(&controller).await?;
                let len = chunk_size.min(total_size - next_offset) as usize;
                let offset = next_offset;
                next_offset += len as u64;

                join_set.spawn(async move {
                    let mut f = fh;
                    f.seek(SeekFrom::Start(offset))
                        .await
                        .map_err(|e| AppError::Channel(format!("Seek failed: {}", e)))?;
                    let mut buf = vec![0u8; len];
                    f.read_exact(&mut buf)
                        .await
                        .map_err(|e| AppError::Channel(format!("SFTP read failed: {}", e)))?;
                    Ok((offset, buf, f))
                });
            }

            while let Some(res) = join_set.join_next().await {
                wait_for_transfer_ready(&controller).await?;
                let (chunk_offset, data, fh) =
                    res.map_err(|e| AppError::Channel(format!("Task panicked: {}", e)))??;

                local_file
                    .seek(SeekFrom::Start(chunk_offset))
                    .await
                    .map_err(|e| AppError::Channel(format!("Local seek failed: {}", e)))?;
                local_file
                    .write_all(&data)
                    .await
                    .map_err(|e| AppError::Channel(format!("Local write failed: {}", e)))?;

                bytes_transferred += data.len() as u64;
                controller.update_progress(bytes_transferred, total_size);

                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    let _ = app.emit(
                        "transfer-event",
                        &controller.build_event("progress", total_size, None),
                    );
                }

                if next_offset < total_size {
                    wait_for_transfer_ready(&controller).await?;
                    let len = chunk_size.min(total_size - next_offset) as usize;
                    let offset = next_offset;
                    next_offset += len as u64;

                    join_set.spawn(async move {
                        let mut f = fh;
                        f.seek(SeekFrom::Start(offset))
                            .await
                            .map_err(|e| AppError::Channel(format!("Seek failed: {}", e)))?;
                        let mut buf = vec![0u8; len];
                        f.read_exact(&mut buf)
                            .await
                            .map_err(|e| AppError::Channel(format!("SFTP read failed: {}", e)))?;
                        Ok((offset, buf, f))
                    });
                }
            }
        } else {
            let mut remote_file = sftp
                .open(remote_path)
                .await
                .map_err(|e| AppError::Channel(format!("Failed to open remote file: {}", e)))?;

            let seq_chunk = (chunk_size as usize).max(64 * 1024);
            let mut buf = vec![0u8; seq_chunk];
            loop {
                wait_for_transfer_ready(&controller).await?;
                let n = remote_file
                    .read(&mut buf)
                    .await
                    .map_err(|e| AppError::Channel(format!("SFTP read failed: {}", e)))?;
                if n == 0 {
                    break;
                }
                local_file
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| AppError::Channel(format!("Write failed: {}", e)))?;
                bytes_transferred += n as u64;
                controller.update_progress(bytes_transferred, 0);

                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    let _ = app.emit(
                        "transfer-event",
                        &controller.build_event("progress", 0, None),
                    );
                }
            }
        }

        local_file
            .flush()
            .await
            .map_err(|e| AppError::Channel(format!("Flush failed: {}", e)))?;

        if ts.preserve_timestamps {
            if let Some(ref attrs) = remote_attrs {
                let mtime = attrs.mtime.unwrap_or(0);
                if mtime > 0 {
                    use std::time::UNIX_EPOCH;
                    let set_mtime = UNIX_EPOCH + std::time::Duration::from_secs(u64::from(mtime));
                    let local_file_for_ts = std::fs::File::open(&actual_path);
                    if let Ok(f) = local_file_for_ts {
                        let _ = f.set_modified(set_mtime);
                    }
                }
            }
        }

        let _ = sftp.close().await;

        Ok(bytes_transferred)
    }
    .await;

    match result {
        Ok(size) => {
            controller.update_progress(size, size);
            let _ = app.emit("transfer-event", &controller.build_event("completed", size, None));
            unregister_transfer(&controller.id());
            Ok(())
        }
        Err(e) => {
            if matches!(e, AppError::Cancelled(_)) {
                cleanup_cancelled_download(actual_path).await;
            } else {
                let _ = app.emit(
                    "transfer-event",
                    &controller.build_event("error", 0, Some(e.to_string())),
                );
            }
            unregister_transfer(&controller.id());
            Err(e)
        }
    }
}

pub async fn upload_local_file(
    app: tauri::AppHandle,
    manager: Arc<SessionManager>,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
) -> AppResult<()> {
    let transfer_settings = crate::config::load_app_settings(&app)
        .map(|s| s.transfer)
        .unwrap_or_default();
    let max_retries = transfer_settings.max_transfer_retries;
    let sftp_for_resolve = open_sftp(&manager, session_id).await?;
    let actual_remote_path = match resolve_remote_path(
        &sftp_for_resolve,
        remote_path,
        &transfer_settings.duplicate_strategy,
    )
    .await
    {
        Some(path) => path,
        None => {
            let file_name = remote_path.split('/').last().unwrap_or(remote_path);
            let transfer_id = uuid::Uuid::new_v4().to_string();
            let _ = app.emit(
                "transfer-event",
                &TransferEvent {
                    id: transfer_id,
                    session_id: session_id.to_string(),
                    file_name: file_name.to_string(),
                    remote_path: remote_path.to_string(),
                    local_path: local_path.to_string(),
                    direction: "upload".to_string(),
                    status: "completed".to_string(),
                    size: 0,
                    bytes_transferred: 0,
                    total_size: 0,
                    error_msg: None,
                },
            );
            let _ = sftp_for_resolve.close().await;
            return Ok(());
        }
    };
    let _ = sftp_for_resolve.close().await;

    let mut last_err = None;
    for attempt in 0..=max_retries {
        if attempt > 0 {
            tracing::info!(attempt, "Retrying upload of {}", local_path);
        }
        match upload_local_file_inner(
            &app,
            &manager,
            session_id,
            local_path,
            &actual_remote_path,
            &transfer_settings,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                if matches!(e, AppError::Cancelled(_)) {
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap())
}

/// Resolve the actual remote path for upload, applying duplicate strategy.
async fn resolve_remote_path(
    sftp: &SftpSession,
    remote_path: &str,
    strategy: &str,
) -> Option<String> {
    let exists = sftp.metadata(remote_path).await.is_ok();
    if !exists {
        return Some(remote_path.to_string());
    }
    match strategy {
        "skip" => None,
        "rename" => {
            let path = std::path::Path::new(remote_path);
            let stem = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let ext = path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let parent = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string());
            for i in 1..=999 {
                let candidate = format!("{}/{}({}){}", parent.trim_end_matches('/'), stem, i, ext);
                if sftp.metadata(&candidate).await.is_err() {
                    return Some(candidate);
                }
            }
            Some(remote_path.to_string())
        }
        _ => Some(remote_path.to_string()),
    }
}

async fn upload_local_file_inner(
    app: &tauri::AppHandle,
    manager: &SessionManager,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    ts: &crate::config::TransferSettings,
) -> AppResult<()> {
    use std::io::SeekFrom;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    use tokio::task::JoinSet;

    let file_name = remote_path
        .split('/')
        .last()
        .unwrap_or(remote_path)
        .to_string();
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let controller = Arc::new(TransferController::new(
        transfer_id,
        session_id.to_string(),
        file_name,
        remote_path.to_string(),
        local_path.to_string(),
        "upload".to_string(),
    ));
    register_transfer(controller.clone());
    let _ = app.emit("transfer-event", &controller.build_event("started", 0, None));

    let chunk_size = ((ts.transfer_buffer_size as usize).max(1)) * 1024;
    let concurrency = (ts.upload_threads as usize).max(1);

    let result: AppResult<u64> = async {
        let local_meta = tokio::fs::metadata(local_path).await;
        let total_size = local_meta.as_ref().map(|m| m.len()).unwrap_or(0);
        controller.update_progress(0, total_size);

        let sftp = open_sftp(manager, session_id).await?;
        let mut bytes_transferred: u64 = 0;

        const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
        let mut last_progress = Instant::now();

        let mut bootstrap_file = sftp.create(remote_path).await?;
        bootstrap_file
            .shutdown()
            .await
            .map_err(|e| AppError::Channel(format!("SFTP flush failed: {}", e)))?;

        if total_size > 0 {
            let num_chunks = total_size.div_ceil(chunk_size as u64) as usize;
            let concurrency = concurrency.min(num_chunks);

            let mut handle_pool: Vec<(tokio::fs::File, russh_sftp::client::fs::File)> =
                Vec::with_capacity(concurrency);
            for _ in 0..concurrency {
                let local_file = tokio::fs::File::open(local_path)
                    .await
                    .map_err(|e| AppError::Channel(format!("Failed to open local file: {}", e)))?;
                let remote_file = sftp
                    .open_with_flags(remote_path, OpenFlags::WRITE)
                    .await
                    .map_err(|e| AppError::Channel(format!("Failed to open remote file: {}", e)))?;
                handle_pool.push((local_file, remote_file));
            }

            type Task = AppResult<(usize, tokio::fs::File, russh_sftp::client::fs::File)>;
            let mut join_set: JoinSet<Task> = JoinSet::new();
            let mut next_offset: u64 = 0;

            while let Some((local_fh, remote_fh)) = handle_pool.pop() {
                if next_offset >= total_size {
                    break;
                }
                wait_for_transfer_ready(&controller).await?;
                let len = chunk_size.min((total_size - next_offset) as usize);
                let offset = next_offset;
                next_offset += len as u64;

                join_set.spawn(async move {
                    let mut local = local_fh;
                    let mut remote = remote_fh;
                    local
                        .seek(SeekFrom::Start(offset))
                        .await
                        .map_err(|e| AppError::Channel(format!("Local seek failed: {}", e)))?;
                    let mut buf = vec![0u8; len];
                    local.read_exact(&mut buf).await.map_err(|e| {
                        AppError::Channel(format!("Failed to read local file: {}", e))
                    })?;
                    remote
                        .seek(SeekFrom::Start(offset))
                        .await
                        .map_err(|e| AppError::Channel(format!("Remote seek failed: {}", e)))?;
                    remote
                        .write_all(&buf)
                        .await
                        .map_err(|e| AppError::Channel(format!("SFTP write failed: {}", e)))?;
                    Ok((buf.len(), local, remote))
                });
            }

            while let Some(res) = join_set.join_next().await {
                wait_for_transfer_ready(&controller).await?;
                let (written, local_fh, remote_fh) =
                    res.map_err(|e| AppError::Channel(format!("Task panicked: {}", e)))??;

                bytes_transferred += written as u64;
                controller.update_progress(bytes_transferred, total_size);

                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    let _ = app.emit(
                        "transfer-event",
                        &controller.build_event("progress", total_size, None),
                    );
                }

                if next_offset < total_size {
                    wait_for_transfer_ready(&controller).await?;
                    let len = chunk_size.min((total_size - next_offset) as usize);
                    let offset = next_offset;
                    next_offset += len as u64;

                    join_set.spawn(async move {
                        let mut local = local_fh;
                        let mut remote = remote_fh;
                        local
                            .seek(SeekFrom::Start(offset))
                            .await
                            .map_err(|e| AppError::Channel(format!("Local seek failed: {}", e)))?;
                        let mut buf = vec![0u8; len];
                        local.read_exact(&mut buf).await.map_err(|e| {
                            AppError::Channel(format!("Failed to read local file: {}", e))
                        })?;
                        remote
                            .seek(SeekFrom::Start(offset))
                            .await
                            .map_err(|e| AppError::Channel(format!("Remote seek failed: {}", e)))?;
                        remote
                            .write_all(&buf)
                            .await
                            .map_err(|e| AppError::Channel(format!("SFTP write failed: {}", e)))?;
                        Ok((buf.len(), local, remote))
                    });
                } else {
                    let mut remote = remote_fh;
                    let _ = remote.shutdown().await;
                }
            }
        }

        // Preserve timestamps
        if ts.preserve_timestamps {
            if let Ok(ref meta) = local_meta {
                if let Ok(mtime) = meta.modified() {
                    if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                        let atime_secs = meta
                            .accessed()
                            .ok()
                            .and_then(|a| a.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as u32)
                            .unwrap_or(dur.as_secs() as u32);
                        if let Ok(mut attrs) = sftp.metadata(remote_path).await {
                            attrs.mtime = Some(dur.as_secs() as u32);
                            attrs.atime = Some(atime_secs);
                            let _ = sftp.set_metadata(remote_path, attrs).await;
                        }
                    }
                }
            }
        }

        let _ = sftp.close().await;

        Ok(bytes_transferred)
    }
    .await;

    match result {
        Ok(size) => {
            controller.update_progress(size, size);
            let _ = app.emit("transfer-event", &controller.build_event("completed", size, None));
            unregister_transfer(&controller.id());
            Ok(())
        }
        Err(e) => {
            if matches!(e, AppError::Cancelled(_)) {
                let _ = cleanup_cancelled_upload(manager, session_id, remote_path).await;
            } else {
                let _ = app.emit(
                    "transfer-event",
                    &controller.build_event("error", 0, Some(e.to_string())),
                );
            }
            unregister_transfer(&controller.id());
            Err(e)
        }
    }
}

pub async fn create_remote_file(
    manager: Arc<SessionManager>,
    session_id: &str,
    path: &str,
    mode: Option<String>,
) -> AppResult<()> {
    let sftp = open_sftp(&manager, session_id).await?;
    let file = sftp.create(path).await?;
    drop(file);
    if let Some(ref m) = mode {
        apply_remote_mode_after_create(&sftp, path, m, "file").await?;
    }
    let _ = sftp.close().await;

    tracing::debug!(
        target: "user_action",
        action = "create",
        entity = "remote_file",
        session_id = %session_id,
        remote_path = path,
        requested_mode = ?mode,
        "User created remote file"
    );

    Ok(())
}

pub async fn create_remote_dir(
    manager: Arc<SessionManager>,
    session_id: &str,
    path: &str,
    mode: Option<String>,
) -> AppResult<()> {
    let sftp = open_sftp(&manager, session_id).await?;
    sftp.create_dir(path).await?;
    if let Some(ref m) = mode {
        apply_remote_mode_after_create(&sftp, path, m, "directory").await?;
    }
    let _ = sftp.close().await;

    tracing::debug!(
        target: "user_action",
        action = "create",
        entity = "remote_directory",
        session_id = %session_id,
        remote_path = path,
        requested_mode = ?mode,
        "User created remote directory"
    );

    Ok(())
}

pub async fn create_remote_symlink(
    manager: Arc<SessionManager>,
    session_id: &str,
    link_path: &str,
    target_path: &str,
) -> AppResult<()> {
    let sftp = open_sftp(&manager, session_id).await?;
    sftp.symlink(link_path, target_path).await?;
    let _ = sftp.close().await;

    tracing::debug!(
        target: "user_action",
        action = "create",
        entity = "remote_symlink",
        session_id = %session_id,
        remote_path = link_path,
        target_path = target_path,
        "User created remote symlink"
    );

    Ok(())
}

pub async fn chmod_remote_file(
    manager: Arc<SessionManager>,
    session_id: &str,
    path: &str,
    mode: &str,
) -> AppResult<()> {
    let mode_u32 = parse_octal_mode(mode)?;

    let sftp = open_sftp(&manager, session_id).await?;

    apply_remote_mode(&sftp, path, mode_u32).await?;

    let _ = sftp.close().await;

    tracing::debug!(
        target: "user_action",
        action = "update",
        entity = "remote_permissions",
        session_id = %session_id,
        remote_path = path,
        requested_mode = mode,
        "User changed remote permissions"
    );

    Ok(())
}

fn parse_octal_mode(mode: &str) -> AppResult<u32> {
    u32::from_str_radix(mode, 8)
        .map_err(|_| AppError::Channel(format!("Invalid octal mode: {}", mode)))
}

async fn apply_remote_mode(sftp: &SftpSession, path: &str, requested_mode: u32) -> AppResult<()> {
    let original_attrs = sftp.metadata(path).await?;
    let original_permissions = original_attrs.permissions;
    let requested_permissions = requested_mode & POSIX_MODE_MASK;

    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(requested_permissions);
    sftp.set_metadata(path, attrs).await.map_err(|error| {
        tracing::warn!(
            remote_path = path,
            original_permissions = %describe_permissions(original_permissions),
            requested_permissions = format!("{requested_permissions:#06o}"),
            error = %error,
            "Failed to update remote permissions with a permissions-only SETSTAT payload"
        );
        AppError::from(error)
    })?;

    let actual_permissions = sftp.metadata(path).await.ok().and_then(|attrs| attrs.permissions);
    tracing::debug!(
        target: "user_action",
        action = "chmod",
        remote_path = path,
        original_permissions = %describe_permissions(original_permissions),
        requested_permissions = format!("{requested_permissions:#06o}"),
        actual_permissions = %describe_permissions(actual_permissions),
        "Applied remote permissions"
    );

    Ok(())
}

async fn apply_remote_mode_after_create(
    sftp: &SftpSession,
    path: &str,
    mode: &str,
    item_kind: &str,
) -> AppResult<()> {
    let requested_mode = parse_octal_mode(mode)?;

    match apply_remote_mode(sftp, path, requested_mode).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if sftp.metadata(path).await.is_ok() {
                tracing::warn!(
                    remote_path = path,
                    requested_mode = mode,
                    item_kind = %item_kind,
                    error = %error,
                    "Remote item created, but failed to apply requested permissions"
                );
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// Recursively downloads a remote directory to a local path, preserving structure.
/// Emits per-file `transfer-event` payloads so the transfer panel tracks progress.
pub async fn download_remote_directory(
    app: tauri::AppHandle,
    manager: Arc<SessionManager>,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
) -> AppResult<()> {
    tokio::fs::create_dir_all(local_path)
        .await
        .map_err(|e| AppError::Channel(format!("Failed to create local dir: {}", e)))?;

    let entries = list_remote_dir(manager.clone(), session_id, remote_path).await?;

    for entry in entries {
        let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), entry.name);
        let child_local = format!("{}/{}", local_path.trim_end_matches('/'), entry.name);

        if entry.is_dir {
            Box::pin(download_remote_directory(
                app.clone(),
                manager.clone(),
                session_id,
                &child_remote,
                &child_local,
            ))
            .await?;
        } else if !entry.is_symlink {
            download_remote_file(
                app.clone(),
                manager.clone(),
                session_id,
                &child_remote,
                &child_local,
            )
            .await?;
        }
    }

    Ok(())
}

/// Recursively uploads a local directory to a remote path, preserving structure.
/// Emits per-file `transfer-event` payloads so the transfer panel tracks progress.
pub async fn upload_local_directory(
    app: tauri::AppHandle,
    manager: Arc<SessionManager>,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
) -> AppResult<()> {
    // Create the remote directory
    let sftp = open_sftp(&manager, session_id).await?;
    let _ = sftp.create_dir(remote_path).await;
    let _ = sftp.close().await;

    let mut read_dir = tokio::fs::read_dir(local_path)
        .await
        .map_err(|e| AppError::Channel(format!("Failed to read local dir: {}", e)))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| AppError::Channel(format!("Failed to read dir entry: {}", e)))?
    {
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| AppError::Channel(format!("Failed to get file type: {}", e)))?;
        let entry_name = entry.file_name().to_string_lossy().to_string();
        let child_local = format!(
            "{}/{}",
            local_path.trim_end_matches(['/', '\\']),
            entry_name
        );
        let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), entry_name);

        if file_type.is_dir() {
            Box::pin(upload_local_directory(
                app.clone(),
                manager.clone(),
                session_id,
                &child_local,
                &child_remote,
            ))
            .await?;
        } else if file_type.is_file() {
            upload_local_file(
                app.clone(),
                manager.clone(),
                session_id,
                &child_local,
                &child_remote,
            )
            .await?;
        }
    }

    Ok(())
}

pub async fn get_file_properties(
    manager: Arc<SessionManager>,
    session_id: &str,
    path: &str,
) -> AppResult<FileProperties> {
    let sftp = open_sftp(&manager, session_id).await?;
    let attrs = sftp.metadata(path).await?;
    let _ = sftp.close().await;

    let perms = attrs.permissions.unwrap_or(0);
    // Apply S_IFMT mask (0o170000) for reliable type detection across all SFTP servers.
    let type_bits = perms & 0o170000;
    let is_dir = type_bits == 0o040000;
    let is_symlink = type_bits == 0o120000;
    let type_char = if is_dir {
        'd'
    } else if is_symlink {
        'l'
    } else {
        '-'
    };
    let permissions = permissions_to_string(perms, type_char);
    let name = path.split('/').last().unwrap_or(path).to_string();

    tracing::debug!(
        target: "user_action",
        action = "read",
        entity = "remote_properties",
        session_id = %session_id,
        remote_path = path,
        permissions = %describe_permissions(attrs.permissions),
        "User read remote entry properties"
    );

    Ok(FileProperties {
        name,
        is_dir,
        is_symlink,
        size: attrs.size.unwrap_or(0),
        permissions,
        owner: attrs.user.unwrap_or_default(),
        group: attrs.group.unwrap_or_default(),
        uid: attrs.uid.map_or_else(String::new, |v| v.to_string()),
        gid: attrs.gid.map_or_else(String::new, |v| v.to_string()),
        mtime: u64::from(attrs.mtime.unwrap_or(0)),
        atime: u64::from(attrs.atime.unwrap_or(0)),
    })
}
