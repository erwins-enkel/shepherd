//! Worktree verbs (#2587): `git <session>`, `diff`, `cat`. A task's working state before a PR
//! exists, without SSH. All three read `full`-only routes.

use std::io::Write;

use futures::StreamExt;
use serde_json::json;

use super::read::plain;
use super::{VersionCheck, list_sessions};
use crate::api::Client;
use crate::api::types::{DiffFile, WorktreeStatus};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode, or_dash};
use crate::{Ctx, resolve};

const GIT_SESSION: Op = Op::new("git <session>", Scope::Full);
const DIFF: Op = Op::new("diff", Scope::Full);
const CAT: Op = Op::new("cat", Scope::Full);

/// Resolve a key against the active list: `(id, designation)`. A key matching no active session
/// goes to the server verbatim, so it answers 404.
async fn resolve_key(client: &Client, key: &str, op: Op) -> Result<(String, String)> {
    let sessions = list_sessions(client, op).await?;
    Ok(match resolve::find(&sessions, key) {
        Some(s) => (s.id.clone(), s.desig.clone()),
        None => (key.trim().to_string(), key.trim().to_string()),
    })
}

fn short(sha: Option<&String>) -> String {
    or_dash(sha.map(|s| s.chars().take(10).collect::<String>()))
}

fn warn_fetch_failed(ctx: &mut Ctx<'_>, base_ref: &str) {
    ctx.io.warn(&format!(
        "warning: could not fetch the base; compared against the local {base_ref}"
    ));
}

fn print_status(ctx: &mut Ctx<'_>, desig: &str, w: &WorktreeStatus, pr: String) -> Result<()> {
    let mut t = output::table(&["FIELD", "VALUE"]);
    let rows: [(&str, String); 11] = [
        ("session", desig.to_string()),
        ("branch", or_dash(w.head.as_ref())),
        ("head", short(w.head_sha.as_ref())),
        ("base", w.base_ref.clone()),
        ("base tip", short(w.base_sha.as_ref())),
        ("fork point", short(w.merge_base.as_ref())),
        ("behind base", or_dash(w.behind_base)),
        ("ahead of base", or_dash(w.ahead_of_base)),
        ("upstream", or_dash(w.upstream.as_ref())),
        ("unpushed", or_dash(w.unpushed_count)),
        (
            "dirty",
            or_dash(w.dirty.map(|d| if d { "yes" } else { "no" })),
        ),
    ];
    for (k, v) in rows {
        t.add_row(vec![k.to_string(), v]);
    }
    t.add_row(vec!["pr".to_string(), pr]);
    let out = &mut ctx.io.stdout;
    output::print_table(out, &t)?;
    if !w.unpushed.is_empty() {
        output::line(out, "")?;
        output::line(out, "unpushed commits (newest first):")?;
        for c in &w.unpushed {
            let sha: String = c.sha.chars().take(10).collect();
            output::line(out, &format!("  {sha} {}", plain(&c.subject)))?;
        }
    }
    Ok(())
}

/// `shepherd git <session>`: the cached PR state plus the live worktree status.
pub async fn git_session(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let (id, desig) = resolve_key(&ctx.client, key, GIT_SESSION).await?;
    let (status, states) = tokio::join!(
        ctx.client.get_session_worktree_status().id(&id).send(),
        ctx.client.git_states().send()
    );
    let status = match status {
        Ok(s) => s.into_inner(),
        Err(e) => return Err(api_error(e, GIT_SESSION).await),
    };
    let pr = match states {
        Ok(s) => s.into_inner().0.remove(&id),
        Err(e) => return Err(api_error(e, GIT_SESSION).await),
    };
    if status.fetch_failed {
        warn_fetch_failed(ctx, &status.base_ref);
    }
    if ctx.mode == Mode::Json {
        let doc = json!({ "session": desig, "pr": pr, "worktree": status });
        output::json(&mut ctx.io.stdout, &doc)?;
    } else {
        let pr = pr.map_or_else(
            || "-".to_string(),
            |g| match g.number {
                Some(n) => format!("#{n} {}", g.state.0),
                None => g.state.0.clone(),
            },
        );
        print_status(ctx, &desig, &status, pr)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

/// Whether `file` is selected by the `-- <path>…` filter: an exact path or a directory prefix.
/// No paths select everything.
fn selected(file: &DiffFile, paths: &[String]) -> bool {
    if paths.is_empty() {
        return true;
    }
    let names = std::iter::once(file.path.as_str()).chain(file.old_path.as_deref());
    let names: Vec<&str> = names.collect();
    paths.iter().any(|p| {
        let p = p.trim_start_matches("./").trim_end_matches('/');
        p.is_empty()
            || p == "."
            || names
                .iter()
                .any(|n| *n == p || n.strip_prefix(p).is_some_and(|r| r.starts_with('/')))
    })
}

fn print_stat(out: &mut dyn Write, files: &[DiffFile]) -> Result<()> {
    let (mut adds, mut dels) = (0, 0);
    for f in files {
        adds += f.additions;
        dels += f.deletions;
        let mark = if f.binary { " (binary)" } else { "" };
        output::line(
            out,
            &format!(
                "{:>6} {:>6}  {}{mark}",
                format!("+{}", f.additions),
                format!("-{}", f.deletions),
                plain(&f.path)
            ),
        )?;
    }
    output::line(
        out,
        &format!("{} files changed, +{adds} -{dels}", files.len()),
    )
}

/// The one-line note for a file without a patch: binary, over the per-file cap, or a change with no
/// line body (a pure rename, an empty added/deleted file, a mode change).
fn patchless_note(f: &DiffFile) -> String {
    let path = match f.old_path.as_deref() {
        Some(old) if old != f.path => format!("{} -> {}", plain(old), plain(&f.path)),
        _ => plain(&f.path),
    };
    if f.binary {
        format!("# {path}: binary (+{} -{})", f.additions, f.deletions)
    } else if f.truncated == Some(true) {
        format!(
            "# {path}: too large to show (+{} -{})",
            f.additions, f.deletions
        )
    } else {
        format!("# {path}: {}", plain(&f.status.0))
    }
}

fn print_patches(out: &mut dyn Write, files: &[DiffFile]) -> Result<()> {
    for f in files {
        match &f.patch {
            Some(patch) => output::line(out, &plain(patch))?,
            None => output::line(out, &patchless_note(f))?,
        }
    }
    Ok(())
}

/// `shepherd diff <session> [--stat] [-- <path>…]`: the worktree against its fork point.
pub async fn diff(ctx: &mut Ctx<'_>, key: &str, stat: bool, paths: &[String]) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let (id, _) = resolve_key(&ctx.client, key, DIFF).await?;
    let mut d = match ctx
        .client
        .get_session_diff()
        .id(&id)
        .worktree(true)
        .send()
        .await
    {
        Ok(d) => d.into_inner(),
        Err(e) => return Err(api_error(e, DIFF).await),
    };
    if d.fetch_failed {
        warn_fetch_failed(ctx, &d.base_ref);
    }
    d.files.retain(|f| selected(f, paths));
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &d)?;
    } else if stat {
        print_stat(&mut ctx.io.stdout, &d.files)?;
    } else {
        print_patches(&mut ctx.io.stdout, &d.files)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

fn write_failed(e: std::io::Error) -> CliError {
    CliError::new(Exit::Failure, format!("cannot write output: {e}"))
}

/// `shepherd cat <session> <path>`: one worktree file. Raw bytes when stdout is redirected (or with
/// `--json`); on a terminal, control characters are dropped, as for any agent-written text.
pub async fn cat(ctx: &mut Ctx<'_>, key: &str, path: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let (id, _) = resolve_key(&ctx.client, key, CAT).await?;
    let body = match ctx
        .client
        .get_session_worktree_file()
        .id(&id)
        .path(path)
        .send()
        .await
    {
        Ok(b) => b.into_inner(),
        Err(e) => return Err(api_error(e, CAT).await),
    };
    let mut stream = body.into_inner();
    let mut text = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            CliError::new(
                Exit::Unreachable,
                format!("cannot read the file from the server: {e}"),
            )
        })?;
        if ctx.mode == Mode::Json {
            ctx.io.stdout.write_all(&chunk).map_err(write_failed)?;
        } else {
            text.extend_from_slice(&chunk);
        }
    }
    if ctx.mode == Mode::Human {
        let shown = plain(&String::from_utf8_lossy(&text));
        ctx.io
            .stdout
            .write_all(shown.as_bytes())
            .map_err(write_failed)?;
    }
    ctx.io.stdout.flush().map_err(write_failed)?;
    check.finish(ctx.io).await;
    Ok(())
}
