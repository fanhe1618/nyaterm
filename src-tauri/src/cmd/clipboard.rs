use crate::core::{SessionManager, SessionType, sftp};
use serde::Serialize;
use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const CLIPBOARD_TIMEOUT: Duration = Duration::from_millis(1000);

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipboardPathPayload {
    FilePaths { paths: Vec<String> },
    ImageFile { path: String },
}

#[derive(Debug, Serialize)]
pub struct RemoteClipboardImagePayload {
    pub remote_path: String,
}

#[tauri::command]
pub async fn read_clipboard_text() -> Option<String> {
    let result = tokio::time::timeout(
        CLIPBOARD_TIMEOUT,
        tokio::task::spawn_blocking(|| {
            let mut clipboard = arboard::Clipboard::new().ok()?;
            clipboard.get_text().ok()
        }),
    )
    .await;

    match result {
        Ok(Ok(text)) => text,
        _ => None,
    }
}

#[tauri::command]
pub async fn read_clipboard_path_payload() -> Result<Option<ClipboardPathPayload>, String> {
    let result = tokio::time::timeout(
        CLIPBOARD_TIMEOUT,
        tokio::task::spawn_blocking(read_clipboard_path_payload_blocking),
    )
    .await;

    match result {
        Ok(Ok(Ok(payload))) => Ok(payload),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Ok(None),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn upload_clipboard_image_to_ssh(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    remote_dir: Option<String>,
) -> Result<Option<RemoteClipboardImagePayload>, String> {
    if !is_ssh_session(state.inner(), &session_id).await {
        return Ok(None);
    }

    let local_path = match tokio::task::spawn_blocking(read_clipboard_image_to_temp_png).await {
        Ok(Ok(Some(path))) => path,
        Ok(Ok(None)) | Err(_) => return Ok(None),
        Ok(Err(err)) => return Err(err),
    };

    let home_dir = sftp::get_home_dir(state.inner().clone(), &session_id)
        .await
        .map_err(|err| err.to_string())?;
    let remote_dir = resolve_remote_clipboard_image_dir(&home_dir, remote_dir.as_deref());
    ensure_remote_dir(state.inner().clone(), &session_id, &remote_dir).await?;
    let remote_path = join_remote_path(&remote_dir, &build_remote_clipboard_image_name());

    sftp::upload_local_file(
        app,
        state.inner().clone(),
        &session_id,
        &local_path.to_string_lossy(),
        &remote_path,
        None,
        Some("overwrite".to_string()),
    )
    .await
    .map_err(|err| err.to_string())?;

    Ok(Some(RemoteClipboardImagePayload { remote_path }))
}

async fn is_ssh_session(manager: &SessionManager, session_id: &str) -> bool {
    manager
        .session_info(session_id)
        .await
        .is_ok_and(|info| info.session_type == SessionType::SSH)
}

fn read_clipboard_path_payload_blocking() -> Result<Option<ClipboardPathPayload>, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(paths) = read_windows_clipboard_image_file_paths() {
            if !paths.is_empty() {
                return Ok(Some(ClipboardPathPayload::FilePaths { paths }));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(paths) = read_clipboard_text_image_paths() {
            if !paths.is_empty() {
                return Ok(Some(ClipboardPathPayload::FilePaths { paths }));
            }
        }
    }

    if let Some(path) = read_clipboard_image_data_to_file()? {
        return Ok(Some(ClipboardPathPayload::ImageFile { path }));
    }

    Ok(None)
}

fn read_clipboard_image_to_temp_png() -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(paths) = read_windows_clipboard_image_file_paths() {
            if let Some(path) = paths.first() {
                return normalize_image_file_to_temp_png(Path::new(path)).map(Some);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(paths) = read_clipboard_text_image_paths() {
            if let Some(path) = paths.first() {
                return normalize_image_file_to_temp_png(Path::new(path)).map(Some);
            }
        }
    }

    read_clipboard_image_data_to_file().map(|path| path.map(PathBuf::from))
}

fn read_clipboard_image_data_to_file() -> Result<Option<String>, String> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(_) => return Ok(None),
    };
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };

    let path = build_clipboard_image_path()?;
    let rgba = match image.bytes {
        Cow::Borrowed(bytes) => bytes.to_vec(),
        Cow::Owned(bytes) => bytes,
    };
    image::save_buffer_with_format(
        &path,
        &rgba,
        image.width as u32,
        image.height as u32,
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|err| format!("failed to save clipboard image: {err}"))?;

    Ok(Some(path.to_string_lossy().to_string()))
}

fn normalize_image_file_to_temp_png(path: &Path) -> Result<PathBuf, String> {
    if !is_supported_image_path(path) {
        return Err("clipboard image file is not a supported image".to_string());
    }

    let target_path = build_clipboard_image_path()?;
    let is_png = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));

    if is_png {
        fs::copy(path, &target_path)
            .map_err(|err| format!("failed to copy clipboard image file: {err}"))?;
        return Ok(target_path);
    }

    let image =
        image::open(path).map_err(|err| format!("failed to decode clipboard image: {err}"))?;
    image
        .save_with_format(&target_path, image::ImageFormat::Png)
        .map_err(|err| format!("failed to save clipboard image as png: {err}"))?;
    Ok(target_path)
}

fn build_clipboard_image_path() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir()
        .join("nyaterm")
        .join("clipboard-images");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create clipboard image directory: {err}"))?;

    let timestamp = time::OffsetDateTime::now_local()
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc())
        .format(time::macros::format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_else(|_| "19700101-000000".to_string());
    let suffix: u32 = rand::random();

    Ok(dir.join(format!("paste-{timestamp}-{suffix:08x}.png")))
}

fn build_remote_clipboard_image_name() -> String {
    let timestamp = time::OffsetDateTime::now_local()
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc())
        .format(time::macros::format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_else(|_| "19700101-000000".to_string());
    let suffix: u32 = rand::random();

    format!("nyaterm-clip-{timestamp}-{suffix:08x}.png")
}

fn resolve_remote_clipboard_image_dir(
    home_dir: &str,
    configured_remote_dir: Option<&str>,
) -> String {
    let home = normalize_remote_dir(home_dir);
    let Some(remote_dir) = configured_remote_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return join_remote_path(&home, ".cache/nyaterm/paste-images");
    };

    if let Some(rest) = remote_dir.strip_prefix("~/") {
        return join_remote_path(&home, rest);
    }
    if remote_dir == "~" {
        return home;
    }
    if remote_dir.starts_with('/') {
        return normalize_remote_dir(remote_dir);
    }

    join_remote_path(&home, remote_dir)
}

fn normalize_remote_dir(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed == "/" {
        return "/".to_string();
    }
    let trimmed = trimmed.trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed
    }
}

fn join_remote_path(parent: &str, child: &str) -> String {
    let parent = normalize_remote_dir(parent);
    let child = child.trim().trim_matches('/');
    if child.is_empty() {
        return parent;
    }
    if parent == "/" {
        format!("/{child}")
    } else {
        format!("{parent}/{child}")
    }
}

async fn ensure_remote_dir(
    manager: Arc<SessionManager>,
    session_id: &str,
    remote_dir: &str,
) -> Result<(), String> {
    let normalized = normalize_remote_dir(remote_dir);
    if normalized == "/" {
        return Ok(());
    }

    let mut current = String::new();
    for segment in normalized.split('/').filter(|segment| !segment.is_empty()) {
        current.push('/');
        current.push_str(segment);
        let _ = sftp::create_remote_dir(manager.clone(), session_id, &current, None).await;
    }

    Ok(())
}

fn is_supported_image_path(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
    )
}

#[cfg(not(target_os = "windows"))]
fn read_clipboard_text_image_paths() -> Option<Vec<String>> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let text = clipboard.get_text().ok()?;
    Some(parse_clipboard_text_image_paths(&text))
}

#[cfg(not(target_os = "windows"))]
fn parse_clipboard_text_image_paths(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_clipboard_path_text_line)
        .filter(|path| is_supported_image_path(path))
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn parse_clipboard_path_text_line(line: &str) -> Option<PathBuf> {
    let unwrapped = line
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            line.strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(line);

    if let Some(uri_path) = unwrapped.strip_prefix("file://") {
        let local_uri_path = uri_path.strip_prefix("localhost/").unwrap_or(uri_path);
        let decoded = urlencoding::decode(local_uri_path).ok()?;
        return Some(PathBuf::from(decoded.as_ref()));
    }

    let path = PathBuf::from(unwrapped);
    if path.is_absolute() { Some(path) } else { None }
}

#[cfg(target_os = "windows")]
fn read_windows_clipboard_image_file_paths() -> Option<Vec<String>> {
    use windows::Win32::{
        System::{
            DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard},
            Ole::CF_HDROP,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    };

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    unsafe {
        OpenClipboard(None).ok()?;
        let _guard = ClipboardGuard;
        let handle = GetClipboardData(CF_HDROP.0 as u32).ok()?;
        let hdrop = HDROP(handle.0);
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        if count == 0 {
            return Some(Vec::new());
        }

        let mut paths = Vec::new();
        for index in 0..count {
            let char_count = DragQueryFileW(hdrop, index, None);
            if char_count == 0 {
                continue;
            }

            let mut buffer = vec![0u16; char_count as usize + 1];
            let written = DragQueryFileW(hdrop, index, Some(&mut buffer));
            if written == 0 {
                continue;
            }

            let path = String::from_utf16_lossy(&buffer[..written as usize]);
            let path_buf = PathBuf::from(&path);
            if is_supported_image_path(&path_buf) {
                paths.push(path);
            }
        }

        Some(paths)
    }
}
