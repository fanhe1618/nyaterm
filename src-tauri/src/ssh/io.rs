use super::client::{SshHandle, SshHandler};
use crate::error::{AppError, AppResult};
use crate::runtime::{RecordingManager, SessionCommand, SessionManager, SharedCwd};
use russh::{client, ChannelMsg};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

/// Extracts the path from an OSC 7 sequence.
/// Shell emits: `\x1b]7;file://hostname/path\x07` (or ST `\x1b\\` terminator).
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

/// Tries to detect the remote shell via an exec channel.
///
/// Returns `Some(shell_type)` when a recognisable shell path is returned,
/// or `None` when the exec channel fails / returns empty output — which is
/// the normal behaviour of non-standard "shells" such as JumpServer (koko).
async fn detect_shell_type(handle: &mut client::Handle<SshHandler>) -> Option<String> {
    let mut exec_channel = handle.channel_open_session().await.ok()?;
    exec_channel.exec(true, "echo $SHELL").await.ok()?;

    let mut output = String::new();
    while let Some(message) = exec_channel.wait().await {
        if let ChannelMsg::Data { ref data } = message {
            output.push_str(&String::from_utf8_lossy(data));
        }
    }

    let shell_name = output.trim().to_lowercase();
    if shell_name.is_empty() {
        return None;
    }

    if shell_name.contains("fish") {
        Some("fish".to_string())
    } else {
        Some("sh".to_string())
    }
}

fn shell_injection_script(shell_type: &str) -> &'static str {
    const SH_SCRIPT: &str = " if [ -z \"$DFLY_INJ\" ]; then export DFLY_INJ=1; __dfc() { printf \"\\033]7;file://%s%s\\007\" \"$HOSTNAME\" \"$PWD\"; }; [ -n \"$BASH_VERSION\" ] && PROMPT_COMMAND=\"__dfc; $PROMPT_COMMAND\"; [ -n \"$ZSH_VERSION\" ] && precmd_functions+=(__dfc); fi; if [ -n \"$BASH_VERSION\" ]; then __df_hl=$(HISTTIMEFORMAT= builtin history 1); if [ \"${__df_hl#*DFLY_INJ}\" != \"$__df_hl\" ]; then __df_hn=$(echo \"$__df_hl\" | awk '{print $1}'); if [ -n \"$__df_hn\" ]; then builtin history -d \"$__df_hn\" >/dev/null 2>&1 || true; fi; fi; unset __df_hl __df_hn; fi; printf '\\033]7777;DflyReady\\007'\n";
    const FISH_SCRIPT: &str = " if not set -q DFLY_INJ; set -gx DFLY_INJ 1; function __dfc_hook --on-event fish_prompt; printf \"\\033]7;file://%s%s\\007\" (hostname) $PWD; end; end; printf '\\033]7777;DflyReady\\007'\n";

    if shell_type == "fish" {
        FISH_SCRIPT
    } else {
        SH_SCRIPT
    }
}

/// Opens a PTY shell channel and optionally injects the OSC 7 helper script.
///
/// Returns `(channel, injection_active)`.  When `injection_active` is `false`
/// the shell is non-standard (e.g. JumpServer) and the I/O loop should start
/// in passthrough mode immediately without waiting for the DflyReady marker.
pub(super) async fn open_shell_channel(
    handle: &mut client::Handle<SshHandler>,
) -> AppResult<(russh::Channel<client::Msg>, bool)> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| AppError::Channel(format!("Failed to open channel: {}", error)))?;

    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|error| AppError::Channel(format!("PTY request failed: {}", error)))?;

    channel
        .request_shell(false)
        .await
        .map_err(|error| AppError::Channel(format!("Shell request failed: {}", error)))?;

    let injection_active = match detect_shell_type(handle).await {
        Some(shell_type) => {
            let _ = channel
                .data(shell_injection_script(&shell_type).as_bytes())
                .await;
            true
        }
        None => {
            tracing::debug!("Shell detection returned no output — skipping OSC7 injection");
            false
        }
    };

    Ok((channel, injection_active))
}

pub(super) async fn ssh_io_loop(
    app: AppHandle,
    session_id: String,
    manager: Arc<SessionManager>,
    mut channel: russh::Channel<client::Msg>,
    _handle: SshHandle,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    cwd: SharedCwd,
    connection_id: Option<String>,
    injection_active: bool,
) {
    const READY_MARKER: &str = "\x1b]7777;DflyReady\x07";
    // Safety-net: if the injection script was sent to a real shell but DflyReady
    // never arrived (edge case), give up after 3 s and fall through to passthrough.
    // When injection_active=false (JumpServer etc.) this timer is never armed.
    const INJECT_TIMEOUT_SECS: u64 = 3;

    let output_event = format!("terminal-output-{}", session_id);
    let cwd_event = format!("cwd-changed-{}", session_id);
    let closed_event = format!("session-closed-{}", session_id);

    let recording_mgr: Option<Arc<RecordingManager>> = app
        .try_state::<Arc<RecordingManager>>()
        .map(|state| state.inner().clone());

    let mut attached = false;
    let mut buffer: Vec<String> = Vec::new();
    let mut injecting = injection_active;
    let mut leftover = String::new();

    let inject_deadline =
        tokio::time::sleep(std::time::Duration::from_secs(INJECT_TIMEOUT_SECS));
    tokio::pin!(inject_deadline);

    loop {
        tokio::select! {
            biased;

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::Attach) => {
                        attached = true;
                        for text in buffer.drain(..) {
                            let _ = app.emit(&output_event, &text);
                        }
                    }
                    Some(SessionCommand::Write(data)) => {
                        if let Some(ref recorder) = recording_mgr {
                            recorder.write_input(&session_id, &data);
                        }
                        let _ = channel.data(&data[..]).await;
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCommand::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let text = String::from_utf8_lossy(data).to_string();

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

                        if let Some(ref recorder) = recording_mgr {
                            recorder.write_output(&session_id, &text);
                        }

                        if let Some(path) = parse_osc7(&text) {
                            *cwd.lock().await = Some(path.clone());
                            let _ = app.emit(&cwd_event, &path);
                        }

                        if attached {
                            let _ = app.emit(&output_event, &text);
                        } else {
                            buffer.push(text);
                        }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let text = String::from_utf8_lossy(data).to_string();
                        if let Some(ref recorder) = recording_mgr {
                            recorder.write_output(&session_id, &text);
                        }
                        if attached {
                            let _ = app.emit(&output_event, &text);
                        } else {
                            buffer.push(text);
                        }
                    }
                    Some(ChannelMsg::Eof) | None => break,
                    _ => {}
                }
            }
            // Injection fallback: the remote is not a standard shell that runs our
            // DflyReady script (e.g. JumpServer/koko).  Stop filtering and pass any
            // buffered bytes straight through so the terminal is not blank.
            _ = &mut inject_deadline, if injecting => {
                injecting = false;
                let flushed = std::mem::take(&mut leftover);
                tracing::debug!(
                    session_id = %session_id,
                    buffered_bytes = flushed.len(),
                    "Injection timeout — falling back to passthrough mode"
                );
                if !flushed.is_empty() {
                    if let Some(ref recorder) = recording_mgr {
                        recorder.write_output(&session_id, &flushed);
                    }
                    if attached {
                        let _ = app.emit(&output_event, &flushed);
                    } else {
                        buffer.push(flushed);
                    }
                }
            }
        }
    }

    if let Some(ref recorder) = recording_mgr {
        recorder.cleanup_session(&session_id);
    }

    manager.remove_session(&session_id).await;

    if let Some(ref conn_id) = connection_id {
        if let Some(tunnel_mgr) = app.try_state::<Arc<super::TunnelManager>>() {
            tunnel_mgr
                .close_auto_tunnels_for_connection(&app, conn_id)
                .await;
        }
    }

    tracing::info!(session_id = %session_id, "SSH session closed");
    let _ = app.emit(&closed_event, ());
}
