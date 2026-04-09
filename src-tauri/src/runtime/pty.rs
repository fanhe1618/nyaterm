//! Local PTY (pseudo-terminal) session creation and management.
//!
//! Spawns the user's shell (PowerShell on Windows, $SHELL elsewhere) and bridges I/O to Tauri.

use super::recording::RecordingManager;
use super::session::{
    SessionCommand, SessionHandle, SessionInfo, SessionManager, SessionType, SharedCwd,
};
use crate::error::AppResult;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

/// Extracts the path from an OSC 7 sequence (same logic as ssh.rs).
fn parse_osc7(text: &str) -> Option<String> {
    let start = text.find("\x1b]7;")?;
    let rest = &text[start + 4..];
    let end = rest.find('\x07').or_else(|| rest.find("\x1b\\"))?;
    let payload = &rest[..end];
    let after_scheme = payload.strip_prefix("file://")?;
    let path = if after_scheme.starts_with('/') {
        after_scheme.to_string()
    } else {
        let slash = after_scheme.find('/')?;
        after_scheme[slash..].to_string()
    };
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

struct OutputBuffer {
    attached: bool,
    buffer: Vec<String>,
}

fn get_default_shell(app: Option<&AppHandle>) -> (CommandBuilder, String) {
    let mut shell_cmd = String::new();

    if let Some(app) = app {
        if let Ok(settings) = crate::config::load_app_settings(app) {
            let user_shell = settings.general.default_local_shell;
            if !user_shell.trim().is_empty() {
                shell_cmd = user_shell;
            }
        }
    }

    if shell_cmd.is_empty() {
        #[cfg(target_os = "windows")]
        {
            shell_cmd = "powershell.exe".to_string();
        }
        #[cfg(not(target_os = "windows"))]
        {
            shell_cmd = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        }
    }

    let parts: Vec<&str> = shell_cmd.split_whitespace().collect();
    if parts.is_empty() {
        #[cfg(target_os = "windows")]
        return (
            CommandBuilder::new("powershell.exe"),
            "powershell.exe".to_string(),
        );
        #[cfg(not(target_os = "windows"))]
        return (CommandBuilder::new("/bin/bash"), "bash".to_string());
    } else {
        let mut builder = CommandBuilder::new(parts[0]);
        if parts.len() > 1 {
            builder.args(&parts[1..]);
        }
        (builder, parts[0].to_string())
    }
}

/// Spawns a local shell in a PTY and registers the session with the manager.
pub async fn create_local_session(
    app: AppHandle,
    manager: Arc<SessionManager>,
) -> AppResult<String> {
    tracing::info!("Creating local PTY session");
    let session_id = uuid::Uuid::new_v4().to_string();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

    let session_info = SessionInfo {
        id: session_id.clone(),
        name: "Local Terminal".to_string(),
        session_type: SessionType::Local,
        connected: true,
        injection_active: false,
    };

    let cwd: SharedCwd = Arc::new(tokio::sync::Mutex::new(None));
    let session_handle = SessionHandle {
        info: session_info,
        cmd_tx,
        ssh_config: None,
        ssh_handle: None,
        cwd: cwd.clone(),
    };
    manager.add_session(session_handle).await;

    let sid = session_id.clone();
    let mgr = manager.clone();
    let rt_handle = tokio::runtime::Handle::current();

    std::thread::spawn(move || {
        pty_session_thread(app, sid, mgr, cmd_rx, rt_handle, cwd);
    });

    Ok(session_id)
}

fn pty_session_thread(
    app: AppHandle,
    session_id: String,
    manager: Arc<SessionManager>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    rt_handle: tokio::runtime::Handle,
    cwd: SharedCwd,
) {
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Failed to open PTY: {}", e);
            let _ = app.emit(
                &format!("session-error-{}", session_id),
                format!("Failed to open PTY: {}", e),
            );
            return;
        }
    };

    let (cmd, shell_exe) = get_default_shell(Some(&app));
    let mut _child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to spawn shell: {}", e);
            let _ = app.emit(
                &format!("session-error-{}", session_id),
                format!("Failed to spawn shell: {}", e),
            );
            return;
        }
    };
    drop(pair.slave);

    let mut writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("Failed to take PTY writer: {}", e);
            return;
        }
    };

    // Inject shell integration scripts for OSC 7.
    // Each script ends with a unique OSC marker; the reader thread discards all
    // output until this marker is seen, so the injection is invisible to the user.
    let shell_exe = shell_exe.to_lowercase();
    let inject_sh = " if [ -z \"$DFLY_INJ\" ]; then export DFLY_INJ=1; __dfc() { printf \"\\033]7;file://%s%s\\007\" \"$HOSTNAME\" \"$PWD\"; }; [ -n \"$BASH_VERSION\" ] && PROMPT_COMMAND=\"__dfc; $PROMPT_COMMAND\"; [ -n \"$ZSH_VERSION\" ] && precmd_functions+=(__dfc); fi; if [ -n \"$BASH_VERSION\" ]; then __df_hl=$(HISTTIMEFORMAT= builtin history 1); if [ \"${__df_hl#*DFLY_INJ}\" != \"$__df_hl\" ]; then __df_hn=$(echo \"$__df_hl\" | awk '{print $1}'); if [ -n \"$__df_hn\" ]; then builtin history -d \"$__df_hn\" >/dev/null 2>&1 || true; fi; fi; unset __df_hl __df_hn; fi; printf '\\033]7777;DflyReady\\007'\n";
    let inject_fish = " if not set -q DFLY_INJ; set -gx DFLY_INJ 1; function __dfc_hook --on-event fish_prompt; printf \"\\033]7;file://%s%s\\007\" (hostname) $PWD; end; end; printf '\\033]7777;DflyReady\\007'\n";
    let inject_pwsh = " if (-not $env:DFLY_INJ) { $env:DFLY_INJ='1'; function prompt { $p = (pwd).ProviderPath; $h = [System.Net.Dns]::GetHostName(); Write-Host -NoNewline \"`e]7;file://$h$p`a\"; return \"PS $p> \" } }; Write-Host -NoNewline \"`e]7777;DflyReady`a\"\n";

    if shell_exe.contains("powershell") || shell_exe.contains("pwsh") {
        let _ = writer.write_all(inject_pwsh.as_bytes());
    } else if shell_exe.contains("fish") {
        let _ = writer.write_all(inject_fish.as_bytes());
    } else if shell_exe.contains("bash") || shell_exe.contains("zsh") || shell_exe.contains("sh") {
        let _ = writer.write_all(inject_sh.as_bytes());
    }

    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Failed to clone PTY reader: {}", e);
            return;
        }
    };
    let master = pair.master;

    let output_buf = Arc::new(Mutex::new(OutputBuffer {
        attached: false,
        buffer: Vec::new(),
    }));

    let app_read = app.clone();
    let sid_read = session_id.clone();
    let output_event = format!("terminal-output-{}", session_id);
    let buf_reader = output_buf.clone();

    const READY_MARKER: &str = "\x1b]7777;DflyReady\x07";

    let cwd_event = format!("cwd-changed-{}", session_id);
    let rt_for_reader = rt_handle.clone();
    let recording_mgr_reader: Option<Arc<RecordingManager>> = app
        .try_state::<Arc<RecordingManager>>()
        .map(|s| s.inner().clone());
    let sid_for_rec_reader = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut injecting = true;
        let mut leftover = String::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();

                    let text = if injecting {
                        leftover.push_str(&text);
                        if let Some(pos) = leftover.find(READY_MARKER) {
                            injecting = false;
                            let after = leftover[pos + READY_MARKER.len()..].to_string();
                            leftover.clear();
                            after
                        } else {
                            continue;
                        }
                    } else {
                        text
                    };

                    if text.is_empty() {
                        continue;
                    }

                    if let Some(ref rec) = recording_mgr_reader {
                        rec.write_output(&sid_for_rec_reader, &text);
                    }

                    if let Some(path) = parse_osc7(&text) {
                        let p = path.clone();
                        let cwd_ev = cwd_event.clone();
                        let app_ref = app_read.clone();
                        rt_for_reader.block_on(async {
                            *cwd.lock().await = Some(p);
                        });
                        let _ = app_ref.emit(&cwd_ev, &path);
                    }
                    let emit_now = {
                        let mut ob = buf_reader.lock().unwrap();
                        if ob.attached {
                            true
                        } else {
                            ob.buffer.push(text.clone());
                            false
                        }
                    };
                    if emit_now {
                        let _ = app_read.emit(&output_event, &text);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_read.emit(&format!("session-closed-{}", sid_read), ());
    });

    let recording_mgr: Option<Arc<RecordingManager>> = app
        .try_state::<Arc<RecordingManager>>()
        .map(|s| s.inner().clone());
    let output_event_cmd = format!("terminal-output-{}", session_id);
    while let Some(cmd) = cmd_rx.blocking_recv() {
        match cmd {
            SessionCommand::Attach => {
                let buffered = {
                    let mut ob = output_buf.lock().unwrap();
                    ob.attached = true;
                    ob.buffer.drain(..).collect::<Vec<_>>()
                };
                for text in buffered {
                    let _ = app.emit(&output_event_cmd, &text);
                }
            }
            SessionCommand::Write(data) => {
                if let Some(ref rec) = recording_mgr {
                    rec.write_input(&session_id, &data);
                }
                let _ = writer.write_all(&data);
                let _ = writer.flush();
            }
            SessionCommand::Resize { cols, rows } => {
                let _ = master.resize(PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            SessionCommand::Close => {
                break;
            }
        }
    }

    if let Some(ref rec) = recording_mgr {
        rec.cleanup_session(&session_id);
    }

    rt_handle.block_on(async {
        manager.remove_session(&session_id).await;
    });
    let _ = app.emit(&format!("session-closed-{}", session_id), ());
}
