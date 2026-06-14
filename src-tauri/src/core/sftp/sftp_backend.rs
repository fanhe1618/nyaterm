//! SFTP backend: standard SSH SFTP subsystem via russh-sftp.
//!
//! This is the preferred backend when the server supports `Subsystem sftp`.

use super::traits::RemoteFs;
use super::transfer::*;
use super::util::*;
use crate::core::ssh::{SshConnectionHandles, SshRawHandle};
use crate::error::{AppError, AppResult};
use crate::observability::{StructuredLog, StructuredLogLevel, log_event};
use russh::ChannelMsg;
use russh_sftp::client::{Config as SftpClientConfig, SftpSession};
use russh_sftp::protocol::{FileAttributes, FileType};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

const SFTP_MIN_REQUEST_KIB: usize = 64;
const SFTP_MAX_REQUEST_KIB: usize = 256;
const SFTP_PIPELINE_TARGET_KIB: usize = 1024;
const SFTP_WRITE_PIPELINE_TARGET_KIB: usize = 2048;
const SFTP_MIN_PIPELINE_DEPTH: usize = 4;
const SFTP_MAX_PIPELINE_DEPTH: usize = 16;
const SFTP_MIN_CONCURRENT_WRITES: usize = 8;
const SFTP_MAX_CONCURRENT_WRITES: usize = 16;
const SFTP_PACKET_OVERHEAD_RESERVE: usize = 1024;
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

fn sftp_pipeline_config(ts: &crate::config::TransferSettings) -> (usize, usize, usize) {
    let request_kib =
        (ts.transfer_buffer_size as usize).clamp(SFTP_MIN_REQUEST_KIB, SFTP_MAX_REQUEST_KIB);
    let pipeline_depth = SFTP_PIPELINE_TARGET_KIB
        .div_ceil(request_kib)
        .clamp(SFTP_MIN_PIPELINE_DEPTH, SFTP_MAX_PIPELINE_DEPTH);
    let max_concurrent_writes = SFTP_WRITE_PIPELINE_TARGET_KIB
        .div_ceil(request_kib)
        .clamp(SFTP_MIN_CONCURRENT_WRITES, SFTP_MAX_CONCURRENT_WRITES);
    (request_kib, pipeline_depth, max_concurrent_writes)
}

fn sftp_client_config(request_kib: usize, max_concurrent_writes: usize) -> SftpClientConfig {
    SftpClientConfig {
        max_packet_len: (request_kib * 1024) as u32,
        max_concurrent_writes,
        ..SftpClientConfig::default()
    }
}

fn sftp_payload_size(request_kib: usize) -> usize {
    (request_kib * 1024)
        .saturating_sub(SFTP_PACKET_OVERHEAD_RESERVE)
        .max(32 * 1024)
}

fn transfer_task_concurrency(value: u32) -> usize {
    (value as usize).clamp(1, 10)
}

fn background_transfer_task_concurrency(value: u32) -> usize {
    let configured = transfer_task_concurrency(value);
    if configured > 1 { configured - 1 } else { 1 }
}

fn log_transfer_performance(
    direction: &str,
    kind: &str,
    bytes: u64,
    elapsed: Duration,
    request_kib: usize,
    pipeline_depth: usize,
    max_concurrent_writes: usize,
    concurrent_tasks: usize,
) {
    let elapsed_secs = elapsed.as_secs_f64().max(0.001);
    let mbps = bytes as f64 / 1024.0 / 1024.0 / elapsed_secs;
    log_event(StructuredLog {
        level: StructuredLogLevel::Info,
        domain: "transfer.performance".to_string(),
        event: "sftp.transfer.completed".to_string(),
        message: "SFTP transfer performance summary".to_string(),
        ids: None,
        data: Some(serde_json::json!({
            "backend": "sftp",
            "direction": direction,
            "kind": kind,
            "bytes": bytes,
            "elapsed_ms": elapsed.as_millis(),
            "average_mbps": mbps,
            "request_kib": request_kib,
            "payload_bytes": sftp_payload_size(request_kib),
            "pipeline_depth": pipeline_depth,
            "max_concurrent_writes": max_concurrent_writes,
            "concurrent_tasks": concurrent_tasks,
        })),
        error: None,
        client_timestamp: None,
    });
}

#[derive(Clone)]
pub(crate) struct SftpBackend {
    ssh_handle: Arc<SshConnectionHandles>,
    identity_cache: Arc<RwLock<RemoteIdentityCache>>,
}

#[derive(Default)]
struct RemoteIdentityCache {
    users_by_uid: HashMap<u32, String>,
    groups_by_gid: HashMap<u32, String>,
    uids_by_user: HashMap<String, u32>,
    gids_by_group: HashMap<String, u32>,
}

struct ExecResult {
    exit_code: u32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl SftpBackend {
    pub(crate) fn new(ssh_handle: Arc<SshConnectionHandles>) -> Self {
        Self {
            ssh_handle,
            identity_cache: Arc::new(RwLock::new(RemoteIdentityCache::default())),
        }
    }

    /// Attempt to open a throwaway SFTP session to verify subsystem availability.
    pub(crate) async fn probe(ssh_handle: &Arc<SshConnectionHandles>) -> AppResult<()> {
        let sftp =
            Self::open_sftp_raw(ssh_handle.target_handle(), SftpClientConfig::default()).await?;
        let _ = sftp.close().await;
        Ok(())
    }

    async fn open_sftp_raw(
        handle_mtx: SshRawHandle,
        config: SftpClientConfig,
    ) -> AppResult<SftpSession> {
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

        let sftp = SftpSession::new_with_config(channel.into_stream(), config).await?;
        Ok(sftp)
    }

    async fn open_sftp(&self) -> AppResult<SftpSession> {
        Self::open_sftp_raw(self.ssh_handle.target_handle(), SftpClientConfig::default()).await
    }

    async fn open_sftp_with_client_config(
        &self,
        config: SftpClientConfig,
    ) -> AppResult<SftpSession> {
        Self::open_sftp_raw(self.ssh_handle.target_handle(), config).await
    }

    async fn exec(&self, command: &str) -> AppResult<ExecResult> {
        let handle_mtx = self.ssh_handle.target_handle();
        let mut channel = {
            let handle = handle_mtx.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Channel(format!("Failed to open exec channel: {}", e)))?
        };

        channel.exec(true, command.as_bytes()).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: Option<u32> = None;

        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    if ext == 1 {
                        stderr.extend_from_slice(&data);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status);
                }
                Some(ChannelMsg::Eof) | None => {
                    if exit_code.is_none() {
                        if let Some(ChannelMsg::ExitStatus { exit_status }) = channel.wait().await {
                            exit_code = Some(exit_status);
                        }
                    }
                    break;
                }
                _ => {}
            }
        }

        Ok(ExecResult {
            exit_code: exit_code.unwrap_or(255),
            stdout,
            stderr,
        })
    }

    async fn exec_ok(&self, command: &str) -> AppResult<Vec<u8>> {
        let result = self.exec(command).await?;
        if result.exit_code != 0 {
            let msg = String::from_utf8_lossy(&result.stderr);
            return Err(AppError::Channel(format!(
                "Remote command failed (exit {}): {}",
                result.exit_code,
                msg.trim()
            )));
        }
        Ok(result.stdout)
    }

    async fn resolve_uid_names(&self, uids: HashSet<u32>) -> HashMap<u32, String> {
        let missing: Vec<u32> = {
            let cache = self.identity_cache.read().await;
            uids.iter()
                .copied()
                .filter(|uid| !cache.users_by_uid.contains_key(uid))
                .collect()
        };
        if missing.is_empty() {
            let cache = self.identity_cache.read().await;
            return uids
                .into_iter()
                .filter_map(|uid| cache.users_by_uid.get(&uid).map(|name| (uid, name.clone())))
                .collect();
        }

        let id_list = missing
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "ids={}; for id in $ids; do name=$(getent passwd \"$id\" 2>/dev/null | cut -d: -f1); if [ -z \"$name\" ] && [ -r /etc/passwd ]; then name=$(awk -F: -v id=\"$id\" '$3==id {{print $1; exit}}' /etc/passwd 2>/dev/null); fi; if [ -n \"$name\" ]; then printf '%s:%s\\n' \"$id\" \"$name\"; fi; done",
            sh_quote(&id_list)
        );

        let mut resolved = HashMap::new();
        if let Ok(output) = self.exec_ok(&command).await {
            for line in String::from_utf8_lossy(&output).lines() {
                if let Some((id, name)) = line.split_once(':') {
                    if let Ok(uid) = id.parse::<u32>() {
                        let trimmed = name.trim();
                        if !trimmed.is_empty() {
                            resolved.insert(uid, trimmed.to_string());
                        }
                    }
                }
            }
        }

        let mut cache = self.identity_cache.write().await;
        for (uid, name) in &resolved {
            cache.users_by_uid.insert(*uid, name.clone());
            cache.uids_by_user.insert(name.clone(), *uid);
        }
        uids.into_iter()
            .filter_map(|uid| cache.users_by_uid.get(&uid).map(|name| (uid, name.clone())))
            .collect()
    }

    async fn resolve_gid_names(&self, gids: HashSet<u32>) -> HashMap<u32, String> {
        let missing: Vec<u32> = {
            let cache = self.identity_cache.read().await;
            gids.iter()
                .copied()
                .filter(|gid| !cache.groups_by_gid.contains_key(gid))
                .collect()
        };
        if missing.is_empty() {
            let cache = self.identity_cache.read().await;
            return gids
                .into_iter()
                .filter_map(|gid| {
                    cache
                        .groups_by_gid
                        .get(&gid)
                        .map(|name| (gid, name.clone()))
                })
                .collect();
        }

        let id_list = missing
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "ids={}; for id in $ids; do name=$(getent group \"$id\" 2>/dev/null | cut -d: -f1); if [ -z \"$name\" ] && [ -r /etc/group ]; then name=$(awk -F: -v id=\"$id\" '$3==id {{print $1; exit}}' /etc/group 2>/dev/null); fi; if [ -n \"$name\" ]; then printf '%s:%s\\n' \"$id\" \"$name\"; fi; done",
            sh_quote(&id_list)
        );

        let mut resolved = HashMap::new();
        if let Ok(output) = self.exec_ok(&command).await {
            for line in String::from_utf8_lossy(&output).lines() {
                if let Some((id, name)) = line.split_once(':') {
                    if let Ok(gid) = id.parse::<u32>() {
                        let trimmed = name.trim();
                        if !trimmed.is_empty() {
                            resolved.insert(gid, trimmed.to_string());
                        }
                    }
                }
            }
        }

        let mut cache = self.identity_cache.write().await;
        for (gid, name) in &resolved {
            cache.groups_by_gid.insert(*gid, name.clone());
            cache.gids_by_group.insert(name.clone(), *gid);
        }
        gids.into_iter()
            .filter_map(|gid| {
                cache
                    .groups_by_gid
                    .get(&gid)
                    .map(|name| (gid, name.clone()))
            })
            .collect()
    }

    async fn resolve_user_to_uid(&self, owner: &str) -> AppResult<u32> {
        if let Ok(uid) = owner.parse::<u32>() {
            return Ok(uid);
        }
        if let Some(uid) = self
            .identity_cache
            .read()
            .await
            .uids_by_user
            .get(owner)
            .copied()
        {
            return Ok(uid);
        }
        let command = format!(
            "name={}; id=$(getent passwd \"$name\" 2>/dev/null | cut -d: -f3); if [ -z \"$id\" ] && [ -r /etc/passwd ]; then id=$(awk -F: -v name=\"$name\" '$1==name {{print $3; exit}}' /etc/passwd 2>/dev/null); fi; [ -n \"$id\" ] && printf '%s\\n' \"$id\"",
            sh_quote(owner)
        );
        let output = self.exec_ok(&command).await?;
        let text = String::from_utf8_lossy(&output);
        let uid = text
            .trim()
            .parse::<u32>()
            .map_err(|_| AppError::Channel(format!("Failed to resolve remote user '{}'", owner)))?;
        let mut cache = self.identity_cache.write().await;
        cache.uids_by_user.insert(owner.to_string(), uid);
        cache.users_by_uid.insert(uid, owner.to_string());
        Ok(uid)
    }

    async fn resolve_group_to_gid(&self, group: &str) -> AppResult<u32> {
        if let Ok(gid) = group.parse::<u32>() {
            return Ok(gid);
        }
        if let Some(gid) = self
            .identity_cache
            .read()
            .await
            .gids_by_group
            .get(group)
            .copied()
        {
            return Ok(gid);
        }
        let command = format!(
            "name={}; id=$(getent group \"$name\" 2>/dev/null | cut -d: -f3); if [ -z \"$id\" ] && [ -r /etc/group ]; then id=$(awk -F: -v name=\"$name\" '$1==name {{print $3; exit}}' /etc/group 2>/dev/null); fi; [ -n \"$id\" ] && printf '%s\\n' \"$id\"",
            sh_quote(group)
        );
        let output = self.exec_ok(&command).await?;
        let text = String::from_utf8_lossy(&output);
        let gid = text.trim().parse::<u32>().map_err(|_| {
            AppError::Channel(format!("Failed to resolve remote group '{}'", group))
        })?;
        let mut cache = self.identity_cache.write().await;
        cache.gids_by_group.insert(group.to_string(), gid);
        cache.groups_by_gid.insert(gid, group.to_string());
        Ok(gid)
    }
}

fn sftp_attrs_is_dir(attrs: &FileAttributes) -> bool {
    attrs.permissions.map_or(false, |permissions| {
        (permissions & SFTP_FILE_TYPE_MASK) == 0o040000
    })
}

fn sftp_attrs_is_symlink(attrs: &FileAttributes) -> bool {
    attrs.permissions.map_or(false, |permissions| {
        (permissions & SFTP_FILE_TYPE_MASK) == 0o120000
    })
}

fn normalize_remote_dir_path(path: &str) -> &str {
    if path == "/" {
        "/"
    } else {
        path.trim_end_matches('/')
    }
}

fn join_remote_child(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

async fn remove_dir_recursive(sftp: &SftpSession, path: &str) -> AppResult<()> {
    let path = normalize_remote_dir_path(path);
    let dir = sftp.read_dir(path).await?;
    let mut errors: Vec<String> = Vec::new();

    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = join_remote_child(path, &name);
        let file_type = entry.file_type();

        if file_type == FileType::Dir {
            if let Err(e) = Box::pin(remove_dir_recursive(sftp, &child)).await {
                errors.push(e.to_string());
            }
        } else {
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

async fn resolve_remote_path(
    app: &tauri::AppHandle,
    session_manager: &crate::core::SessionManager,
    sftp: &SftpSession,
    session_id: &str,
    remote_path: &str,
    strategy: &str,
) -> Option<String> {
    let exists = sftp.metadata(remote_path).await.is_ok();
    if !exists {
        return Some(remote_path.to_string());
    }
    let file_name = remote_path.split('/').last().unwrap_or(remote_path);
    let is_directory = sftp
        .metadata(remote_path)
        .await
        .map(|attrs| sftp_attrs_is_dir(&attrs))
        .unwrap_or(false);
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
        "ask" => {
            match super::duplicate::prompt_duplicate_choice(
                app,
                session_manager,
                session_id,
                remote_path,
                file_name,
                is_directory,
            )
            .await
            {
                Ok(super::duplicate::DuplicateChoice::Skip) => None,
                Ok(super::duplicate::DuplicateChoice::Overwrite) => Some(remote_path.to_string()),
                Err(_) => None,
            }
        }
        _ => Some(remote_path.to_string()),
    }
}

async fn ensure_remote_upload_target_allowed(
    app: &tauri::AppHandle,
    session_manager: &crate::core::SessionManager,
    sftp: &SftpSession,
    session_id: &str,
    remote_path: &str,
    strategy: &str,
) -> bool {
    let exists = sftp.metadata(remote_path).await.is_ok();
    if !exists {
        return true;
    }

    let file_name = file_name_from_path(remote_path);
    let is_directory = sftp
        .metadata(remote_path)
        .await
        .map(|attrs| sftp_attrs_is_dir(&attrs))
        .unwrap_or(false);

    match strategy {
        "skip" => false,
        "rename" => true,
        "ask" => {
            matches!(
                super::duplicate::prompt_duplicate_choice(
                    app,
                    session_manager,
                    session_id,
                    remote_path,
                    &file_name,
                    is_directory,
                )
                .await,
                Ok(super::duplicate::DuplicateChoice::Overwrite)
            )
        }
        _ => true,
    }
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

    let actual_permissions = sftp
        .metadata(path)
        .await
        .ok()
        .and_then(|attrs| attrs.permissions);
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

async fn apply_remote_attrs(
    sftp: &SftpSession,
    path: &str,
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
) -> AppResult<()> {
    let original_attrs = sftp.symlink_metadata(path).await?;
    let mut attrs = FileAttributes::empty();
    if let Some(mode) = mode {
        let type_bits = original_attrs.permissions.unwrap_or(0) & SFTP_FILE_TYPE_MASK;
        attrs.permissions = Some(type_bits | (mode & POSIX_MODE_MASK));
    }
    if uid.is_some() || gid.is_some() {
        let effective_uid = uid.or(original_attrs.uid);
        let effective_gid = gid.or(original_attrs.gid);
        match (effective_uid, effective_gid) {
            (Some(effective_uid), Some(effective_gid)) => {
                attrs.uid = Some(effective_uid);
                attrs.gid = Some(effective_gid);
            }
            _ => {
                return Err(AppError::Channel(
                    "Cannot update SFTP ownership because the server did not provide the current UID/GID; set both owner and group."
                        .to_string(),
                ));
            }
        }
    }
    if attrs.permissions.is_none() && attrs.uid.is_none() && attrs.gid.is_none() {
        return Ok(());
    }

    sftp.set_metadata(path, attrs).await.map_err(|error| {
        tracing::warn!(
            remote_path = path,
            requested_mode = ?mode,
            requested_uid = ?uid,
            requested_gid = ?gid,
            error = %error,
            "Failed to update remote file attributes"
        );
        AppError::from(error)
    })?;

    Ok(())
}

async fn apply_remote_attrs_recursive(
    sftp: &SftpSession,
    path: &str,
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
) -> AppResult<()> {
    let path = normalize_remote_dir_path(path);
    let meta = sftp.symlink_metadata(path).await?;
    let is_dir = sftp_attrs_is_dir(&meta);
    let is_symlink = sftp_attrs_is_symlink(&meta);

    apply_remote_attrs(sftp, path, mode, uid, gid).await?;

    if !is_dir || is_symlink {
        return Ok(());
    }

    let dir = sftp.read_dir(path).await?;
    let mut errors: Vec<String> = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = join_remote_child(path, &name);
        let attrs = entry.metadata();
        if sftp_attrs_is_dir(&attrs) && !sftp_attrs_is_symlink(&attrs) {
            if let Err(error) =
                Box::pin(apply_remote_attrs_recursive(sftp, &child, mode, uid, gid)).await
            {
                errors.push(error.to_string());
            }
        } else if let Err(error) = apply_remote_attrs(sftp, &child, mode, uid, gid).await {
            errors.push(format!("'{}': {}", child, error));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::Channel(format!(
            "{} item(s) could not be updated:\n{}",
            errors.len(),
            errors.join("\n")
        )))
    }
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

async fn cleanup_cancelled_upload(backend: &SftpBackend, remote_path: &str) -> AppResult<()> {
    let sftp = backend.open_sftp().await?;
    if sftp.metadata(remote_path).await.is_ok() {
        let _ = sftp.remove_file(remote_path).await;
    }
    let _ = sftp.close().await;
    Ok(())
}

async fn read_sftp_chunk(
    mut remote_file: russh_sftp::client::fs::File,
    offset: u64,
    len: usize,
) -> AppResult<(u64, Vec<u8>, russh_sftp::client::fs::File)> {
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    remote_file
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| AppError::Channel(format!("Seek failed: {}", e)))?;
    let mut buf = vec![0u8; len];
    remote_file
        .read_exact(&mut buf)
        .await
        .map_err(|e| AppError::Channel(format!("SFTP read failed: {}", e)))?;
    Ok((offset, buf, remote_file))
}

async fn download_remote_file_inner_with_controller(
    backend: &SftpBackend,
    app: &tauri::AppHandle,
    _session_id: &str,
    remote_path: &str,
    actual_path: &str,
    ts: &crate::config::TransferSettings,
    controller: Arc<TransferController>,
    parent_controller: Option<Arc<TransferController>>,
) -> AppResult<()> {
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    use tokio::task::JoinSet;

    register_transfer(controller.clone());
    let _ = app.emit(
        "transfer-event",
        &controller.build_event("started", 0, None),
    );

    let (request_kib, pipeline_depth, max_concurrent_writes) = sftp_pipeline_config(ts);
    let chunk_size = sftp_payload_size(request_kib) as u64;
    let transfer_started = Instant::now();

    let result: AppResult<u64> = async {
        if let Some(parent) = std::path::Path::new(&actual_path).parent() {
            if !parent.exists() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::Channel(format!("Failed to create local dir: {}", e)))?;
            }
        }

        let sftp = backend
            .open_sftp_with_client_config(sftp_client_config(request_kib, max_concurrent_writes))
            .await?;

        let remote_attrs = sftp.metadata(remote_path).await.ok();
        let total_size = remote_attrs.as_ref().and_then(|m| m.size).unwrap_or(0);
        controller.update_progress(0, total_size);

        let mut local_file = tokio::fs::File::create(&actual_path)
            .await
            .map_err(|e| AppError::Channel(format!("Failed to create local file: {}", e)))?;

        if total_size > 0 {
            let _ = local_file.set_len(total_size).await;
        }

        let mut last_progress = Instant::now();
        let mut bytes_transferred: u64 = 0;

        if total_size > 0 {
            let num_chunks = ((total_size + chunk_size - 1) / chunk_size) as usize;
            let concurrency = pipeline_depth.min(num_chunks);

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
                wait_for_transfer_chain(&controller, parent_controller.as_ref()).await?;
                let len = chunk_size.min(total_size - next_offset) as usize;
                let offset = next_offset;
                next_offset += len as u64;
                join_set.spawn(read_sftp_chunk(fh, offset, len));
            }

            while let Some(res) = join_set.join_next().await {
                wait_for_transfer_chain(&controller, parent_controller.as_ref()).await?;
                let (chunk_offset, data, fh) =
                    res.map_err(|e| AppError::Channel(format!("Task panicked: {}", e)))??;

                if next_offset < total_size {
                    wait_for_transfer_chain(&controller, parent_controller.as_ref()).await?;
                    let len = chunk_size.min(total_size - next_offset) as usize;
                    let offset = next_offset;
                    next_offset += len as u64;
                    join_set.spawn(read_sftp_chunk(fh, offset, len));
                }

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

                if last_progress.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    emit_parent_progress(app, parent_controller.as_ref());
                    let _ = app.emit(
                        "transfer-event",
                        &controller.build_event("progress", total_size, None),
                    );
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
                wait_for_transfer_chain(&controller, parent_controller.as_ref()).await?;
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

                if last_progress.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    emit_parent_progress(app, parent_controller.as_ref());
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
                    let local_file_for_ts = std::fs::File::open(actual_path);
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
            log_transfer_performance(
                "download",
                "file",
                size,
                transfer_started.elapsed(),
                request_kib,
                pipeline_depth,
                max_concurrent_writes,
                1,
            );
            controller.update_progress(size, size);
            let _ = app.emit(
                "transfer-event",
                &controller.build_event("completed", size, None),
            );
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

async fn upload_local_file_inner_with_controller(
    backend: &SftpBackend,
    app: &tauri::AppHandle,
    _session_id: &str,
    local_path: &str,
    remote_path: &str,
    ts: &crate::config::TransferSettings,
    controller: Arc<TransferController>,
    parent_controller: Option<Arc<TransferController>>,
) -> AppResult<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    register_transfer(controller.clone());
    let _ = app.emit(
        "transfer-event",
        &controller.build_event("started", 0, None),
    );

    let (request_kib, pipeline_depth, max_concurrent_writes) = sftp_pipeline_config(ts);
    let chunk_size = sftp_payload_size(request_kib);
    let transfer_started = Instant::now();

    let result: AppResult<u64> = async {
        let local_meta = tokio::fs::metadata(local_path).await;
        let total_size = local_meta.as_ref().map(|m| m.len()).unwrap_or(0);
        controller.update_progress(0, total_size);

        let sftp = backend
            .open_sftp_with_client_config(sftp_client_config(request_kib, max_concurrent_writes))
            .await?;
        let mut bytes_transferred: u64 = 0;

        let mut last_progress = Instant::now();
        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| AppError::Channel(format!("Failed to open local file: {}", e)))?;
        let mut remote_file = sftp
            .create(remote_path)
            .await
            .map_err(|e| AppError::Channel(format!("Failed to create remote file: {}", e)))?;

        if total_size > 0 {
            let mut buf = vec![0u8; chunk_size];
            loop {
                wait_for_transfer_chain(&controller, parent_controller.as_ref()).await?;
                let read = local_file
                    .read(&mut buf)
                    .await
                    .map_err(|e| AppError::Channel(format!("Failed to read local file: {}", e)))?;
                if read == 0 {
                    break;
                }

                // russh-sftp >= 2.3 pipelines write ACKs internally according to
                // client::Config::max_concurrent_writes; shutdown below drains them.
                remote_file
                    .write_all(&buf[..read])
                    .await
                    .map_err(|e| AppError::Channel(format!("SFTP write failed: {}", e)))?;

                bytes_transferred += read as u64;
                controller.update_progress(bytes_transferred, total_size);

                if last_progress.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    emit_parent_progress(app, parent_controller.as_ref());
                    let _ = app.emit(
                        "transfer-event",
                        &controller.build_event("progress", total_size, None),
                    );
                }
            }
        }

        remote_file
            .shutdown()
            .await
            .map_err(|e| AppError::Channel(format!("SFTP flush failed: {}", e)))?;

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
            log_transfer_performance(
                "upload",
                "file",
                size,
                transfer_started.elapsed(),
                request_kib,
                pipeline_depth,
                max_concurrent_writes,
                1,
            );
            controller.update_progress(size, size);
            let _ = app.emit(
                "transfer-event",
                &controller.build_event("completed", size, None),
            );
            unregister_transfer(&controller.id());
            Ok(())
        }
        Err(e) => {
            if matches!(e, AppError::Cancelled(_)) {
                let _ = cleanup_cancelled_upload(backend, remote_path).await;
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

#[async_trait::async_trait]
impl RemoteFs for SftpBackend {
    fn backend_name(&self) -> &'static str {
        "sftp"
    }

    async fn home_dir(&self) -> AppResult<String> {
        let sftp = self.open_sftp().await?;
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

    async fn list_dir(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let sftp = self.open_sftp().await?;
        let dir = sftp.read_dir(path).await?;

        let mut pending = Vec::new();
        let mut uid_set = HashSet::new();
        let mut gid_set = HashSet::new();
        for entry in dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let file_type = entry.file_type();
            let is_symlink = file_type == FileType::Symlink;
            let full_path = join_remote_child(normalize_remote_dir_path(path), &name);
            let is_symlink_to_dir = is_symlink
                && sftp
                    .metadata(&full_path)
                    .await
                    .ok()
                    .as_ref()
                    .map_or(false, sftp_attrs_is_dir);
            let is_dir = file_type == FileType::Dir || is_symlink_to_dir;
            let type_char = if is_dir {
                if is_symlink { 'l' } else { 'd' }
            } else if is_symlink {
                'l'
            } else {
                '-'
            };

            let attrs = entry.metadata();
            let size = attrs.size.unwrap_or(0);
            let perms = attrs.permissions.unwrap_or(0);
            let permissions = permissions_to_string(perms, type_char);
            let mtime = u64::from(attrs.mtime.unwrap_or(0));

            if attrs
                .user
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            {
                if let Some(uid) = attrs.uid {
                    uid_set.insert(uid);
                }
            }
            if attrs
                .group
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            {
                if let Some(gid) = attrs.gid {
                    gid_set.insert(gid);
                }
            }

            pending.push((name, is_dir, is_symlink, size, permissions, attrs, mtime));
        }

        let _ = sftp.close().await;
        let user_names = self.resolve_uid_names(uid_set).await;
        let group_names = self.resolve_gid_names(gid_set).await;
        let entries = pending
            .into_iter()
            .map(
                |(name, is_dir, is_symlink, size, permissions, attrs, mtime)| FileEntry {
                    name,
                    is_dir,
                    is_symlink,
                    size,
                    permissions,
                    owner: attrs
                        .uid
                        .and_then(|uid| user_names.get(&uid).cloned())
                        .unwrap_or_else(|| owner_or_id(&attrs.user, attrs.uid)),
                    group: attrs
                        .gid
                        .and_then(|gid| group_names.get(&gid).cloned())
                        .unwrap_or_else(|| group_or_id(&attrs.group, attrs.gid)),
                    mtime,
                },
            )
            .collect();
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> AppResult<FileProperties> {
        let sftp = self.open_sftp().await?;
        let attrs = sftp.symlink_metadata(path).await?;
        let is_symlink = sftp_attrs_is_symlink(&attrs);
        let target_attrs = if is_symlink {
            sftp.metadata(path).await.ok()
        } else {
            None
        };
        let _ = sftp.close().await;

        let perms = attrs.permissions.unwrap_or(0);
        let is_dir =
            sftp_attrs_is_dir(&attrs) || target_attrs.as_ref().map_or(false, sftp_attrs_is_dir);
        let type_char = if is_dir {
            if is_symlink { 'l' } else { 'd' }
        } else if is_symlink {
            'l'
        } else {
            '-'
        };
        let permissions = permissions_to_string(perms, type_char);
        let name = path.split('/').last().unwrap_or(path).to_string();
        let owner = if let Some(uid) = attrs.uid {
            self.resolve_uid_names(HashSet::from([uid]))
                .await
                .get(&uid)
                .cloned()
                .unwrap_or_else(|| owner_or_id(&attrs.user, attrs.uid))
        } else {
            owner_or_id(&attrs.user, attrs.uid)
        };
        let group = if let Some(gid) = attrs.gid {
            self.resolve_gid_names(HashSet::from([gid]))
                .await
                .get(&gid)
                .cloned()
                .unwrap_or_else(|| group_or_id(&attrs.group, attrs.gid))
        } else {
            group_or_id(&attrs.group, attrs.gid)
        };

        Ok(FileProperties {
            name,
            is_dir,
            is_symlink,
            size: attrs.size.unwrap_or(0),
            permissions,
            owner,
            group,
            uid: attrs.uid.map_or_else(String::new, |v| v.to_string()),
            gid: attrs.gid.map_or_else(String::new, |v| v.to_string()),
            mtime: u64::from(attrs.mtime.unwrap_or(0)),
            atime: u64::from(attrs.atime.unwrap_or(0)),
        })
    }

    async fn mkdir(&self, path: &str, mode: Option<String>) -> AppResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.create_dir(path).await?;
        if let Some(ref m) = mode {
            apply_remote_mode_after_create(&sftp, path, m, "directory").await?;
        }
        let _ = sftp.close().await;
        Ok(())
    }

    async fn remove_file(&self, path: &str) -> AppResult<()> {
        let sftp = self.open_sftp().await?;
        let meta = sftp.symlink_metadata(path).await?;

        if sftp_attrs_is_symlink(&meta) {
            sftp.remove_file(path).await?;
        } else if sftp_attrs_is_dir(&meta) {
            remove_dir_recursive(&sftp, path).await?;
        } else {
            sftp.remove_file(path).await?;
        }
        let _ = sftp.close().await;
        Ok(())
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> AppResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.rename(old_path, new_path).await?;
        let _ = sftp.close().await;
        Ok(())
    }

    async fn create_file(&self, path: &str, mode: Option<String>) -> AppResult<()> {
        let sftp = self.open_sftp().await?;
        let file = sftp.create(path).await?;
        drop(file);
        if let Some(ref m) = mode {
            apply_remote_mode_after_create(&sftp, path, m, "file").await?;
        }
        let _ = sftp.close().await;
        Ok(())
    }

    async fn create_symlink(&self, link_path: &str, target_path: &str) -> AppResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.symlink(link_path, target_path).await?;
        let _ = sftp.close().await;
        Ok(())
    }

    async fn update_attrs(&self, path: &str, update: &RemoteFileAttributeUpdate) -> AppResult<()> {
        let mode = update
            .mode
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(parse_octal_mode)
            .transpose()?
            .map(|value| value & POSIX_MODE_MASK);
        let uid = match update
            .owner
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            Some(owner) => Some(self.resolve_user_to_uid(owner).await?),
            None => None,
        };
        let gid = match update
            .group
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            Some(group) => Some(self.resolve_group_to_gid(group).await?),
            None => None,
        };

        if mode.is_none() && uid.is_none() && gid.is_none() {
            return Ok(());
        }

        let sftp = self.open_sftp().await?;
        if update.recursive {
            apply_remote_attrs_recursive(&sftp, path, mode, uid, gid).await?;
        } else {
            apply_remote_attrs(&sftp, path, mode, uid, gid).await?;
        }
        let _ = sftp.close().await;
        Ok(())
    }

    async fn read_file_text(&self, path: &str, max_bytes: u64) -> AppResult<RemoteTextFile> {
        use tokio::io::AsyncReadExt;

        let sftp = self.open_sftp().await?;
        let attrs = sftp.metadata(path).await?;
        let size = attrs.size.unwrap_or(0);
        let type_bits = attrs.permissions.unwrap_or(0) & SFTP_FILE_TYPE_MASK;
        if type_bits == 0o040000 {
            let _ = sftp.close().await;
            return Err(AppError::Config(
                "Directories are not supported for AI file analysis".to_string(),
            ));
        }
        if size > max_bytes {
            let _ = sftp.close().await;
            return Err(AppError::Config(format!(
                "File is too large for AI analysis ({} bytes > {} bytes)",
                size, max_bytes
            )));
        }

        let mut file = sftp
            .open(path)
            .await
            .map_err(|error| AppError::Channel(format!("Failed to open remote file: {error}")))?;
        let mut bytes = Vec::with_capacity(size as usize);
        file.read_to_end(&mut bytes)
            .await
            .map_err(|error| AppError::Channel(format!("Failed to read remote file: {error}")))?;
        let _ = sftp.close().await;

        if bytes.len() as u64 > max_bytes {
            return Err(AppError::Config(format!(
                "File is too large for AI analysis ({} bytes > {} bytes)",
                bytes.len(),
                max_bytes
            )));
        }
        if bytes.contains(&0) {
            return Err(AppError::Config(
                "Binary files are not supported for AI analysis".to_string(),
            ));
        }
        let content = String::from_utf8(bytes).map_err(|_| {
            AppError::Config("Only UTF-8 text files are supported for AI analysis".to_string())
        })?;

        Ok(RemoteTextFile {
            path: path.to_string(),
            content,
            size,
        })
    }

    async fn download_file(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        transfer_settings: &crate::config::TransferSettings,
        transfer_id: Option<String>,
    ) -> AppResult<()> {
        let max_retries = transfer_settings.max_transfer_retries;
        let safe_local_path = sanitize_local_download_target(local_path, remote_path);
        let actual_local_path =
            match resolve_local_path(&safe_local_path, &transfer_settings.duplicate_strategy) {
                Some(path) => path,
                None => {
                    let file_name = remote_path.split('/').last().unwrap_or(remote_path);
                    let transfer_id = transfer_id
                        .clone()
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    remember_transfer_target_external(
                        transfer_id.clone(),
                        safe_local_path.clone(),
                        "download".to_string(),
                        "file".to_string(),
                    );
                    let _ = app.emit(
                        "transfer-event",
                        &TransferEvent {
                            id: transfer_id,
                            session_id: session_id.to_string(),
                            file_name: file_name.to_string(),
                            remote_path: remote_path.to_string(),
                            local_path: safe_local_path,
                            direction: "download".to_string(),
                            kind: "file".to_string(),
                            status: "completed".to_string(),
                            size: 0,
                            bytes_transferred: 0,
                            total_size: 0,
                            parent_id: None,
                            item_count_total: None,
                            item_count_completed: None,
                            error_msg: None,
                        },
                    );
                    return Ok(());
                }
            };

        let mut last_err = None;
        for attempt in 0..=max_retries {
            if attempt > 0 {
                log_event(StructuredLog {
                    level: StructuredLogLevel::Info,
                    domain: "transfer.lifecycle".to_string(),
                    event: "transfer.retry".to_string(),
                    message: "Retrying download".to_string(),
                    ids: Some(serde_json::json!({ "session_id": session_id })),
                    data: Some(serde_json::json!({
                        "direction": "download",
                        "attempt": attempt,
                        "remote_path": remote_path,
                    })),
                    error: None,
                    client_timestamp: None,
                });
            }
            match download_remote_file_inner_with_controller(
                self,
                app,
                session_id,
                remote_path,
                &actual_local_path,
                transfer_settings,
                create_child_file_transfer_controller(
                    transfer_id.clone(),
                    session_id,
                    file_name_from_path(remote_path),
                    remote_path,
                    &actual_local_path,
                    "download",
                    None,
                ),
                None,
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

    async fn upload_file(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        transfer_settings: &crate::config::TransferSettings,
        transfer_id: Option<String>,
    ) -> AppResult<()> {
        let max_retries = transfer_settings.max_transfer_retries;
        let session_manager = app.state::<Arc<crate::core::SessionManager>>();
        let sftp_for_resolve = self.open_sftp().await?;
        let actual_remote_path = match resolve_remote_path(
            app,
            session_manager.inner(),
            &sftp_for_resolve,
            session_id,
            remote_path,
            &transfer_settings.duplicate_strategy,
        )
        .await
        {
            Some(path) => path,
            None => {
                let _ = sftp_for_resolve.close().await;
                return Ok(());
            }
        };
        let _ = sftp_for_resolve.close().await;

        let mut last_err = None;
        for attempt in 0..=max_retries {
            if attempt > 0 {
                log_event(StructuredLog {
                    level: StructuredLogLevel::Info,
                    domain: "transfer.lifecycle".to_string(),
                    event: "transfer.retry".to_string(),
                    message: "Retrying upload".to_string(),
                    ids: Some(serde_json::json!({ "session_id": session_id })),
                    data: Some(serde_json::json!({
                        "direction": "upload",
                        "attempt": attempt,
                        "local_path": local_path,
                    })),
                    error: None,
                    client_timestamp: None,
                });
            }
            match upload_local_file_inner_with_controller(
                self,
                app,
                session_id,
                local_path,
                &actual_remote_path,
                transfer_settings,
                create_child_file_transfer_controller(
                    transfer_id.clone(),
                    session_id,
                    file_name_from_path(&actual_remote_path),
                    &actual_remote_path,
                    local_path,
                    "upload",
                    None,
                ),
                None,
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

    async fn download_directory(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        transfer_id: Option<String>,
    ) -> AppResult<()> {
        let transfer_settings = crate::config::load_app_settings(app)
            .map(|s| s.transfer)
            .unwrap_or_default();
        let (request_kib, pipeline_depth, max_concurrent_writes) =
            sftp_pipeline_config(&transfer_settings);
        let concurrent_tasks =
            background_transfer_task_concurrency(transfer_settings.download_threads);
        let transfer_started = Instant::now();
        let total_files = self.count_remote_files(remote_path).await?;
        let directory_controller = create_directory_transfer_controller(
            transfer_id,
            session_id,
            file_name_from_path(remote_path),
            remote_path,
            local_path,
            "download",
            total_files,
            0,
        );
        register_transfer(directory_controller.clone());
        let _ = app.emit(
            "transfer-event",
            &directory_controller.build_event("started", 0, None),
        );

        let result = async {
            let mut files = Vec::new();
            self.collect_remote_directory_files(
                remote_path,
                local_path,
                &directory_controller,
                &mut files,
            )
            .await?;
            self.download_remote_directory_files(
                app,
                session_id,
                files,
                directory_controller.clone(),
                &transfer_settings,
            )
            .await
        }
        .await;

        match result {
            Ok(completed_count) => {
                log_transfer_performance(
                    "download",
                    "directory",
                    0,
                    transfer_started.elapsed(),
                    request_kib,
                    pipeline_depth,
                    max_concurrent_writes,
                    concurrent_tasks,
                );
                directory_controller.update_item_progress(completed_count, total_files);
                let _ = app.emit(
                    "transfer-event",
                    &directory_controller.build_event("completed", 0, None),
                );
                unregister_transfer(&directory_controller.id());
                Ok(())
            }
            Err(e) => {
                if matches!(e, AppError::Cancelled(_)) {
                    let _ = app.emit(
                        "transfer-event",
                        &directory_controller.build_event("cancelled", 0, None),
                    );
                    cleanup_cancelled_download(local_path).await;
                } else {
                    let _ = app.emit(
                        "transfer-event",
                        &directory_controller.build_event("error", 0, Some(e.to_string())),
                    );
                }
                unregister_transfer(&directory_controller.id());
                Err(e)
            }
        }
    }

    async fn upload_directory(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        transfer_settings: &crate::config::TransferSettings,
        transfer_id: Option<String>,
    ) -> AppResult<()> {
        let session_manager = app.state::<Arc<crate::core::SessionManager>>();
        let sftp_for_check = self.open_sftp().await?;
        if !ensure_remote_upload_target_allowed(
            app,
            session_manager.inner(),
            &sftp_for_check,
            session_id,
            remote_path,
            &transfer_settings.duplicate_strategy,
        )
        .await
        {
            let _ = sftp_for_check.close().await;
            return Ok(());
        }
        let _ = sftp_for_check.close().await;

        let (request_kib, pipeline_depth, max_concurrent_writes) =
            sftp_pipeline_config(transfer_settings);
        let concurrent_tasks =
            background_transfer_task_concurrency(transfer_settings.upload_threads);
        let transfer_started = Instant::now();
        let local_stats = collect_local_directory_stats(local_path).await?;
        let directory_controller = create_directory_transfer_controller(
            transfer_id,
            session_id,
            file_name_from_path(local_path),
            remote_path,
            local_path,
            "upload",
            local_stats.file_count,
            local_stats.total_size,
        );
        register_transfer(directory_controller.clone());
        let _ = app.emit(
            "transfer-event",
            &directory_controller.build_event("started", 0, None),
        );

        let result = async {
            let mut files = Vec::new();
            self.collect_local_directory_files(
                local_path,
                remote_path,
                &directory_controller,
                &mut files,
            )
            .await?;
            self.upload_local_directory_files(
                app,
                session_id,
                files,
                directory_controller.clone(),
                &transfer_settings,
            )
            .await
        }
        .await;

        match result {
            Ok(completed_count) => {
                log_transfer_performance(
                    "upload",
                    "directory",
                    local_stats.total_size,
                    transfer_started.elapsed(),
                    request_kib,
                    pipeline_depth,
                    max_concurrent_writes,
                    concurrent_tasks,
                );
                directory_controller
                    .update_progress(local_stats.total_size, local_stats.total_size);
                directory_controller.update_item_progress(completed_count, local_stats.file_count);
                let _ = app.emit(
                    "transfer-event",
                    &directory_controller.build_event("completed", 0, None),
                );
                unregister_transfer(&directory_controller.id());
                Ok(())
            }
            Err(e) => {
                if matches!(e, AppError::Cancelled(_)) {
                    let _ = app.emit(
                        "transfer-event",
                        &directory_controller.build_event("cancelled", 0, None),
                    );
                    let _ = cleanup_cancelled_upload(self, remote_path).await;
                } else {
                    let _ = app.emit(
                        "transfer-event",
                        &directory_controller.build_event("error", 0, Some(e.to_string())),
                    );
                }
                unregister_transfer(&directory_controller.id());
                Err(e)
            }
        }
    }
}

#[derive(Clone)]
struct RemoteDirectoryFile {
    name: String,
    remote_path: String,
    local_path: String,
}

#[derive(Clone)]
struct LocalDirectoryFile {
    name: String,
    local_path: String,
    remote_path: String,
}

impl SftpBackend {
    async fn count_remote_files(&self, remote_path: &str) -> AppResult<u64> {
        let mut count = 0;
        let mut stack = vec![remote_path.to_string()];
        while let Some(path) = stack.pop() {
            let entries = self.list_dir(&path).await?;
            for entry in entries {
                let child_remote = format!("{}/{}", path.trim_end_matches('/'), entry.name);
                if entry.is_dir {
                    stack.push(child_remote);
                } else if !entry.is_symlink {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    async fn collect_remote_directory_files(
        &self,
        remote_path: &str,
        local_path: &str,
        directory_controller: &Arc<TransferController>,
        files: &mut Vec<RemoteDirectoryFile>,
    ) -> AppResult<()> {
        wait_for_transfer_ready(directory_controller).await?;

        tokio::fs::create_dir_all(local_path)
            .await
            .map_err(|e| AppError::Channel(format!("Failed to create local dir: {}", e)))?;

        let entries = self.list_dir(remote_path).await?;

        for entry in entries {
            wait_for_transfer_ready(directory_controller).await?;

            let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), entry.name);
            let child_local = append_safe_local_child_path(local_path, &entry.name);

            if entry.is_dir {
                Box::pin(self.collect_remote_directory_files(
                    &child_remote,
                    &child_local,
                    directory_controller,
                    files,
                ))
                .await?;
            } else if !entry.is_symlink {
                files.push(RemoteDirectoryFile {
                    name: entry.name,
                    remote_path: child_remote,
                    local_path: child_local,
                });
            }
        }

        Ok(())
    }

    async fn collect_local_directory_files(
        &self,
        local_path: &str,
        remote_path: &str,
        directory_controller: &Arc<TransferController>,
        files: &mut Vec<LocalDirectoryFile>,
    ) -> AppResult<()> {
        wait_for_transfer_ready(directory_controller).await?;

        let sftp = self.open_sftp().await?;
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
            wait_for_transfer_ready(directory_controller).await?;

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
                Box::pin(self.collect_local_directory_files(
                    &child_local,
                    &child_remote,
                    directory_controller,
                    files,
                ))
                .await?;
            } else if file_type.is_file() {
                files.push(LocalDirectoryFile {
                    name: entry_name,
                    local_path: child_local,
                    remote_path: child_remote,
                });
            }
        }

        Ok(())
    }

    async fn download_remote_directory_files(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        files: Vec<RemoteDirectoryFile>,
        directory_controller: Arc<TransferController>,
        transfer_settings: &crate::config::TransferSettings,
    ) -> AppResult<u64> {
        if files.is_empty() {
            return Ok(0);
        }

        let concurrency = background_transfer_task_concurrency(transfer_settings.download_threads)
            .min(files.len())
            .max(1);
        let completed_count = Arc::new(AtomicU64::new(0));
        let total = directory_controller
            .item_count_total()
            .unwrap_or(files.len() as u64);
        let mut join_set: tokio::task::JoinSet<AppResult<()>> = tokio::task::JoinSet::new();
        let mut next_index = 0usize;
        let mut first_err: Option<AppError> = None;

        while next_index < files.len() && join_set.len() < concurrency {
            self.spawn_download_directory_file(
                &mut join_set,
                app,
                session_id,
                files[next_index].clone(),
                directory_controller.clone(),
                transfer_settings.clone(),
            );
            next_index += 1;
        }

        while let Some(result) = join_set.join_next().await {
            match result {
                Ok(Ok(())) => {
                    let completed = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
                    directory_controller.update_item_progress(completed, total);
                    let _ = app.emit(
                        "transfer-event",
                        &directory_controller.build_event("progress", 0, None),
                    );
                    if first_err.is_none() {
                        while next_index < files.len() && join_set.len() < concurrency {
                            self.spawn_download_directory_file(
                                &mut join_set,
                                app,
                                session_id,
                                files[next_index].clone(),
                                directory_controller.clone(),
                                transfer_settings.clone(),
                            );
                            next_index += 1;
                        }
                    }
                }
                Ok(Err(error)) => {
                    if first_err.is_none() {
                        first_err = Some(error);
                    }
                }
                Err(error) => {
                    if first_err.is_none() {
                        first_err = Some(AppError::Channel(format!(
                            "Directory download task panicked: {}",
                            error
                        )));
                    }
                }
            }
        }

        if let Some(error) = first_err {
            Err(error)
        } else {
            Ok(completed_count.load(Ordering::SeqCst))
        }
    }

    fn spawn_download_directory_file(
        &self,
        join_set: &mut tokio::task::JoinSet<AppResult<()>>,
        app: &tauri::AppHandle,
        session_id: &str,
        file: RemoteDirectoryFile,
        directory_controller: Arc<TransferController>,
        transfer_settings: crate::config::TransferSettings,
    ) {
        let backend = self.clone();
        let app = app.clone();
        let session_id = session_id.to_string();
        join_set.spawn(async move {
            wait_for_transfer_ready(&directory_controller).await?;
            let child_controller = create_child_file_transfer_controller(
                None,
                &session_id,
                file.name,
                &file.remote_path,
                &file.local_path,
                "download",
                Some(directory_controller.id()),
            );
            download_remote_file_inner_with_controller(
                &backend,
                &app,
                &session_id,
                &file.remote_path,
                &file.local_path,
                &transfer_settings,
                child_controller,
                Some(directory_controller),
            )
            .await
        });
    }

    async fn upload_local_directory_files(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        files: Vec<LocalDirectoryFile>,
        directory_controller: Arc<TransferController>,
        transfer_settings: &crate::config::TransferSettings,
    ) -> AppResult<u64> {
        if files.is_empty() {
            return Ok(0);
        }

        let concurrency = background_transfer_task_concurrency(transfer_settings.upload_threads)
            .min(files.len())
            .max(1);
        let completed_count = Arc::new(AtomicU64::new(0));
        let total = directory_controller
            .item_count_total()
            .unwrap_or(files.len() as u64);
        let mut join_set: tokio::task::JoinSet<AppResult<()>> = tokio::task::JoinSet::new();
        let mut next_index = 0usize;
        let mut first_err: Option<AppError> = None;

        while next_index < files.len() && join_set.len() < concurrency {
            self.spawn_upload_directory_file(
                &mut join_set,
                app,
                session_id,
                files[next_index].clone(),
                directory_controller.clone(),
                transfer_settings.clone(),
            );
            next_index += 1;
        }

        while let Some(result) = join_set.join_next().await {
            match result {
                Ok(Ok(())) => {
                    let completed = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
                    directory_controller.update_item_progress(completed, total);
                    let _ = app.emit(
                        "transfer-event",
                        &directory_controller.build_event("progress", 0, None),
                    );
                    if first_err.is_none() {
                        while next_index < files.len() && join_set.len() < concurrency {
                            self.spawn_upload_directory_file(
                                &mut join_set,
                                app,
                                session_id,
                                files[next_index].clone(),
                                directory_controller.clone(),
                                transfer_settings.clone(),
                            );
                            next_index += 1;
                        }
                    }
                }
                Ok(Err(error)) => {
                    if first_err.is_none() {
                        first_err = Some(error);
                    }
                }
                Err(error) => {
                    if first_err.is_none() {
                        first_err = Some(AppError::Channel(format!(
                            "Directory upload task panicked: {}",
                            error
                        )));
                    }
                }
            }
        }

        if let Some(error) = first_err {
            Err(error)
        } else {
            Ok(completed_count.load(Ordering::SeqCst))
        }
    }

    fn spawn_upload_directory_file(
        &self,
        join_set: &mut tokio::task::JoinSet<AppResult<()>>,
        app: &tauri::AppHandle,
        session_id: &str,
        file: LocalDirectoryFile,
        directory_controller: Arc<TransferController>,
        transfer_settings: crate::config::TransferSettings,
    ) {
        let backend = self.clone();
        let app = app.clone();
        let session_id = session_id.to_string();
        join_set.spawn(async move {
            wait_for_transfer_ready(&directory_controller).await?;
            let child_controller = create_child_file_transfer_controller(
                None,
                &session_id,
                file.name,
                &file.remote_path,
                &file.local_path,
                "upload",
                Some(directory_controller.id()),
            );
            upload_local_file_inner_with_controller(
                &backend,
                &app,
                &session_id,
                &file.local_path,
                &file.remote_path,
                &transfer_settings,
                child_controller,
                Some(directory_controller),
            )
            .await
        });
    }
}
