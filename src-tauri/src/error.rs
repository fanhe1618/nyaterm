//! Unified error type for Tauri commands.
//!
//! Provides `AppError` and `AppResult` for consistent error handling across the app.

use serde::Serialize;

/// Unified error type for all Tauri commands.
///
/// Implements `Serialize` so Tauri can pass the error message to the frontend.
/// Uses `thiserror` for ergonomic `From` conversions and `Display` formatting.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("SSH error: {0}")]
    Ssh(#[from] russh::Error),

    #[error("SSH key error: {0}")]
    SshKey(#[from] russh::keys::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    SessionNotFound(String),

    #[error("{0}")]
    Auth(String),

    #[error("{0}")]
    Config(String),

    #[error("{0}")]
    Channel(String),

    #[error("{0}")]
    Cancelled(String),

    #[error("SFTP error: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),

    #[error("Crypto error: {0}")]
    Crypto(String),

    #[error("Translation error: {0}")]
    Translation(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias for `Result<T, AppError>`.
pub type AppResult<T> = Result<T, AppError>;
