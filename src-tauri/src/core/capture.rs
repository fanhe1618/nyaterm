//! Marker-based output capture for AI Agent PTY command execution.
//!
//! Instead of opening a separate exec channel (which is unaware of nested
//! shells, containers, or SSH hops), we inject the command directly into the
//! interactive PTY wrapped with unique boundary markers, then intercept the
//! markers in the output stream to extract the command's output and exit code.
//!
//! Key design decisions:
//!
//! 1. The shell **echoes** everything written to the PTY. The command text
//!    itself appears in the output stream before the command runs. We handle
//!    this with a `WaitingForStart` phase that suppresses all output until
//!    the real START marker appears in the *execution* output.
//!
//! 2. The command text uses shell quoting (`''`) to break marker patterns
//!    so the echo text never contains a matchable `__DF_CMD_START_` or
//!    `__DF_CMD_END_` sequence. Only the actual `printf` output does.
//!
//! 3. Variable names avoid `__` to prevent the end-marker parser from
//!    finding false `__` suffixes inside echoed variable references.
//!
//! 4. After the END marker, a `PostCapture` phase suppresses the shell
//!    prompt that would otherwise appear as a blank line (since the
//!    command itself was invisible).

use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::oneshot;

/// Result returned to the caller when capture completes.
pub struct CapturedOutput {
    pub output: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

const MARKER_PREFIX: &str = "__DF_CMD_";

/// Build the shell snippet that wraps a user command with start/end markers.
///
/// The emitted text on the PTY will look like:
/// ```text
/// __DF_CMD_START_{marker_id}__
/// <command output>
/// __DF_CMD_END_{marker_id}_{exit_code}__
/// ```
///
/// The command text uses `''` quoting so that the **echoed** command line
/// never contains a matchable `__DF_CMD_START_` or `__DF_CMD_END_` pattern.
/// Only the `printf` execution output contains the full markers.
pub fn build_capture_command(marker_id: &str, command: &str) -> String {
    format!(
        " printf '\\n{MARKER_PREFIX}''START_{marker_id}__\\n'; {{ {command}; }}; _dfec=$?; printf '\\n{MARKER_PREFIX}''END_{marker_id}_'\"$_dfec\"'__\\n'; unset _dfec\n",
    )
}

#[derive(PartialEq)]
enum CapturePhase {
    /// Just registered — suppress all output (the echoed command text)
    /// until the real START marker appears in execution output.
    WaitingForStart,
    /// Between START and END markers — buffer output for the AI.
    Capturing,
    /// After the END marker — suppress the shell prompt that follows,
    /// then remove the capture.
    PostCapture,
}

/// Tracks one in-flight capture request.
struct ActiveCapture {
    buffer: String,
    phase: CapturePhase,
    start_time: Instant,
    result_tx: Option<oneshot::Sender<CapturedOutput>>,
}

/// Shared processor that all IO loops (SSH, PTY, Telnet, Serial) can use to
/// intercept marker sequences in the output stream.
pub struct OutputCaptureProcessor {
    active: HashMap<String, ActiveCapture>,
}

impl OutputCaptureProcessor {
    pub fn new() -> Self {
        Self {
            active: HashMap::new(),
        }
    }

    /// Register a new capture. The caller should then write the
    /// `build_capture_command()` output into the PTY.
    ///
    /// From this point, all output is suppressed until the START marker
    /// appears (hiding the echoed command text).
    pub fn register(&mut self, marker_id: String, result_tx: oneshot::Sender<CapturedOutput>) {
        self.active.insert(
            marker_id,
            ActiveCapture {
                buffer: String::new(),
                phase: CapturePhase::WaitingForStart,
                start_time: Instant::now(),
                result_tx: Some(result_tx),
            },
        );
    }

    /// Returns true when at least one capture is in progress.
    pub fn has_active(&self) -> bool {
        !self.active.is_empty()
    }

    /// Cancel a capture by marker id (e.g. on timeout from the caller side).
    #[allow(dead_code)]
    pub fn cancel(&mut self, marker_id: &str) {
        self.active.remove(marker_id);
    }

    /// Process a chunk of visible terminal output. Returns the portion of
    /// text that should be forwarded to the terminal (i.e. everything
    /// **not** consumed by an active capture).
    ///
    /// - **WaitingForStart**: all text is suppressed (command echo).
    /// - **Capturing**: text is buffered for the AI result.
    /// - **PostCapture**: text is suppressed (shell prompt after command).
    /// - When the END marker is found, captured output is sent through
    ///   the `oneshot` channel automatically.
    pub fn process(&mut self, text: &str) -> String {
        if self.active.is_empty() {
            return text.to_string();
        }

        let mut passthrough = String::with_capacity(text.len());
        let mut remaining = text;

        while !remaining.is_empty() {
            if let Some(result) = self.try_match_start(remaining) {
                remaining = result.after;
                continue;
            }

            if let Some(result) = self.try_match_end(remaining) {
                passthrough.push_str(result.before);
                remaining = result.after;
                continue;
            }

            if let Some(capture_id) = self.any_in_phase(CapturePhase::Capturing) {
                if let Some(pos) = remaining.find(MARKER_PREFIX) {
                    if let Some(cap) = self.active.get_mut(&capture_id) {
                        cap.buffer.push_str(&remaining[..pos]);
                    }
                    if pos == 0 {
                        // Prefix found at start but full marker not recognized
                        // (partial marker at chunk boundary or false prefix).
                        // Buffer the prefix bytes and skip to avoid infinite loop.
                        if let Some(cap) = self.active.get_mut(&capture_id) {
                            cap.buffer.push_str(MARKER_PREFIX);
                        }
                        remaining = &remaining[MARKER_PREFIX.len()..];
                    } else {
                        remaining = &remaining[pos..];
                    }
                } else {
                    if let Some(cap) = self.active.get_mut(&capture_id) {
                        cap.buffer.push_str(remaining);
                    }
                    remaining = "";
                }
            } else if let Some(capture_id) = self.any_in_phase(CapturePhase::PostCapture) {
                // Suppress the shell prompt that appears after the command.
                // Remove the capture so the next chunk passes through normally.
                self.active.remove(&capture_id);
                remaining = "";
            } else if self.any_in_phase(CapturePhase::WaitingForStart).is_some() {
                // Suppress everything — this is the echoed command text.
                // try_match_start above handles START marker detection.
                remaining = "";
            } else if let Some(pos) = remaining.find(MARKER_PREFIX) {
                passthrough.push_str(&remaining[..pos]);
                if pos == 0 {
                    passthrough.push_str(MARKER_PREFIX);
                    remaining = &remaining[MARKER_PREFIX.len()..];
                } else {
                    remaining = &remaining[pos..];
                }
            } else {
                passthrough.push_str(remaining);
                remaining = "";
            }
        }

        passthrough
    }

    fn any_in_phase(&self, target: CapturePhase) -> Option<String> {
        self.active
            .iter()
            .find(|(_, cap)| cap.phase == target)
            .map(|(id, _)| id.clone())
    }

    fn try_match_start<'a>(&mut self, text: &'a str) -> Option<MatchResult<'a>> {
        let prefix = format!("{MARKER_PREFIX}START_");
        let start_pos = text.find(&prefix)?;

        let after_prefix = &text[start_pos + prefix.len()..];
        let end_suffix = "__";
        let suffix_pos = after_prefix.find(end_suffix)?;

        let marker_id = &after_prefix[..suffix_pos];

        if !self.active.contains_key(marker_id) {
            return None;
        }

        if let Some(cap) = self.active.get_mut(marker_id) {
            cap.phase = CapturePhase::Capturing;
        }

        let marker_end = start_pos + prefix.len() + suffix_pos + end_suffix.len();
        let after_marker = &text[marker_end..];
        let after = after_marker.strip_prefix('\n').unwrap_or(after_marker);

        Some(MatchResult { before: "", after })
    }

    fn try_match_end<'a>(&mut self, text: &'a str) -> Option<MatchResult<'a>> {
        let prefix = format!("{MARKER_PREFIX}END_");
        let start_pos = text.find(&prefix)?;

        let after_prefix = &text[start_pos + prefix.len()..];
        let end_suffix = "__";
        let suffix_pos = after_prefix.find(end_suffix)?;

        let inner = &after_prefix[..suffix_pos];

        let last_underscore = inner.rfind('_')?;
        let marker_id = &inner[..last_underscore];
        let code_str = &inner[last_underscore + 1..];
        let exit_code = code_str.parse::<i32>().ok();

        let capture = self.active.get_mut(marker_id)?;

        let before = &text[..start_pos];
        let marker_end = start_pos + prefix.len() + suffix_pos + end_suffix.len();
        let after_marker = &text[marker_end..];
        let _ = after_marker;

        let mut output = std::mem::take(&mut capture.buffer);
        output.push_str(before);
        let output = output.trim().to_string();

        if let Some(tx) = capture.result_tx.take() {
            let _ = tx.send(CapturedOutput {
                output,
                exit_code,
                duration_ms: capture.start_time.elapsed().as_millis() as u64,
            });
        }

        // Transition to PostCapture to suppress the shell prompt that follows.
        // Also discard any text after the END marker in this chunk.
        capture.phase = CapturePhase::PostCapture;

        Some(MatchResult {
            before: "",
            after: "",
        })
    }
}

struct MatchResult<'a> {
    before: &'a str,
    after: &'a str,
}

impl Default for OutputCaptureProcessor {
    fn default() -> Self {
        Self::new()
    }
}
