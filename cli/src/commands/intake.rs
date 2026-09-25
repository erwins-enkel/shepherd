//! Work intake: `backlog`, `issues`, `drain …`, `held …`.

use serde_json::json;

use super::{VersionCheck, print_done, repo_path};
use crate::Ctx;
use crate::api::types::{RepoConfig, Session};
use crate::cli::{DrainCmd, HeldCmd, RepoArg};
use crate::error::{Op, Result, Scope, api_error};
use crate::output::{self, Mode, ago, or_dash};

const BACKLOG: Op = Op::new("backlog", Scope::Full);
const ISSUES: Op = Op::new("issues", Scope::Full);
const DRAIN_STATUS: Op = Op::new("drain status", Scope::Full);
const DRAIN_QUEUE: Op = Op::new("drain queue", Scope::Full);
const DRAIN_START: Op = Op::new("drain start", Scope::Full);
const DRAIN_STOP: Op = Op::new("drain stop", Scope::Full);
const HELD_LIST: Op = Op::new("held list", Scope::Submit);
const HELD_SPAWN: Op = Op::new("held spawn", Scope::Submit);
const HELD_DISCARD: Op = Op::new("held discard", Scope::Submit);

/// First line of `text`, capped for a table cell.
pub fn summary(text: &str) -> String {
    const MAX: usize = 60;
    let first = text.lines().next().unwrap_or("").trim();
    if first.chars().count() <= MAX {
        return first.to_string();
    }
    let cut: String = first.chars().take(MAX - 1).collect();
    format!("{cut}…")
}

pub async fn backlog(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let payload = match ctx.client.get_backlog().send().await {
        Ok(p) => p.into_inner(),
        Err(e) => return Err(api_error(e, BACKLOG).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &payload)?;
    } else {
        let mut t = output::table(&["REPO", "KIND", "ISSUES", "PRS", "CI", "PATH"]);
        for p in payload.projects.iter().filter(|p| !p.hidden) {
            t.add_row(vec![
                p.slug.clone().unwrap_or_else(|| p.display.clone()),
                p.kind.clone(),
                or_dash(p.open_issues),
                or_dash(p.open_p_rs),
                or_dash(p.ci_status.as_ref()),
                p.path.clone(),
            ]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
        output::line(
            &mut ctx.io.stdout,
            &format!(
                "{} open issues, {} open PRs",
                payload.totals.open_issues, payload.totals.open_p_rs
            ),
        )?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn issues(ctx: &mut Ctx<'_>, args: RepoArg) -> Result<()> {
    let repo = repo_path(ctx, args.repo)?;
    let check = VersionCheck::start(&ctx.client);
    let listing = match ctx.client.list_issues().repo(repo).send().await {
        Ok(l) => l.into_inner(),
        Err(e) => return Err(api_error(e, ISSUES).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &listing)?;
    } else {
        if let Some(err) = &listing.error {
            ctx.io.warn(&format!("warning: the forge fetch failed ({err})"));
        } else if listing.slug.is_none() {
            ctx.io.warn("warning: this repo has no forge, so it has no issues");
        }
        let mut t = output::table(&["#", "TITLE", "LABELS", "AGE"]);
        for i in &listing.issues {
            t.add_row(vec![
                i.number.to_string(),
                summary(&i.title),
                i.labels.join(","),
                ago(i.created_at),
            ]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn drain(ctx: &mut Ctx<'_>, cmd: DrainCmd) -> Result<()> {
    match cmd {
        DrainCmd::Status => drain_status(ctx).await,
        DrainCmd::Queue(args) => drain_queue(ctx, args).await,
        DrainCmd::Start(args) => drain_toggle(ctx, args, true).await,
        DrainCmd::Stop(args) => drain_toggle(ctx, args, false).await,
    }
}

async fn drain_status(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let list = match ctx.client.list_drain().send().await {
        Ok(l) => l.into_inner().0,
        Err(e) => return Err(api_error(e, DRAIN_STATUS).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &list)?;
    } else {
        let mut t = output::table(&["REPO", "STATE", "QUEUED", "RUNNING", "EPIC", "DETAIL"]);
        for d in &list {
            let state = match (d.enabled, d.paused) {
                (false, _) => "off".to_string(),
                (true, true) => format!("paused ({})", d.reason.as_deref().unwrap_or("-")),
                (true, false) => "on".to_string(),
            };
            t.add_row(vec![
                d.repo_path.clone(),
                state,
                d.queued.to_string(),
                format!("{}/{}", d.in_flight, d.max),
                or_dash(d.epic_parent.map(|n| format!("#{n}"))),
                or_dash(d.detail.as_ref()),
            ]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

async fn drain_queue(ctx: &mut Ctx<'_>, args: RepoArg) -> Result<()> {
    let repo = repo_path(ctx, args.repo)?;
    let check = VersionCheck::start(&ctx.client);
    let list = match ctx.client.list_drain_queue().repo(repo).send().await {
        Ok(l) => l.into_inner().0,
        Err(e) => return Err(api_error(e, DRAIN_QUEUE).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &list)?;
    } else {
        let mut t = output::table(&["#", "TITLE", "URL"]);
        for i in &list {
            t.add_row(vec![i.number.to_string(), summary(&i.title), i.url.clone()]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

/// Flips one boolean of a repo's config (`PUT /api/repo-config`), as the UI toggle does.
pub async fn put_repo_flag(
    ctx: &mut Ctx<'_>,
    repo: String,
    op: Op,
    set: impl FnOnce(
        crate::api::types::builder::RepoConfigPatch,
    ) -> crate::api::types::builder::RepoConfigPatch,
) -> Result<RepoConfig> {
    match ctx
        .client
        .put_repo_config()
        .repo(repo)
        .body_map(set)
        .send()
        .await
    {
        Ok(c) => Ok(c.into_inner()),
        Err(e) => Err(api_error(e, op).await),
    }
}

async fn drain_toggle(ctx: &mut Ctx<'_>, args: RepoArg, on: bool) -> Result<()> {
    let repo = repo_path(ctx, args.repo)?;
    let check = VersionCheck::start(&ctx.client);
    let op = if on { DRAIN_START } else { DRAIN_STOP };
    put_repo_flag(ctx, repo.clone(), op, |b| b.auto_drain_enabled(Some(on))).await?;
    let verb = if on { "started" } else { "stopped" };
    print_done(
        ctx,
        &json!({ "ok": true, "repo": repo, "autoDrainEnabled": on }),
        &format!("auto-drain {verb} for {repo}"),
    )?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn held(ctx: &mut Ctx<'_>, cmd: HeldCmd) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    match cmd {
        HeldCmd::List => held_list(ctx).await?,
        HeldCmd::Spawn { id, provider } => {
            let result = ctx
                .client
                .spawn_held()
                .id(id.as_str())
                .body_map(|b| b.agent_provider(provider))
                .send()
                .await;
            let session: Session = match result {
                Ok(s) => s.into_inner(),
                Err(e) => return Err(api_error(e, HELD_SPAWN).await),
            };
            let text = format!("spawned {} ({}) — {}", session.desig, session.id, session.name);
            print_done(ctx, &session, &text)?;
        }
        HeldCmd::Discard { id } => {
            if let Err(e) = ctx.client.discard_held().id(id.as_str()).send().await {
                return Err(api_error(e, HELD_DISCARD).await);
            }
            print_done(
                ctx,
                &json!({ "ok": true, "id": id }),
                &format!("discarded {id}"),
            )?;
        }
    }
    check.finish(ctx.io).await;
    Ok(())
}

async fn held_list(ctx: &mut Ctx<'_>) -> Result<()> {
    let list = match ctx.client.list_held().send().await {
        Ok(l) => l.into_inner().0,
        Err(e) => return Err(api_error(e, HELD_LIST).await),
    };
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &list);
    }
    let mut t = output::table(&["ID", "REASON", "REPO", "AGE", "PROMPT"]);
    for h in &list {
        t.add_row(vec![
            h.id.clone(),
            or_dash(h.reason.as_ref().map(|r| r.0.clone())),
            h.repo_path.clone(),
            ago(h.created_at),
            summary(&h.input.prompt),
        ]);
    }
    output::print_table(&mut ctx.io.stdout, &t)
}
