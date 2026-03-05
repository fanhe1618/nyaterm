//! Fuzzy search over command history using nucleo-matcher.
//!
//! Deduplicates and caps history size; persists to history.json.

use crate::error::AppResult;
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

const MAX_HISTORY: usize = 5000;

/// Single fuzzy match with score and highlighted character indices.
#[derive(Debug, Clone, Serialize)]
pub struct FuzzyResult {
    pub command: String,
    pub score: u32,
    pub indices: Vec<u32>,
    /// Provider tag: "history", "quickCommand", etc.
    pub source: String,
    /// Text shown in the suggestion panel (may differ from `command`).
    pub display: String,
}

/// In-memory history store with dedup, persistence, and nucleo-based fuzzy search.
pub struct CommandHistoryStore {
    commands: Vec<String>,
    dedup: HashSet<String>,
    dirty: bool,
    history_path: Option<PathBuf>,
}

impl CommandHistoryStore {
    /// Creates an empty store; call `set_history_path` before `load`.
    pub fn new() -> Self {
        Self {
            commands: Vec::new(),
            dedup: HashSet::new(),
            dirty: false,
            history_path: None,
        }
    }

    /// Sets the JSON path for load/save; required before `load` or `save`.
    pub fn set_history_path(&mut self, path: PathBuf) {
        self.history_path = Some(path);
    }

    /// Loads history from disk; merges with existing without duplicates.
    pub fn load(&mut self) -> AppResult<()> {
        if let Some(path) = &self.history_path {
            if path.exists() {
                let content = fs::read_to_string(path)?;
                let cmds: Vec<String> = serde_json::from_str(&content)?;
                for cmd in cmds {
                    if self.dedup.insert(cmd.clone()) {
                        self.commands.push(cmd);
                    }
                }
            }
        }
        Ok(())
    }

    /// Persists to disk only when dirty (after `add`).
    pub fn save(&mut self) -> AppResult<()> {
        if !self.dirty {
            return Ok(());
        }
        if let Some(path) = &self.history_path {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let content = serde_json::to_string(&self.commands)?;
            fs::write(path, content)?;
            self.dirty = false;
        }
        Ok(())
    }

    /// Adds a command; moves duplicates to end and trims to MAX_HISTORY.
    pub fn add(&mut self, command: String) {
        let command = command.trim().to_string();
        if command.is_empty() {
            return;
        }

        if self.dedup.contains(&command) {
            self.commands.retain(|c| c != &command);
        } else {
            self.dedup.insert(command.clone());
        }
        self.commands.push(command);

        while self.commands.len() > MAX_HISTORY {
            if let Some(removed) = self.commands.first().cloned() {
                self.commands.remove(0);
                self.dedup.remove(&removed);
            }
        }

        self.dirty = true;
    }

    /// Fuzzy search the history using nucleo-matcher.
    /// Returns top `limit` results sorted by score (highest first).
    /// At equal scores, more recent commands rank higher.
    pub fn search(&self, pattern_str: &str, limit: usize) -> Vec<FuzzyResult> {
        let items: Vec<(String, String)> = self
            .commands
            .iter()
            .map(|c| (c.clone(), c.clone()))
            .collect();
        fuzzy_search_items(&items, pattern_str, "history", limit)
    }
}

/// Generic fuzzy search over `(display_text, value)` pairs.
///
/// Matches against `display_text` (shown in the suggestion panel).
/// `value` is stored as `command` in the result (used when filling/executing).
/// `source` tags every result so the frontend can distinguish providers.
///
/// This is the shared primitive that any suggestion provider should use.
pub fn fuzzy_search_items(
    items: &[(String, String)],
    pattern_str: &str,
    source: &str,
    limit: usize,
) -> Vec<FuzzyResult> {
    let pattern_str = pattern_str.trim();
    if pattern_str.is_empty() {
        return Vec::new();
    }

    let pattern = Pattern::new(
        pattern_str,
        CaseMatching::Smart,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );

    if pattern.atoms.is_empty() {
        return Vec::new();
    }

    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();

    let mut scored: Vec<(usize, u32)> = Vec::new();
    for (idx, (display, _value)) in items.iter().enumerate() {
        let haystack = Utf32Str::new(display, &mut buf);
        if let Some(score) = pattern.score(haystack, &mut matcher) {
            scored.push((idx, score));
        }
    }

    scored.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));
    scored.truncate(limit);

    let mut results = Vec::with_capacity(scored.len());
    for (idx, score) in scored {
        let (display, value) = &items[idx];
        let haystack = Utf32Str::new(display, &mut buf);
        let mut indices = Vec::new();
        pattern.indices(haystack, &mut matcher, &mut indices);
        indices.sort_unstable();
        indices.dedup();

        results.push(FuzzyResult {
            command: value.clone(),
            score,
            indices,
            source: source.to_string(),
            display: display.clone(),
        });
    }

    results
}
