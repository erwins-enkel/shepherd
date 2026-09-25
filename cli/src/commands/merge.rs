//! Reviews and merging: `review-pr`, `review-plan`, `merge`, `train …`.

use serde_json::json;

use super::intake::put_repo_flag;
use super::{VersionCheck, print_done, repo_path, session_id};
use crate::Ctx;
use crate::api::Client;
use crate::api::types::{GitState, MergeConfirmation, Session};
use crate::cli::{MergeArgs, Override, RepoArg, TrainCmd};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode, or_dash};

const REVIEW_PR: Op = Op::new("review-pr", Scope::Full);
const REVIEW_PLAN: Op = Op::new("review-plan", Scope::Full);
const MERGE: Op = Op::new("merge", Scope::Full);
const TRAIN_STATUS: Op = Op::new("train status", Scope::Full);
const TRAIN_START: Op = Op::new("train start", Scope::Full);
const TRAIN_STOP: Op = Op::new("train stop", Scope::Full);
const TRAIN_SET: Op = Op::new("train set", Scope::Full);

pub async fn review_pr(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, REVIEW_PR).await?;
    let result = match ctx.client.review_pr().id(id.as_str()).send().await {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, REVIEW_PR).await),
    };
    let text = format!("PR review for {key}: {}", result.status.0);
    print_done(ctx, &result, &text)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn review_plan(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, REVIEW_PLAN).await?;
    let result = match ctx.client.review_plan().id(id.as_str()).send().await {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, REVIEW_PLAN).await),
    };
    let text = format!("plan review for {key}: {}", result.status.0);
    print_done(ctx, &result, &text)?;
    check.finish(ctx.io).await;
    Ok(())
}

/// The confirmation a takeover merge echoes: the PR revision, target and responsible people as
/// the server's cached git state shows them. The server rechecks every field.
pub fn takeover_confirm(git: &GitState) -> MergeConfirmation {
    let gate = git.merge_gate.as_ref();
    MergeConfirmation {
        head_sha: git.head_sha.clone(),
        base_ref_name: git.base_ref_name.clone(),
        handoff: gate
            .and_then(|g| g.handoff.as_ref())
            .and_then(|h| h.0.parse().ok()),
        handoff_who: gate.and_then(|g| g.handoff_who.clone()),
        review_block_by: gate.and_then(|g| g.review_block_by.clone()),
    }
}

async fn git_state(client: &Client, id: &str) -> Result<GitState> {
    let map = match client.git_states().send().await {
        Ok(m) => m.into_inner(),
        Err(e) => return Err(api_error(e, MERGE).await),
    };
    map.get(id).cloned().ok_or_else(|| {
        CliError::new(
            Exit::Refused,
            "the server has no pull-request state for this session yet; cannot confirm a takeover",
        )
    })
}

pub async fn merge(ctx: &mut Ctx<'_>, args: MergeArgs) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, &args.session, MERGE).await?;
    let confirm = if args.takeover {
        Some(takeover_confirm(&git_state(&ctx.client, &id).await?))
    } else {
        None
    };
    let result = ctx
        .client
        .merge_pull_request()
        .id(id.as_str())
        .body_map(|b| {
            b.method(args.method)
                .delete_branch(args.keep_branch.then_some(false))
                .confirm(confirm)
        })
        .send()
        .await;
    let git = match result {
        Ok(g) => g.into_inner(),
        Err(e) => {
            let err = api_error(e, MERGE).await;
            if err.exit == Exit::Refused && err.message.contains("merge_confirm_") {
                return Err(CliError::new(
                    err.exit,
                    format!(
                        "{}. Rerun with --takeover to take the merge over.",
                        err.message
                    ),
                ));
            }
            return Err(err);
        }
    };
    let text = format!(
        "merged {}{}",
        args.session,
        git.number
            .map(|n| format!(" (PR #{n})"))
            .unwrap_or_default()
    );
    print_done(ctx, &git, &text)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn train(ctx: &mut Ctx<'_>, cmd: TrainCmd) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    match cmd {
        TrainCmd::Status => train_status(ctx).await?,
        TrainCmd::Start(args) => train_toggle(ctx, args, true).await?,
        TrainCmd::Stop(args) => train_toggle(ctx, args, false).await?,
        TrainCmd::Set { session, value } => train_set(ctx, &session, value).await?,
    }
    check.finish(ctx.io).await;
    Ok(())
}

async fn train_status(ctx: &mut Ctx<'_>) -> Result<()> {
    let list = match ctx.client.list_automerge().send().await {
        Ok(l) => l.into_inner().0,
        Err(e) => return Err(api_error(e, TRAIN_STATUS).await),
    };
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &list);
    }
    let mut t = output::table(&["REPO", "ENABLED", "STATE", "SESSION", "DETAIL"]);
    for a in &list {
        t.add_row(vec![
            a.repo_path.clone(),
            if a.enabled { "on" } else { "off" }.to_string(),
            or_dash(a.state.as_ref()),
            or_dash(a.session_id.as_ref()),
            or_dash(a.detail.as_ref()),
        ]);
    }
    output::print_table(&mut ctx.io.stdout, &t)
}

async fn train_toggle(ctx: &mut Ctx<'_>, args: RepoArg, on: bool) -> Result<()> {
    let repo = repo_path(ctx, args.repo)?;
    let op = if on { TRAIN_START } else { TRAIN_STOP };
    put_repo_flag(ctx, repo.clone(), op, |b| b.auto_merge_enabled(Some(on))).await?;
    let verb = if on { "started" } else { "stopped" };
    print_done(
        ctx,
        &json!({ "ok": true, "repo": repo, "autoMergeEnabled": on }),
        &format!("merge train {verb} for {repo}"),
    )
}

async fn train_set(ctx: &mut Ctx<'_>, key: &str, value: Override) -> Result<()> {
    let id = session_id(&ctx.client, key, TRAIN_SET).await?;
    let result = ctx
        .client
        .set_session_automerge()
        .id(id.as_str())
        .body_map(|b| b.enabled(value.0))
        .send()
        .await;
    let session: Session = match result {
        Ok(s) => s.into_inner(),
        Err(e) => return Err(api_error(e, TRAIN_SET).await),
    };
    let what = match value.0 {
        Some(true) => "on",
        Some(false) => "off",
        None => "the repo default",
    };
    let text = format!("merge train for {} set to {what}", session.desig);
    print_done(ctx, &session, &text)
}
