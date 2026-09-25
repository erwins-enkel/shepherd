//! One module per verb family. Shared helpers live here.

pub mod control;
pub mod events;
pub mod login;
pub mod read;

use std::time::Duration;

use tokio::task::JoinHandle;

use crate::api::{Client, types::Session};
use crate::error::{Op, Result, api_error};
use crate::{CLI_VERSION, Io, resolve};

/// Best-effort `/api/health` probe run alongside a command, to warn when the server's version
/// differs from this CLI's (they release in lockstep). Never fails the command.
pub struct VersionCheck(JoinHandle<Option<String>>);

impl VersionCheck {
    pub fn start(client: &Client) -> Self {
        let client = client.clone();
        VersionCheck(tokio::spawn(async move {
            let health = client.get_health().send().await.ok()?;
            Some(health.into_inner().version)
        }))
    }

    pub async fn finish(self, io: &mut Io) {
        if let Ok(Ok(Some(version))) = tokio::time::timeout(Duration::from_secs(2), self.0).await {
            warn_mismatch(io, &version);
        }
    }
}

pub fn warn_mismatch(io: &mut Io, server_version: &str) {
    if server_version != CLI_VERSION {
        io.warn(&format!(
            "warning: server is v{server_version}, this CLI is v{CLI_VERSION}; \
             install the matching CLI release"
        ));
    }
}

pub async fn list_sessions(client: &Client, op: Op) -> Result<Vec<Session>> {
    match client.list_sessions().send().await {
        Ok(list) => Ok(list.into_inner().0),
        Err(e) => Err(api_error(e, op).await),
    }
}

/// Turns a UUID or designation into a session id. A key that matches no active session is used
/// verbatim, so the server answers for it (404/409).
pub async fn session_id(client: &Client, key: &str, op: Op) -> Result<String> {
    if resolve::looks_like_id(key) {
        return Ok(key.trim().to_string());
    }
    let sessions = list_sessions(client, op).await?;
    Ok(resolve::find(&sessions, key)
        .map(|s| s.id.clone())
        .unwrap_or_else(|| key.trim().to_string()))
}

/// The designation for an id when known, else the id.
pub fn label(sessions: &[Session], id: &str) -> String {
    sessions
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.desig.clone())
        .unwrap_or_else(|| id.to_string())
}
