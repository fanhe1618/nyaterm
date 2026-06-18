use crate::error::{AppError, AppResult};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::mem;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use time::OffsetDateTime;

pub const DEFAULT_MEMORY_LIMIT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug)]
struct TranscriptRecord {
    timestamp: String,
    label: &'static str,
    data: String,
    size_bytes: usize,
}

impl TranscriptRecord {
    fn new(label: &'static str, data: String) -> Self {
        let timestamp = chrono_timestamp();
        let size_bytes = format_record_parts(&timestamp, label, &data, true, true).len();
        Self {
            timestamp,
            label,
            data,
            size_bytes,
        }
    }

    fn format(&self, include_io_labels: bool, include_timestamps: bool) -> String {
        format_record_parts(
            &self.timestamp,
            self.label,
            &self.data,
            include_io_labels,
            include_timestamps,
        )
    }
}

struct FileRecording {
    writer: BufWriter<File>,
    file_path: PathBuf,
    include_io_labels: bool,
    include_timestamps: bool,
}

impl FileRecording {
    fn new(
        file: File,
        file_path: PathBuf,
        include_io_labels: bool,
        include_timestamps: bool,
    ) -> Self {
        Self {
            writer: BufWriter::new(file),
            file_path,
            include_io_labels,
            include_timestamps,
        }
    }

    fn write_record(&mut self, record: &TranscriptRecord) {
        let _ = self.writer.write_all(
            record
                .format(self.include_io_labels, self.include_timestamps)
                .as_bytes(),
        );
    }

    fn finish(&mut self) {
        let _ = self.writer.flush();
    }
}

struct SessionCaptureState {
    recording: Option<FileRecording>,
    records: VecDeque<TranscriptRecord>,
    record_bytes: usize,
    memory_limit_bytes: usize,
    input_buffer: String,
    output_buffer: String,
    live_echo_buffer: String,
    submitted_line_echo: Option<String>,
    suppress_next_newline: bool,
}

impl SessionCaptureState {
    fn new(memory_limit_bytes: usize) -> Self {
        Self {
            recording: None,
            records: VecDeque::new(),
            record_bytes: 0,
            memory_limit_bytes,
            input_buffer: String::new(),
            output_buffer: String::new(),
            live_echo_buffer: String::new(),
            submitted_line_echo: None,
            suppress_next_newline: false,
        }
    }

    fn set_memory_limit(&mut self, memory_limit_bytes: usize) {
        self.memory_limit_bytes = memory_limit_bytes;
        self.trim_records();
    }

    fn start_recording(
        &mut self,
        file: File,
        file_path: PathBuf,
        include_io_labels: bool,
        include_timestamps: bool,
    ) -> AppResult<()> {
        if self.recording.is_some() {
            return Err(AppError::Config("Recording is already active".to_string()));
        }
        self.flush_output_lines(true);
        self.recording = Some(FileRecording::new(
            file,
            file_path,
            include_io_labels,
            include_timestamps,
        ));
        Ok(())
    }

    fn stop_recording(&mut self) -> AppResult<String> {
        if self.recording.is_none() {
            return Err(AppError::Config("No active recording".to_string()));
        }
        self.commit_partial_input();
        self.flush_output_lines(true);
        let mut recording = self
            .recording
            .take()
            .ok_or_else(|| AppError::Config("No active recording".to_string()))?;
        recording.finish();
        Ok(recording.file_path.to_string_lossy().to_string())
    }

    fn write_input(&mut self, data: &[u8]) {
        let text = String::from_utf8_lossy(data);

        for ch in text.chars() {
            match ch {
                '\r' | '\n' => self.commit_input_line(),
                '\u{8}' | '\u{7f}' => self.handle_backspace(),
                '\t' => {
                    self.input_buffer.push('\t');
                    self.live_echo_buffer.push('\t');
                }
                c if !c.is_control() => {
                    self.input_buffer.push(c);
                    self.live_echo_buffer.push(c);
                }
                _ => {}
            }
        }
    }

    fn write_output(&mut self, data: &str) {
        let mut sanitized = strip_terminal_control_sequences(data);
        if sanitized.is_empty() {
            return;
        }

        if self.suppress_next_newline {
            sanitized = strip_one_leading_newline(&sanitized).to_string();
            self.suppress_next_newline = false;
            if sanitized.is_empty() {
                return;
            }
        }

        sanitized = self.consume_live_echo(&sanitized);
        if sanitized.is_empty() {
            return;
        }

        let (mut sanitized, consumed_submitted_echo) = self.consume_submitted_echo(&sanitized);
        if sanitized.is_empty() {
            return;
        }

        if !consumed_submitted_echo && self.submitted_line_echo.is_some() {
            sanitized = strip_one_leading_newline(&sanitized).to_string();
            self.submitted_line_echo = None;
            if sanitized.is_empty() {
                return;
            }
        }

        self.output_buffer.push_str(&sanitized);
        self.flush_output_lines(false);
    }

    fn finish(&mut self) {
        self.commit_partial_input();
        self.flush_output_lines(true);
        if let Some(recording) = self.recording.as_mut() {
            recording.finish();
        }
        self.recording = None;
    }

    fn snapshot_records(&mut self) -> Vec<TranscriptRecord> {
        self.flush_output_lines(true);
        self.records.iter().cloned().collect()
    }

    fn append_record(&mut self, label: &'static str, data: String) {
        if data.is_empty() {
            return;
        }

        let record = TranscriptRecord::new(label, data);
        if let Some(recording) = self.recording.as_mut() {
            recording.write_record(&record);
        }

        self.record_bytes += record.size_bytes;
        self.records.push_back(record);
        self.trim_records();
    }

    fn trim_records(&mut self) {
        while self.records.len() > 1 && self.record_bytes > self.memory_limit_bytes {
            if let Some(record) = self.records.pop_front() {
                self.record_bytes = self.record_bytes.saturating_sub(record.size_bytes);
            }
        }
    }

    fn handle_backspace(&mut self) {
        if let Some(removed) = self.input_buffer.pop() {
            if self.live_echo_buffer.ends_with(removed) {
                self.live_echo_buffer.pop();
            }
        }
    }

    fn commit_input_line(&mut self) {
        self.flush_output_lines(true);
        let line = mem::take(&mut self.input_buffer);
        self.live_echo_buffer.clear();

        if line.trim().is_empty() {
            self.submitted_line_echo = None;
            return;
        }

        self.append_record("INPUT", line.clone());
        self.submitted_line_echo = Some(line);
    }

    fn commit_partial_input(&mut self) {
        self.flush_output_lines(true);
        let line = mem::take(&mut self.input_buffer);
        self.live_echo_buffer.clear();
        self.submitted_line_echo = None;

        if line.trim().is_empty() {
            return;
        }

        self.append_record("INPUT", line);
    }

    fn consume_live_echo(&mut self, text: &str) -> String {
        let consumed = consume_matching_prefix(&mut self.live_echo_buffer, text);
        text[consumed..].to_string()
    }

    fn consume_submitted_echo(&mut self, text: &str) -> (String, bool) {
        let Some(line) = self.submitted_line_echo.as_ref() else {
            return (text.to_string(), false);
        };

        if !text.starts_with(line) {
            return (text.to_string(), false);
        }

        let mut remaining = text[line.len()..].to_string();
        self.submitted_line_echo = None;

        let stripped = strip_one_leading_newline(&remaining);
        if stripped.len() != remaining.len() {
            remaining = stripped.to_string();
        } else {
            self.suppress_next_newline = true;
        }

        (remaining, true)
    }

    fn flush_output_lines(&mut self, flush_partial: bool) {
        while let Some(pos) = self.output_buffer.find('\n') {
            let line = self.output_buffer[..pos].to_string();
            self.output_buffer.drain(..=pos);
            self.append_record("OUTPUT", line);
        }

        if flush_partial && !self.output_buffer.is_empty() {
            let tail = mem::take(&mut self.output_buffer);
            self.append_record("OUTPUT", tail);
        }
    }
}

pub struct RecordingManager {
    sessions: Mutex<HashMap<String, SessionCaptureState>>,
    memory_limit_bytes: Mutex<usize>,
}

impl RecordingManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            memory_limit_bytes: Mutex::new(DEFAULT_MEMORY_LIMIT_BYTES),
        }
    }

    pub fn start(
        &self,
        session_id: &str,
        file_path: &str,
        include_io_labels: bool,
        include_timestamps: bool,
    ) -> AppResult<()> {
        let path = prepare_output_file_path(file_path)?;
        let file = File::create(&path)
            .map_err(|e| AppError::Config(format!("Failed to create recording file: {e}")))?;
        let memory_limit_bytes = *lock_recover(&self.memory_limit_bytes);

        let mut sessions = lock_recover(&self.sessions);
        let state = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| SessionCaptureState::new(memory_limit_bytes));
        state.set_memory_limit(memory_limit_bytes);
        state.start_recording(file, path, include_io_labels, include_timestamps)
    }

    pub fn stop(&self, session_id: &str) -> AppResult<String> {
        let mut sessions = lock_recover(&self.sessions);
        let state = sessions
            .get_mut(session_id)
            .ok_or_else(|| AppError::Config("No active recording".to_string()))?;
        state.stop_recording()
    }

    pub fn save_transcript(
        &self,
        session_id: &str,
        file_path: &str,
        include_io_labels: bool,
        include_timestamps: bool,
    ) -> AppResult<String> {
        let path = prepare_output_file_path(file_path)?;
        let records = {
            let mut sessions = lock_recover(&self.sessions);
            sessions
                .get_mut(session_id)
                .map(SessionCaptureState::snapshot_records)
                .unwrap_or_default()
        };

        let mut writer = BufWriter::new(
            File::create(&path)
                .map_err(|e| AppError::Config(format!("Failed to create transcript file: {e}")))?,
        );
        for record in &records {
            writer
                .write_all(
                    record
                        .format(include_io_labels, include_timestamps)
                        .as_bytes(),
                )
                .map_err(|e| AppError::Config(format!("Failed to write transcript file: {e}")))?;
        }
        writer
            .flush()
            .map_err(|e| AppError::Config(format!("Failed to flush transcript file: {e}")))?;
        Ok(path.to_string_lossy().to_string())
    }

    pub fn set_memory_limit(&self, max_bytes: usize) {
        let bounded = max_bytes.max(1);
        *lock_recover(&self.memory_limit_bytes) = bounded;

        let mut sessions = lock_recover(&self.sessions);
        for state in sessions.values_mut() {
            state.set_memory_limit(bounded);
        }
    }

    pub fn is_recording(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .is_some_and(|state| state.recording.is_some())
    }

    pub fn list_recording_sessions(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter_map(|(id, state)| state.recording.as_ref().map(|_| id.clone()))
            .collect()
    }

    pub fn write_output(&self, session_id: &str, data: &str) {
        let memory_limit_bytes = *lock_recover(&self.memory_limit_bytes);
        let mut sessions = lock_recover(&self.sessions);
        let state = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| SessionCaptureState::new(memory_limit_bytes));
        state.set_memory_limit(memory_limit_bytes);
        state.write_output(data);
    }

    pub fn write_input(&self, session_id: &str, data: &[u8]) {
        let memory_limit_bytes = *lock_recover(&self.memory_limit_bytes);
        let mut sessions = lock_recover(&self.sessions);
        let state = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| SessionCaptureState::new(memory_limit_bytes));
        state.set_memory_limit(memory_limit_bytes);
        state.write_input(data);
    }

    pub fn cleanup_session(&self, session_id: &str) {
        let removed = {
            let mut sessions = lock_recover(&self.sessions);
            sessions.remove(session_id)
        };
        if let Some(mut state) = removed {
            state.finish();
        }
    }
}

fn prepare_output_file_path(file_path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(file_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::Config(format!("Failed to create directory: {e}")))?;
        }
    }
    Ok(path)
}

fn format_record_parts(
    timestamp: &str,
    label: &str,
    data: &str,
    include_io_labels: bool,
    include_timestamps: bool,
) -> String {
    match (include_timestamps, include_io_labels) {
        (true, true) => format!("[{timestamp}] [{label}] {data}\n"),
        (true, false) => format!("[{timestamp}] {data}\n"),
        (false, true) => format!("[{label}] {data}\n"),
        (false, false) => format!("{data}\n"),
    }
}

fn chrono_timestamp() -> String {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    now.format(time::macros::format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]"
    ))
    .unwrap_or_else(|_| "1970-01-01 00:00:00.000".to_string())
}

fn consume_matching_prefix(prefix_buffer: &mut String, text: &str) -> usize {
    let mut prefix_idx = 0;
    let mut text_idx = 0;

    while prefix_idx < prefix_buffer.len() && text_idx < text.len() {
        let prefix_char = prefix_buffer[prefix_idx..].chars().next();
        let text_char = text[text_idx..].chars().next();

        match (prefix_char, text_char) {
            (Some(left), Some(right)) if left == right => {
                prefix_idx += left.len_utf8();
                text_idx += right.len_utf8();
            }
            _ => break,
        }
    }

    if prefix_idx > 0 {
        prefix_buffer.drain(..prefix_idx);
    }

    text_idx
}

fn strip_one_leading_newline(text: &str) -> &str {
    text.strip_prefix('\n').unwrap_or(text)
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn strip_terminal_control_sequences(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'\x1b' => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        while i < bytes.len() {
                            let b = bytes[i];
                            i += 1;
                            if (0x40..=0x7e).contains(&b) {
                                break;
                            }
                        }
                    }
                    b']' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == b'\x07' {
                                i += 1;
                                break;
                            }
                            if bytes[i] == b'\x1b' && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    b'P' | b'X' | b'^' | b'_' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == b'\x1b' && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => {
                        advance_one_char(text, &mut i);
                    }
                }
            }
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    out.push('\n');
                    i += 2;
                } else {
                    i += 1;
                }
            }
            b'\n' | b'\t' => {
                out.push(bytes[i] as char);
                i += 1;
            }
            b if b.is_ascii_control() => {
                i += 1;
            }
            b if b.is_ascii() => {
                out.push(b as char);
                i += 1;
            }
            _ => {
                if !text.is_char_boundary(i) {
                    i += 1;
                    continue;
                }
                let Some(ch) = text[i..].chars().next() else {
                    break;
                };
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }

    out
}

fn advance_one_char(text: &str, index: &mut usize) {
    if *index >= text.len() {
        return;
    }

    if !text.is_char_boundary(*index) {
        *index += 1;
        return;
    }

    if let Some(ch) = text[*index..].chars().next() {
        *index += ch.len_utf8();
    } else {
        *index = text.len();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        consume_matching_prefix, strip_one_leading_newline, strip_terminal_control_sequences,
        RecordingManager,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_path(name: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("nyaterm-recording-{name}-{nanos}.log"))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn strips_terminal_escape_sequences_from_output() {
        let raw = concat!(
            "\x1b[?2004l",
            "app.log  \x1b[0m\x1b[01;34mgo\x1b[0m\n",
            "\x1b]7;file://ubuntu/root\x07",
            "\x1b[?2004h\x1b[0m\x1b[1;33m[root\x1b[1;37m@\x1b[1;36mubuntu ",
            "\x1b[1;32m~\x1b[1;35m]\x1b[1;31m\n\n# \x1b[0m"
        );

        let cleaned = strip_terminal_control_sequences(raw);
        assert_eq!(cleaned, "app.log  go\n[root@ubuntu ~]\n\n# ");
    }

    #[test]
    fn strips_unknown_escape_with_multibyte_replacement_without_panicking() {
        let raw = format!("before\x1b{}after\n", char::REPLACEMENT_CHARACTER);

        let cleaned = strip_terminal_control_sequences(&raw);

        assert_eq!(cleaned, "beforeafter\n");
    }

    #[test]
    fn consumes_matching_echo_prefix() {
        let mut prefix = "ps -ef".to_string();
        let consumed = consume_matching_prefix(&mut prefix, "ps -ef\nUID");
        assert_eq!(consumed, "ps -ef".len());
        assert!(prefix.is_empty());
    }

    #[test]
    fn strips_only_one_leading_newline() {
        assert_eq!(strip_one_leading_newline("\nhello"), "hello");
        assert_eq!(strip_one_leading_newline("hello"), "hello");
        assert_eq!(strip_one_leading_newline("\n\nhello"), "\nhello");
    }

    #[test]
    fn writes_recording_with_and_without_io_labels() {
        let manager = RecordingManager::new();
        let labeled_path = unique_path("labels");
        manager.start("s1", &labeled_path, true, true).unwrap();
        manager.write_input("s1", b"echo hi\r");
        manager.write_output("s1", "echo hi\r\nhi\n");
        manager.stop("s1").unwrap();

        let labeled = fs::read_to_string(&labeled_path).unwrap();
        assert!(labeled.contains("[INPUT] echo hi"));
        assert!(labeled.contains("[OUTPUT] hi"));

        let plain_path = unique_path("plain");
        manager.start("s1", &plain_path, false, true).unwrap();
        manager.write_output("s1", "done\n");
        manager.stop("s1").unwrap();

        let plain = fs::read_to_string(&plain_path).unwrap();
        assert!(!plain.contains("[INPUT]"));
        assert!(!plain.contains("[OUTPUT]"));
        assert!(plain.contains("done"));

        let _ = fs::remove_file(labeled_path);
        let _ = fs::remove_file(plain_path);
    }

    #[test]
    fn writes_recording_without_timestamps() {
        let manager = RecordingManager::new();

        let labeled_path = unique_path("no-timestamp-labels");
        manager.start("s1", &labeled_path, true, false).unwrap();
        manager.write_output("s1", "done\n");
        manager.stop("s1").unwrap();

        let labeled = fs::read_to_string(&labeled_path).unwrap();
        assert_eq!(labeled, "[OUTPUT] done\n");

        let plain_path = unique_path("no-timestamp-plain");
        manager.start("s1", &plain_path, false, false).unwrap();
        manager.write_output("s1", "plain\n");
        manager.stop("s1").unwrap();

        let plain = fs::read_to_string(&plain_path).unwrap();
        assert_eq!(plain, "plain\n");

        let _ = fs::remove_file(labeled_path);
        let _ = fs::remove_file(plain_path);
    }

    #[test]
    fn saves_memory_transcript_and_trims_old_records() {
        let manager = RecordingManager::new();
        manager.set_memory_limit(90);
        manager.write_output("s1", "first line\n");
        manager.write_output("s1", "second line\n");
        manager.write_output("s1", "third line\n");

        let path = unique_path("memory");
        manager.save_transcript("s1", &path, true, true).unwrap();
        let saved = fs::read_to_string(&path).unwrap();

        assert!(!saved.contains("first line"));
        assert!(saved.contains("third line"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn saves_transcript_after_binary_like_output() {
        let manager = RecordingManager::new();
        let output = format!("ready\x1b{}done\n", char::REPLACEMENT_CHARACTER);

        manager.write_output("s1", &output);

        let path = unique_path("binary-like");
        manager.save_transcript("s1", &path, true, true).unwrap();
        let saved = fs::read_to_string(&path).unwrap();

        assert!(saved.contains("readydone"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recording_does_not_backfill_existing_memory() {
        let manager = RecordingManager::new();
        manager.write_output("s1", "before\n");

        let path = unique_path("no-backfill");
        manager.start("s1", &path, true, true).unwrap();
        manager.write_output("s1", "after\n");
        manager.stop("s1").unwrap();

        let recorded = fs::read_to_string(&path).unwrap();
        assert!(!recorded.contains("before"));
        assert!(recorded.contains("after"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recording_does_not_backfill_partial_output_buffer() {
        let manager = RecordingManager::new();
        manager.write_output("s1", "prompt without newline");

        let path = unique_path("no-partial-backfill");
        manager.start("s1", &path, true, true).unwrap();
        manager.write_output("s1", "\nafter\n");
        manager.stop("s1").unwrap();

        let recorded = fs::read_to_string(&path).unwrap();
        assert!(!recorded.contains("prompt without newline"));
        assert!(recorded.contains("after"));

        let _ = fs::remove_file(path);
    }
}
