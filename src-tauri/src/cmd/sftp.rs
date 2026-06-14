use crate::core::SessionManager;
use crate::core::sftp::{self, TransferDuplicateManager};
use crate::core::sftp::duplicate::DuplicateChoice;
use crate::error::{AppError, AppResult};
use std::sync::Arc;

#[tauri::command]
pub async fn get_home_dir(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> AppResult<String> {
    sftp::get_home_dir(state.inner().clone(), &session_id).await
}

#[tauri::command]
pub async fn list_remote_dir(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> AppResult<Vec<sftp::FileEntry>> {
    sftp::list_remote_dir(state.inner().clone(), &session_id, &path).await
}

#[tauri::command]
pub async fn delete_remote_file(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    sftp::delete_remote_file(state.inner().clone(), &session_id, &path).await
}

#[tauri::command]
pub async fn rename_remote_file(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> AppResult<()> {
    sftp::rename_remote_file(state.inner().clone(), &session_id, &old_path, &new_path).await
}

#[tauri::command]
pub fn sanitize_download_file_name(name: String) -> String {
    sftp::sanitize_download_file_name(&name)
}

#[tauri::command]
pub async fn download_remote_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
) -> AppResult<()> {
    sftp::download_remote_file(
        app,
        state.inner().clone(),
        &session_id,
        &remote_path,
        &local_path,
        transfer_id,
    )
    .await
}

#[tauri::command]
pub async fn upload_local_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    duplicate_strategy_override: Option<String>,
) -> AppResult<()> {
    sftp::upload_local_file(
        app,
        state.inner().clone(),
        &session_id,
        &local_path,
        &remote_path,
        transfer_id,
        duplicate_strategy_override,
    )
    .await
}

#[tauri::command]
pub async fn get_file_properties(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> AppResult<sftp::FileProperties> {
    sftp::get_file_properties(state.inner().clone(), &session_id, &path).await
}

#[tauri::command]
pub async fn read_remote_file_text(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
    max_bytes: u64,
) -> AppResult<sftp::RemoteTextFile> {
    sftp::read_remote_file_text(state.inner().clone(), &session_id, &path, max_bytes).await
}

#[tauri::command]
pub async fn create_remote_file(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
    mode: Option<String>,
) -> AppResult<()> {
    sftp::create_remote_file(state.inner().clone(), &session_id, &path, mode).await
}

#[tauri::command]
pub async fn create_remote_dir(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
    mode: Option<String>,
) -> AppResult<()> {
    sftp::create_remote_dir(state.inner().clone(), &session_id, &path, mode).await
}

#[tauri::command]
pub async fn create_remote_symlink(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    link_path: String,
    target_path: String,
) -> AppResult<()> {
    sftp::create_remote_symlink(state.inner().clone(), &session_id, &link_path, &target_path).await
}

#[tauri::command]
pub async fn chmod_remote_file(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
    mode: String,
) -> AppResult<()> {
    sftp::chmod_remote_file(state.inner().clone(), &session_id, &path, &mode).await
}

#[tauri::command]
pub async fn update_remote_file_attributes(
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
    update: sftp::RemoteFileAttributeUpdate,
) -> AppResult<()> {
    sftp::update_remote_file_attributes(state.inner().clone(), &session_id, &path, update).await
}

#[tauri::command]
pub async fn download_remote_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
) -> AppResult<()> {
    sftp::download_remote_directory(
        app,
        state.inner().clone(),
        &session_id,
        &remote_path,
        &local_path,
        transfer_id,
    )
    .await
}

#[tauri::command]
pub async fn upload_local_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    duplicate_strategy_override: Option<String>,
) -> AppResult<()> {
    sftp::upload_local_directory(
        app,
        state.inner().clone(),
        &session_id,
        &local_path,
        &remote_path,
        transfer_id,
        duplicate_strategy_override,
    )
    .await
}

#[tauri::command]
pub async fn pause_transfer(app: tauri::AppHandle, transfer_id: String) -> AppResult<()> {
    sftp::pause_transfer(app, &transfer_id).await
}

#[tauri::command]
pub async fn resume_transfer(app: tauri::AppHandle, transfer_id: String) -> AppResult<()> {
    sftp::resume_transfer(app, &transfer_id).await
}

#[tauri::command]
pub async fn cancel_transfer(app: tauri::AppHandle, transfer_id: String) -> AppResult<()> {
    sftp::cancel_transfer(app, &transfer_id).await
}

#[tauri::command]
pub async fn respond_transfer_duplicate(
    state: tauri::State<'_, Arc<TransferDuplicateManager>>,
    request_id: String,
    action: String,
) -> AppResult<()> {
    let choice = DuplicateChoice::from_action(&action)
        .ok_or_else(|| AppError::Config(format!("Invalid duplicate action: {action}")))?;
    if state.respond(&request_id, choice).await {
        Ok(())
    } else {
        Err(AppError::Config(format!(
            "No pending duplicate prompt with id '{request_id}'"
        )))
    }
}
