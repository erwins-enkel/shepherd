//! `up-next list|start`.
//!
//! The contract has no read route for the queue: `GET /api/up-next` answers a bare `null` when
//! nothing is cached, so it is undeclared. Clients bootstrap the way the contract says — open
//! `/events` FIRST, then `POST /api/up-next/refresh`, then take the first `upnext:snapshot` frame.
//! The refresh is single-flight and always pushes a frame when it lands, so one always follows.

use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;

use super::events::{connect, events_url, parse};
use super::intake::summary;
use super::{VersionCheck, print_done};
use crate::Ctx;
use crate::api::types::{UpNextItem, UpNextSnapshot, UpNextStartItem, UpNextStartResult};
use crate::cli::{UpNextCmd, UpNextStartArgs};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode, ago};

const LIST: Op = Op::new("up-next list", Scope::Full);
const START: Op = Op::new("up-next start", Scope::Full);
/// A refresh fans out one forge listing per repo; a large root takes a while.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(90);

pub async fn run(ctx: &mut Ctx<'_>, cmd: UpNextCmd) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    match cmd {
        UpNextCmd::List => list(ctx).await?,
        UpNextCmd::Start(args) => start(ctx, args).await?,
    }
    check.finish(ctx.io).await;
    Ok(())
}

async fn fetch_snapshot(ctx: &Ctx<'_>, op: Op) -> Result<UpNextSnapshot> {
    let url = events_url(&ctx.target.url)?;
    let mut socket = connect(&url, ctx.target.token.as_deref(), op).await?;
    if let Err(e) = ctx.client.refresh_up_next().send().await {
        return Err(api_error(e, op).await);
    }
    let wait = async {
        while let Some(msg) = socket.next().await {
            let Ok(msg) = msg else { break };
            let Some(frame) = parse(msg) else { continue };
            if frame.get("event").and_then(Value::as_str) != Some("upnext:snapshot") {
                continue;
            }
            let data = frame.pointer("/data/snapshot").cloned().unwrap_or(Value::Null);
            return serde_json::from_value::<UpNextSnapshot>(data).map_err(|e| {
                CliError::new(
                    Exit::Server,
                    format!("the server sent an Up Next snapshot this CLI cannot decode: {e}"),
                )
            });
        }
        Err(CliError::new(
            Exit::Unreachable,
            "the event stream closed before the Up Next snapshot arrived",
        ))
    };
    tokio::time::timeout(SNAPSHOT_TIMEOUT, wait)
        .await
        .unwrap_or_else(|_| {
            Err(CliError::new(
                Exit::Failure,
                "timed out waiting for the Up Next snapshot",
            ))
        })
}

/// Every item once, in queue order (the priority section repeats items of the repo sections).
fn items(snap: &UpNextSnapshot) -> Vec<&UpNextItem> {
    let mut out: Vec<&UpNextItem> = Vec::new();
    for item in snap.sections.iter().flat_map(|s| s.items.iter()) {
        if !out
            .iter()
            .any(|o| o.repo_path == item.repo_path && o.number == item.number)
        {
            out.push(item);
        }
    }
    out
}

fn item_ref(item: &UpNextItem) -> String {
    let repo = item.repo_slug.as_deref().unwrap_or(&item.repo_label);
    format!("{repo}#{}", item.number)
}

fn repo_matches(item: &UpNextItem, repo: &str) -> bool {
    let slug = item.repo_slug.as_deref().unwrap_or("");
    let short = slug.rsplit('/').next().unwrap_or("");
    [slug, short, item.repo_label.as_str(), item.repo_path.as_str()]
        .iter()
        .any(|c| !c.is_empty() && c.eq_ignore_ascii_case(repo))
}

/// Finds the item `key` names: `<repo>#<n>` or a bare `<n>`/`#<n>` that is unique in the queue.
pub fn pick<'a>(items: &[&'a UpNextItem], key: &str) -> Result<&'a UpNextItem> {
    let (repo, num) = match key.trim().rsplit_once('#') {
        Some((r, n)) => (r.trim(), n),
        None => ("", key.trim()),
    };
    let n: i64 = num.parse().map_err(|_| {
        CliError::new(
            Exit::Usage,
            format!("{key:?} is not an Up Next item: use <repo>#<number> or <number>"),
        )
    })?;
    let hits: Vec<&UpNextItem> = items
        .iter()
        .copied()
        .filter(|i| i.number == n && (repo.is_empty() || repo_matches(i, repo)))
        .collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(CliError::new(
            Exit::Usage,
            format!("{key} is not in the Up Next queue"),
        )),
        many => Err(CliError::new(
            Exit::Usage,
            format!(
                "{key} is ambiguous; name the repo: {}",
                many.iter().map(|i| item_ref(i)).collect::<Vec<_>>().join(", ")
            ),
        )),
    }
}

async fn list(ctx: &mut Ctx<'_>) -> Result<()> {
    let snap = fetch_snapshot(ctx, LIST).await?;
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &snap);
    }
    if snap.failed_repo_count > 0 {
        ctx.io.warn(&format!(
            "warning: {} repo(s) could not be listed",
            snap.failed_repo_count
        ));
    }
    let mut t = output::table(&["ITEM", "KIND", "TITLE", "AGE"]);
    for item in items(&snap) {
        let kind = if item.priority {
            format!("{} !", item.kind.0)
        } else {
            item.kind.0.clone()
        };
        t.add_row(vec![
            item_ref(item),
            kind,
            summary(&item.title),
            ago(item.created_at),
        ]);
    }
    output::print_table(&mut ctx.io.stdout, &t)
}

async fn start(ctx: &mut Ctx<'_>, args: UpNextStartArgs) -> Result<()> {
    if (args.model.is_some() || args.effort.is_some()) && args.provider.is_none() {
        return Err(CliError::new(
            Exit::Usage,
            "--model and --effort need --provider",
        ));
    }
    let snap = fetch_snapshot(ctx, START).await?;
    let all = items(&snap);
    let mut picked: Vec<UpNextStartItem> = Vec::new();
    for key in &args.items {
        let item = pick(&all, key)?;
        picked.push(UpNextStartItem {
            repo_path: item.repo_path.clone(),
            issue_ref: item.issue_ref.clone().into(),
        });
    }
    let result = ctx
        .client
        .start_up_next()
        .body_map(|b| {
            b.items(picked)
                .agent_provider(args.provider)
                .model(args.model)
                .effort(args.effort.map(|e| e.to_string()))
        })
        .send()
        .await;
    let outcome: UpNextStartResult = match result {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, START).await),
    };
    let mut text = Vec::new();
    for s in &outcome.created {
        text.push(format!("created {} ({}) — {}", s.desig, s.id, s.name));
    }
    for h in &outcome.held {
        let how = if h.reused == Some(true) { "already held" } else { "held" };
        text.push(format!("{how}: #{} as {}", h.number, h.id));
    }
    for e in &outcome.errors {
        text.push(format!("failed: #{} — {}", e.number, e.error));
    }
    print_done(ctx, &outcome, &text.join("\n"))
}
