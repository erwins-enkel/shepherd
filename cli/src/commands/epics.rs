//! Epics: `epics list|show|start|pause|stop|approve-next`.

use std::num::NonZeroU64;

use super::intake::summary;
use super::{VersionCheck, print_done, repo_path};
use crate::Ctx;
use crate::api::Client;
use crate::api::types::{Epic, EpicRunPatch, EpicRunPatchStatus, EpicUpdateResult};
use crate::cli::{EpicStartArgs, EpicsCmd};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode, or_dash};

const EPICS_LIST: Op = Op::new("epics list", Scope::Full);
const EPICS_SHOW: Op = Op::new("epics show", Scope::Full);
const EPICS_START: Op = Op::new("epics start", Scope::Full);
const EPICS_PAUSE: Op = Op::new("epics pause", Scope::Full);
const EPICS_STOP: Op = Op::new("epics stop", Scope::Full);
const EPICS_APPROVE_NEXT: Op = Op::new("epics approve-next", Scope::Full);

pub async fn run(ctx: &mut Ctx<'_>, repo: Option<String>, cmd: EpicsCmd) -> Result<()> {
    let repo = repo_path(ctx, repo)?;
    let check = VersionCheck::start(&ctx.client);
    match cmd {
        EpicsCmd::List => list(ctx, repo).await?,
        EpicsCmd::Show { parent } => show(ctx, repo, parent).await?,
        EpicsCmd::Start(args) => start(ctx, repo, args).await?,
        EpicsCmd::Pause { parent } => {
            require_run(&ctx.client, &repo, parent, &["running"], None, EPICS_PAUSE).await?;
            let patch = status_patch(EpicRunPatchStatus::Paused);
            patch_run(ctx, repo, parent, patch, EPICS_PAUSE).await?
        }
        EpicsCmd::Stop { parent } => {
            let states = ["running", "paused"];
            require_run(&ctx.client, &repo, parent, &states, None, EPICS_STOP).await?;
            let patch = status_patch(EpicRunPatchStatus::Idle);
            patch_run(ctx, repo, parent, patch, EPICS_STOP).await?
        }
        EpicsCmd::ApproveNext { parent } => {
            let op = EPICS_APPROVE_NEXT;
            require_run(
                &ctx.client,
                &repo,
                parent,
                &["running"],
                Some("attended"),
                op,
            )
            .await?;
            approve_next(ctx, repo, parent).await?
        }
    }
    check.finish(ctx.io).await;
    Ok(())
}

async fn list(ctx: &mut Ctx<'_>, repo: String) -> Result<()> {
    let listing = match ctx.client.list_epics().repo(repo).send().await {
        Ok(l) => l.into_inner(),
        Err(e) => return Err(api_error(e, EPICS_LIST).await),
    };
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &listing);
    }
    let mut t = output::table(&["#", "TITLE", "STATUS", "DONE", "SOURCE"]);
    for e in &listing.epics {
        t.add_row(vec![
            e.parent_issue_number.to_string(),
            summary(&e.parent_title),
            e.status.to_string(),
            format!("{}/{}", e.merged, e.total),
            e.source.to_string(),
        ]);
    }
    output::print_table(&mut ctx.io.stdout, &t)
}

async fn get_epic(client: &Client, repo: &str, parent: NonZeroU64, op: Op) -> Result<Epic> {
    match client.get_epic().repo(repo).parent(parent).send().await {
        Ok(e) => Ok(e.into_inner()),
        Err(e) => Err(api_error(e, op).await),
    }
}

/// The server keeps one epic run per repo, and a PUT or approve for another parent would replace
/// or act on the live run. So `pause`, `stop` and `approve-next` act only on this parent's own run,
/// in a state the epic panel offers the button for.
async fn require_run(
    client: &Client,
    repo: &str,
    parent: NonZeroU64,
    statuses: &[&str],
    mode: Option<&str>,
    op: Op,
) -> Result<()> {
    let run = get_epic(client, repo, parent, op).await?.run;
    let status_ok = statuses.contains(&run.status.as_str());
    let mode_ok = mode.is_none_or(|m| run.mode.to_string() == m);
    if status_ok && mode_ok {
        return Ok(());
    }
    let mut want = statuses.join(" or ");
    if let Some(m) = mode {
        want = format!("{want} and {m}");
    }
    Err(CliError::new(
        Exit::Refused,
        format!(
            "`shepherd {}` needs epic #{parent}'s run to be {want}; it is {} ({}). \
             The repo keeps one epic run, so another epic's run may be the live one.",
            op.verb, run.status, run.mode
        ),
    ))
}

async fn show(ctx: &mut Ctx<'_>, repo: String, parent: NonZeroU64) -> Result<()> {
    let epic = get_epic(&ctx.client, &repo, parent, EPICS_SHOW).await?;
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &epic);
    }
    print_epic(ctx, &epic)
}

/// A header (parent, run, warnings), then one row per child.
fn print_epic(ctx: &mut Ctx<'_>, epic: &Epic) -> Result<()> {
    let run = &epic.run;
    let out = &mut ctx.io.stdout;
    output::line(
        out,
        &format!("epic #{} — {}", epic.parent_issue_number, epic.parent_title),
    )?;
    output::line(
        out,
        &format!(
            "run: {} ({}), provider {}, model {}, effort {}",
            run.status,
            run.mode,
            or_dash(run.agent_provider.as_ref()),
            or_dash(run.model.as_ref()),
            or_dash(run.effort.as_ref()),
        ),
    )?;
    for w in &epic.warnings {
        output::line(out, &format!("warning: {w}"))?;
    }
    let mut t = output::table(&["#", "STATE", "TITLE", "BLOCKED BY", "PR", "SESSION"]);
    for c in &epic.children {
        let blocked = c
            .blocked_by
            .iter()
            .map(|n| format!("#{n}"))
            .collect::<Vec<_>>()
            .join(",");
        t.add_row(vec![
            c.number.to_string(),
            c.state.to_string(),
            summary(&c.title),
            if blocked.is_empty() {
                "-".into()
            } else {
                blocked
            },
            or_dash(c.pr_number.map(|n| format!("#{n}"))),
            or_dash(c.session_id.as_ref()),
        ]);
    }
    output::print_table(out, &t)
}

fn status_patch(status: EpicRunPatchStatus) -> EpicRunPatch {
    EpicRunPatch {
        status: Some(status),
        ..Default::default()
    }
}

async fn start(ctx: &mut Ctx<'_>, repo: String, args: EpicStartArgs) -> Result<()> {
    let patch = EpicRunPatch {
        status: Some(EpicRunPatchStatus::Running),
        mode: args.mode,
        agent_provider: args.provider,
        model: args.model,
        effort: args.effort.map(|e| e.to_string()),
    };
    patch_run(ctx, repo, args.parent, patch, EPICS_START).await
}

async fn patch_run(
    ctx: &mut Ctx<'_>,
    repo: String,
    parent: NonZeroU64,
    patch: EpicRunPatch,
    op: Op,
) -> Result<()> {
    let result = ctx
        .client
        .patch_epic_run()
        .repo(repo)
        .parent(parent)
        .body(patch)
        .send()
        .await;
    match result {
        Ok(r) => print_update(ctx, parent, &r.into_inner()),
        Err(e) => Err(api_error(e, op).await),
    }
}

async fn approve_next(ctx: &mut Ctx<'_>, repo: String, parent: NonZeroU64) -> Result<()> {
    let result = ctx
        .client
        .approve_epic_next()
        .repo(repo)
        .parent(parent)
        .send()
        .await;
    match result {
        Ok(r) => print_update(ctx, parent, &r.into_inner()),
        Err(e) => Err(api_error(e, EPICS_APPROVE_NEXT).await),
    }
}

/// The run's new status when the server re-assembled the epic, else a bare acknowledgement.
fn print_update(ctx: &mut Ctx<'_>, parent: NonZeroU64, result: &EpicUpdateResult) -> Result<()> {
    let text = match result {
        EpicUpdateResult::Epic(e) => format!("epic #{parent}: {} ({})", e.run.status, e.run.mode),
        EpicUpdateResult::Ok(_) => format!("epic #{parent} updated"),
    };
    print_done(ctx, result, &text)
}
