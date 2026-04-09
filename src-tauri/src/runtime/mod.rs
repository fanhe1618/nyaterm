//! Local runtime services shared by SSH and PTY sessions.
//!
//! Keeps session lifecycle, recording, and file-watch plumbing under one
//! backend-oriented namespace instead of scattering them at the crate root.

mod pty;
mod recording;
mod session;
pub(crate) mod watcher;

pub use pty::create_local_session;
pub use recording::RecordingManager;
pub use session::{
    SessionCommand, SessionHandle, SessionInfo, SessionManager, SessionType, SharedCwd,
};
