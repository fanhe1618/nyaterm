//! Tauri command handlers and app entry point.
//!
//! Registers all invoke handlers, manages SessionManager state, and sets up tracing.

mod commands;
mod config;
mod crypto;
mod error;
mod fuzzy;
mod import;
mod pty;
mod session;
mod sftp;
mod ssh;
mod translate;
pub mod watcher;

use session::SessionManager;
use std::sync::Arc;
use tauri::Manager;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

fn init_tracing(log_dir: std::path::PathBuf) {
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("dragonfly")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&log_dir)
        .expect("failed to initialize rolling file appender");

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("dragonfly=info,warn"));

    let local_time = fmt::time::OffsetTime::local_rfc_3339().unwrap_or_else(|_| {
        fmt::time::OffsetTime::new(
            time::UtcOffset::UTC,
            time::format_description::well_known::Rfc3339,
        )
    });

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_writer(file_appender)
                .with_ansi(false)
                .with_target(true)
                .with_timer(local_time.clone()),
        )
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .compact()
                .with_timer(local_time),
        )
        .init();

    tracing::info!("Dragonfly starting");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session_manager = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session_manager.clone())
        .setup(move |app| {
            let home_dir = app
                .path()
                .home_dir()
                .map_err(|e: tauri::Error| e.to_string())?;

            let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
            init_tracing(log_dir);

            let config_dir = home_dir.join(".dragonfly");
            let mgr = session_manager.clone();
            tauri::async_runtime::spawn(async move {
                mgr.init_history_store(config_dir).await;
            });

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Dragonfly")
                .on_tray_icon_event(|tray, event| match event {
                    tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } => {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if let Ok(settings) = crate::config::load_app_settings(window.app_handle()) {
                        if settings.general.minimize_to_tray {
                            let _ = window.hide();
                            api.prevent_close();
                            return;
                        }
                    }
                    // Main window closing: close all child windows
                    for label in &["settings", "new-session", "quick-command"] {
                        if let Some(child) = window.app_handle().get_webview_window(label) {
                            let _ = child.close();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::stats::get_system_fonts,
            commands::session_cmds::create_ssh_session,
            commands::session_cmds::create_local_session,
            commands::session_cmds::write_to_session,
            commands::session_cmds::resize_session,
            commands::session_cmds::attach_session,
            commands::session_cmds::close_session,
            commands::session_cmds::list_sessions,
            commands::session_cmds::add_command_history,
            commands::session_cmds::get_command_history,
            commands::session_cmds::fuzzy_search_history,
            commands::session_cmds::fuzzy_search_commands,
            commands::sftp_cmds::get_home_dir,
            commands::sftp_cmds::list_remote_dir,
            commands::sftp_cmds::delete_remote_file,
            commands::sftp_cmds::rename_remote_file,
            commands::sftp_cmds::download_remote_file,
            commands::sftp_cmds::upload_local_file,
            commands::sftp_cmds::get_file_properties,
            commands::sftp_cmds::chmod_remote_file,
            commands::config_cmds::get_saved_connections,
            commands::config_cmds::save_connection,
            commands::config_cmds::delete_connection,
            commands::config_cmds::reorder_items,
            commands::config_cmds::get_ssh_keys,
            commands::config_cmds::save_ssh_key,
            commands::config_cmds::delete_ssh_key,
            commands::config_cmds::get_groups,
            commands::config_cmds::save_group,
            commands::config_cmds::delete_group,
            commands::config_cmds::clear_all_connections,
            commands::config_cmds::get_quick_commands,
            commands::config_cmds::save_quick_commands,
            commands::settings_cmds::get_app_settings,
            commands::settings_cmds::save_app_settings,
            commands::settings_cmds::verify_lock_password,
            watcher::start_file_watch,
            watcher::stop_file_watch,
            translate::translate_text,
            import::import_sessions,
            commands::stats::get_remote_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
