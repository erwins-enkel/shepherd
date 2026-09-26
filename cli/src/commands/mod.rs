//! One module per verb family. Shared helpers live here.

pub mod control;
pub mod epics;
pub mod events;
pub mod intake;
pub mod login;
pub mod merge;
pub mod read;
pub mod settings;
pub mod upnext;

use std::path::Path;
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::api::{Client, types::Session};
use crate::error::{CliError, Exit, Op, Result, api_error};
use crate::{CLI_VERSION, Ctx, Io, resolve};

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

fn git_toplevel(cwd: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    let path = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !path.is_empty()).then_some(path)
}

/// `--repo`, else this directory's git toplevel (the server resolves it under its repo root).
pub fn repo_path(ctx: &Ctx<'_>, repo: Option<String>) -> Result<String> {
    repo.or_else(|| git_toplevel(&ctx.io.cwd)).ok_or_else(|| {
        CliError::new(
            Exit::Usage,
            "not inside a git repository: pass --repo <path on the server>",
        )
    })
}

/// Prints `value` as JSON, or `text` on a terminal.
pub fn print_done(ctx: &mut Ctx<'_>, value: &impl serde::Serialize, text: &str) -> Result<()> {
    if ctx.mode == crate::output::Mode::Json {
        return crate::output::json(&mut ctx.io.stdout, value);
    }
    crate::output::line(&mut ctx.io.stdout, text)
}
