//! Reviews and merging: `review-pr`, `review-plan`, `merge`, `merge-pr`, `train …`.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use super::control::print_create_result;
use super::intake::put_repo_flag;
use super::{VersionCheck, list_sessions, print_done, repo_path, session_id};
use crate::Ctx;
use crate::api::Client;
use crate::api::types::{
    GitState, MergeBacklogPrError, MergeConfirmRefusal, MergeConfirmation, MergeResponsibility,
    Session,
};
use crate::cli::{MergeArgs, MergePrArgs, Override, RepoArg, TrainCmd, TrainLaunchArgs};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode, or_dash};

const REVIEW_PR: Op = Op::new("review-pr", Scope::Full);
const REVIEW_PLAN: Op = Op::new("review-plan", Scope::Full);
const MERGE: Op = Op::new("merge", Scope::Full);
const TRAIN_STATUS: Op = Op::new("train status", Scope::Full);
const TRAIN_START: Op = Op::new("train start", Scope::Full);
const TRAIN_STOP: Op = Op::new("train stop", Scope::Full);
const TRAIN_SET: Op = Op::new("train set", Scope::Full);
const MERGE_PR: Op = Op::new("merge-pr", Scope::Full);
const TRAIN_LAUNCH: Op = Op::new("train launch", Scope::Submit);

/// Kickoff prompts the UI sends (`herd_merge_train_prompt`, `prspanel_merge_train_prompt`;
/// parity-tested against en.json). `{prs}` takes the `formatReadyPrs` list.
const TRAIN_READY_PROMPT: &str = include_str!("../prompts/merge_train_ready.txt");
const TRAIN_SELECTED_PROMPT: &str = include_str!("../prompts/merge_train_selected.txt");

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
    confirm_from(
        git.merge_gate.as_ref(),
        git.head_sha.clone(),
        git.base_ref_name.clone(),
    )
}

/// A takeover confirmation from a PR revision, target and responsibility.
fn confirm_from(
    gate: Option<&MergeResponsibility>,
    head_sha: Option<String>,
    base_ref_name: Option<String>,
) -> MergeConfirmation {
    MergeConfirmation {
        head_sha,
        base_ref_name,
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
        Err(e) => return Err(takeover_hint(api_error(e, MERGE).await)),
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

/// A merge-confirmation refusal gains a pointer at `--takeover`.
fn takeover_hint(err: CliError) -> CliError {
    if err.exit == Exit::Refused && err.message.contains("merge_confirm_") {
        return CliError::new(
            err.exit,
            format!(
                "{}. Rerun with --takeover to take the merge over.",
                err.message
            ),
        );
    }
    err
}

/// The refusal a takeover answers by echoing the PR state back: a confirmation is missing or
/// stale. Any other refusal (e.g. a mismatched echo) is final.
fn takeover_refusal(e: &MergeBacklogPrError) -> Option<&MergeConfirmRefusal> {
    match e {
        MergeBacklogPrError::MergeConfirmRefusal(r)
            if matches!(
                r.code.as_deref(),
                Some("merge_confirm_required" | "merge_confirm_stale")
            ) =>
        {
            Some(r)
        }
        _ => None,
    }
}

/// One `POST /api/prs/merge`. `Ok(None)` merged; `Ok(Some(confirm))` is a takeover's first,
/// unconfirmed attempt refused with the PR state to echo back.
async fn merge_pr_attempt(
    client: &Client,
    repo: &str,
    args: &MergePrArgs,
    confirm: Option<MergeConfirmation>,
) -> Result<Option<MergeConfirmation>> {
    let first = confirm.is_none();
    let result = client
        .merge_backlog_pr()
        .body_map(|b| {
            b.repo(repo.to_string())
                .number(args.number)
                .method(args.method)
                .delete_branch(args.keep_branch.then_some(false))
                .confirm(confirm)
        })
        .send()
        .await;
    let Err(err) = result else {
        return Ok(None);
    };
    if args.takeover
        && first
        && let progenitor_client::Error::ErrorResponse(rv) = &err
        && rv.status().as_u16() == 409
        && let Some(r) = takeover_refusal(rv.as_ref())
    {
        return Ok(Some(confirm_from(
            r.gate.as_ref(),
            r.head_sha.clone(),
            r.base_ref_name.clone(),
        )));
    }
    let err = api_error(err, MERGE_PR).await;
    Err(if args.takeover {
        err
    } else {
        takeover_hint(err)
    })
}

pub async fn merge_pr(ctx: &mut Ctx<'_>, args: MergePrArgs) -> Result<()> {
    let repo = repo_path(ctx, args.repo.clone())?;
    let check = VersionCheck::start(&ctx.client);
    if let Some(confirm) = merge_pr_attempt(&ctx.client, &repo, &args, None).await? {
        // Retry exactly once: the server rechecks every echoed field, so a second refusal is
        // final (a confirmed attempt never asks for another echo).
        merge_pr_attempt(&ctx.client, &repo, &args, Some(confirm)).await?;
    }
    print_done(
        ctx,
        &json!({ "ok": true, "repo": repo, "number": args.number }),
        &format!("merged PR #{}", args.number),
    )?;
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
        TrainCmd::Launch(args) => train_launch(ctx, args).await?,
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
    // Draft mode and full-auto merge are mutually exclusive: like the UI toggle, turning the
    // train on clears draft mode, or the server refuses the patch with a 400.
    put_repo_flag(ctx, repo.clone(), op, |b| {
        let b = b.auto_merge_enabled(Some(on));
        if on { b.draft_mode(Some(false)) } else { b }
    })
    .await?;
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

/// A pull request a merge train works through.
#[derive(Clone, Debug, PartialEq)]
pub struct ReadyPr {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub repo_path: String,
}

/// Ready-to-merge sessions with an open PR whose review (critic or plan) is not in flight — the
/// merge-train targets. Port of `collectReadyPrs` (ui/src/lib/components/merge-train.ts).
pub fn collect_ready_prs(
    sessions: &[Session],
    git: &HashMap<String, GitState>,
    reviewing: &HashSet<String>,
) -> Vec<ReadyPr> {
    sessions
        .iter()
        .filter(|s| s.ready_to_merge && !reviewing.contains(&s.id))
        .filter_map(|s| {
            let g = git.get(&s.id)?;
            if g.state.0 != "open" {
                return None;
            }
            Some(ReadyPr {
                number: g.number?,
                title: g.title.clone().unwrap_or_default(),
                url: g.url.clone().unwrap_or_default(),
                repo_path: s.repo_path.clone(),
            })
        })
        .collect()
}

/// The repo with the most ready PRs (ties → first encountered), its PRs, and how many ready PRs
/// other repos hold. Port of `pickTrainRepo`.
pub fn pick_train_repo(prs: Vec<ReadyPr>) -> (Option<String>, Vec<ReadyPr>, usize) {
    let Some(first) = prs.first() else {
        return (None, Vec::new(), 0);
    };
    let mut order: Vec<&str> = Vec::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for p in &prs {
        let n = counts.entry(p.repo_path.as_str()).or_insert(0);
        if *n == 0 {
            order.push(p.repo_path.as_str());
        }
        *n += 1;
    }
    let mut best = first.repo_path.as_str();
    for repo in order {
        if counts[repo] > counts[best] {
            best = repo;
        }
    }
    let best = best.to_string();
    let total = prs.len();
    let picked: Vec<ReadyPr> = prs.into_iter().filter(|p| p.repo_path == best).collect();
    let others = total - picked.len();
    (Some(best), picked, others)
}

/// One `- #<n> <title> — <url>` bullet per PR, dropping an absent title or url. Port of
/// `formatReadyPrs`.
pub fn format_ready_prs(prs: &[ReadyPr]) -> String {
    prs.iter()
        .map(|p| {
            let mut line = format!("- #{}", p.number);
            if !p.title.is_empty() {
                line.push_str(&format!(" {}", p.title));
            }
            if !p.url.is_empty() {
                line.push_str(&format!(" — {}", p.url));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn git_map(client: &Client, op: Op) -> Result<HashMap<String, GitState>> {
    match client.git_states().send().await {
        Ok(m) => Ok(m.into_inner().0),
        Err(e) => Err(api_error(e, op).await),
    }
}

/// Session ids whose critic review or plan review is running right now.
async fn reviewing_ids(client: &Client) -> Result<HashSet<String>> {
    let (reviews, plans) = tokio::join!(
        client.list_reviews_inflight().send(),
        client.list_plan_gates_inflight().send()
    );
    let reviews = match reviews {
        Ok(r) => r.into_inner().0,
        Err(e) => return Err(api_error(e, TRAIN_LAUNCH).await),
    };
    let plans = match plans {
        Ok(p) => p.into_inner().0,
        Err(e) => return Err(api_error(e, TRAIN_LAUNCH).await),
    };
    Ok(reviews
        .into_iter()
        .map(|r| r.id)
        .chain(plans.into_iter().map(|p| p.id))
        .collect())
}

/// The flagged-ready PRs of one repo, warning about ready PRs the train leaves out.
async fn ready_train(ctx: &mut Ctx<'_>, repo: Option<String>) -> Result<(String, Vec<ReadyPr>)> {
    let (sessions, git, reviewing) = tokio::join!(
        list_sessions(&ctx.client, TRAIN_LAUNCH),
        git_map(&ctx.client, TRAIN_LAUNCH),
        reviewing_ids(&ctx.client)
    );
    let ready = collect_ready_prs(&sessions?, &git?, &reviewing?);
    let (repo, prs, others) = match repo {
        Some(repo) => {
            let prs: Vec<ReadyPr> = ready.into_iter().filter(|p| p.repo_path == repo).collect();
            (Some(repo), prs, 0)
        }
        None => pick_train_repo(ready),
    };
    match repo {
        Some(repo) if !prs.is_empty() => {
            if others > 0 {
                ctx.io.warn(&format!(
                    "warning: {others} ready PRs in other repos not included"
                ));
            }
            Ok((repo, prs))
        }
        _ => Err(CliError::new(Exit::Refused, "no ready-to-merge PRs")),
    }
}

/// The given PR numbers, titled from the git state of a session in `repo` that has the PR.
async fn selected_train(client: &Client, repo: &str, numbers: &[i64]) -> Result<Vec<ReadyPr>> {
    let (sessions, git) = tokio::join!(
        list_sessions(client, TRAIN_LAUNCH),
        git_map(client, TRAIN_LAUNCH)
    );
    let (sessions, git) = (sessions?, git?);
    let known = |n: i64| {
        sessions
            .iter()
            .filter(|s| s.repo_path == repo)
            .filter_map(|s| git.get(&s.id))
            .find(|g| g.number == Some(n))
    };
    Ok(numbers
        .iter()
        .map(|&n| {
            let g = known(n);
            ReadyPr {
                number: n,
                title: g.and_then(|g| g.title.clone()).unwrap_or_default(),
                url: g.and_then(|g| g.url.clone()).unwrap_or_default(),
                repo_path: repo.to_string(),
            }
        })
        .collect())
}

async fn train_launch(ctx: &mut Ctx<'_>, args: TrainLaunchArgs) -> Result<()> {
    let handpicked = !args.numbers.is_empty();
    let (repo, prs) = if handpicked {
        let repo = repo_path(ctx, args.repo)?;
        let prs = selected_train(&ctx.client, &repo, &args.numbers).await?;
        (repo, prs)
    } else {
        ready_train(ctx, args.repo).await?
    };
    let template = if handpicked {
        TRAIN_SELECTED_PROMPT
    } else {
        TRAIN_READY_PROMPT
    };
    let prompt = template.replace("{prs}", &format_ready_prs(&prs));
    let numbers: Vec<i64> = prs.iter().map(|p| p.number).collect();
    // Mirrors the UI's `mergeTrainCreateInput` + `force: true`: a procedural land-the-queue task
    // never runs the plan gate or autopilot, and the operator asked for it now.
    let result = ctx
        .client
        .create_session()
        .body_map(|b| {
            b.repo_path(repo)
                .base_branch(args.base)
                .prompt(prompt)
                .model(None::<String>)
                .merge_train_prs(numbers)
                .plan_gate_enabled(Some(false))
                .autopilot_enabled(Some(false))
                .force(Some(true))
        })
        .send()
        .await;
    let created = match result {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, TRAIN_LAUNCH).await),
    };
    print_create_result(ctx, created)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: i64, title: &str, url: &str, repo: &str) -> ReadyPr {
        ReadyPr {
            number,
            title: title.into(),
            url: url.into(),
            repo_path: repo.into(),
        }
    }

    #[test]
    fn formats_like_the_ui() {
        let prs = [
            pr(1, "One", "u1", "/r"),
            pr(2, "", "u2", "/r"),
            pr(3, "Three", "", "/r"),
            pr(4, "", "", "/r"),
        ];
        assert_eq!(
            format_ready_prs(&prs),
            "- #1 One — u1\n- #2 — u2\n- #3 Three\n- #4"
        );
    }

    #[test]
    fn picks_the_busiest_repo_ties_first() {
        let (repo, prs, others) = pick_train_repo(vec![
            pr(1, "", "", "/a"),
            pr(2, "", "", "/b"),
            pr(3, "", "", "/b"),
        ]);
        assert_eq!(repo.as_deref(), Some("/b"));
        assert_eq!(prs.len(), 2);
        assert_eq!(others, 1);
        let (repo, _, others) = pick_train_repo(vec![pr(1, "", "", "/a"), pr(2, "", "", "/b")]);
        assert_eq!(repo.as_deref(), Some("/a"));
        assert_eq!(others, 1);
        assert_eq!(pick_train_repo(Vec::new()).0, None);
    }
}
