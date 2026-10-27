//! One module per verb family. Shared helpers live here.

pub mod control;
pub mod epics;
pub mod events;
pub mod intake;
pub mod login;
pub mod merge;
pub mod read;
pub mod schedule;
pub mod settings;
pub mod upnext;
pub mod wait;
pub mod worktree;

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

fn git_out(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    out.status.success().then_some(text)
}

/// The main worktree's path from `git worktree list --porcelain -z`: the first record, unless it
/// is bare (no checkout to point at).
fn main_worktree(porcelain: &str) -> Option<String> {
    let mut fields = porcelain.split('\0').take_while(|f| !f.is_empty());
    let path = fields.next()?.strip_prefix("worktree ")?.to_string();
    (!fields.any(|f| f == "bare") && !path.is_empty()).then_some(path)
}

/// The repository's main checkout, also from a linked worktree; else this directory's toplevel
/// (bare main repo).
fn default_repo(cwd: &Path) -> Option<String> {
    git_out(cwd, &["worktree", "list", "--porcelain", "-z"])
        .and_then(|out| main_worktree(&out))
        .or_else(|| {
            let path = git_out(cwd, &["rev-parse", "--show-toplevel"])?
                .trim()
                .to_string();
            (!path.is_empty()).then_some(path)
        })
}

/// `--repo`, else this directory's main git checkout (the server resolves it under its repo root).
pub fn repo_path(ctx: &Ctx<'_>, repo: Option<String>) -> Result<String> {
    repo.or_else(|| default_repo(&ctx.io.cwd)).ok_or_else(|| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Runs git in `dir` with no ambient repo env and a throwaway identity.
    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn canon(p: &Path) -> PathBuf {
        p.canonicalize().unwrap()
    }

    fn resolved(cwd: &Path) -> PathBuf {
        canon(Path::new(&default_repo(cwd).expect("inside a repo")))
    }

    /// A main checkout `repo/` with one commit and a linked worktree `wt/` beside it.
    fn repo_with_worktree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("repo");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&main, &["worktree", "add", "-q", "-b", "feat", "../wt"]);
        let wt = tmp.path().join("wt");
        (tmp, main, wt)
    }

    #[test]
    fn worktree_resolves_to_the_main_checkout() {
        let (_tmp, main, wt) = repo_with_worktree();
        std::fs::create_dir(wt.join("sub")).unwrap();
        assert_eq!(resolved(&wt), canon(&main));
        assert_eq!(resolved(&wt.join("sub")), canon(&main));
    }

    #[test]
    fn plain_checkout_resolves_to_its_root() {
        let (_tmp, main, _wt) = repo_with_worktree();
        std::fs::create_dir(main.join("sub")).unwrap();
        assert_eq!(resolved(&main), canon(&main));
        assert_eq!(resolved(&main.join("sub")), canon(&main));
    }

    #[test]
    fn bare_main_falls_back_to_the_worktree_toplevel() {
        // Bare repo in `x/.git` with worktrees beside it: `x` itself is no checkout.
        let (tmp, main, _wt) = repo_with_worktree();
        git(
            tmp.path(),
            &["clone", "-q", "--bare", main.to_str().unwrap(), "x/.git"],
        );
        git(
            &tmp.path().join("x/.git"),
            &["worktree", "add", "-q", "../wt"],
        );
        let wt = tmp.path().join("x/wt");
        assert_eq!(resolved(&wt), canon(&wt));
    }

    #[test]
    fn outside_a_repo_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(default_repo(tmp.path()), None);
    }

    #[test]
    fn main_worktree_parses_the_first_record() {
        let out = "worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD def\0\0";
        assert_eq!(main_worktree(out).as_deref(), Some("/r"));
        assert_eq!(
            main_worktree("worktree /r.git\0bare\0\0worktree /w\0\0"),
            None
        );
        assert_eq!(main_worktree(""), None);
    }
}
