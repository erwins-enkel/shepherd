//! Session control: `new`, `steer`, `interrupt`, `archive`, `resume`, `go`, `halt`, `retry`.

use serde_json::json;

use super::{VersionCheck, list_sessions, print_done, repo_path, session_id};
use crate::Ctx;
use crate::api::Client;
use crate::api::types::{CreateSessionSuccess, Session};
use crate::cli::NewArgs;
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode};

const NEW: Op = Op::new("new", Scope::Submit);
const STEER: Op = Op::new("steer", Scope::Full);
const INTERRUPT: Op = Op::new("interrupt", Scope::Full);
const ARCHIVE: Op = Op::new("archive", Scope::Full);
const RESUME: Op = Op::new("resume", Scope::Full);
const GO: Op = Op::new("go", Scope::Full);
const HALT: Op = Op::new("halt", Scope::Full);
const RETRY: Op = Op::new("retry", Scope::Full);

/// The steer the UI's Retry dialog sends (`retry_continue_steer`; parity-tested against en.json).
const RETRY_CONTINUE: &str = include_str!("../prompts/retry_continue.txt");

fn print_created(ctx: &mut Ctx<'_>, verb: &str, s: &Session) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, s);
    }
    output::line(
        &mut ctx.io.stdout,
        &format!("{verb} {} ({}) — {}", s.desig, s.id, s.name),
    )
}

/// Prints what `POST /api/sessions` answered: the created session, or the held task.
pub fn print_create_result(ctx: &mut Ctx<'_>, created: CreateSessionSuccess) -> Result<()> {
    match created {
        CreateSessionSuccess::Session(s) => print_created(ctx, "created", &s),
        CreateSessionSuccess::HeldTask(h) => {
            if ctx.mode == Mode::Json {
                return output::json(&mut ctx.io.stdout, &h);
            }
            output::line(
                &mut ctx.io.stdout,
                &format!(
                    "held: the usage hold tripped, so the task was queued as {} ({} held). \
                     Pass --force to spawn now.",
                    h.id, h.count
                ),
            )
        }
    }
}

pub async fn new(ctx: &mut Ctx<'_>, args: NewArgs) -> Result<()> {
    let prompt = ctx.io.text_arg(&args.prompt)?;
    if prompt.trim().is_empty() {
        return Err(CliError::new(Exit::Usage, "the prompt is empty"));
    }
    let repo = repo_path(ctx, args.repo)?;
    let check = VersionCheck::start(&ctx.client);
    let result = ctx
        .client
        .create_session()
        .body_map(|b| {
            let mut b = b
                .repo_path(repo)
                .base_branch(args.base)
                .prompt(prompt)
                .model(args.model)
                .effort(args.effort)
                .agent_provider(args.provider);
            if args.plan_gate {
                b = b.plan_gate_enabled(Some(true));
            }
            if args.autopilot {
                b = b.autopilot_enabled(Some(true));
            }
            if args.force {
                b = b.force(Some(true));
            }
            b
        })
        .send()
        .await;
    let created = match result {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, NEW).await),
    };
    print_create_result(ctx, created)?;
    check.finish(ctx.io).await;
    Ok(())
}

fn print_ok(ctx: &mut Ctx<'_>, verb: &str, key: &str, id: &str) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &json!({ "ok": true, "id": id }));
    }
    output::line(&mut ctx.io.stdout, &format!("{verb} {key}"))
}

pub async fn steer(ctx: &mut Ctx<'_>, key: &str, text: &str) -> Result<()> {
    let text = ctx.io.text_arg(text)?;
    if text.trim().is_empty() {
        return Err(CliError::new(Exit::Usage, "the steer text is empty"));
    }
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, STEER).await?;
    if let Err(e) = ctx
        .client
        .reply_session()
        .id(id.as_str())
        .body_map(|b| b.text(text))
        .send()
        .await
    {
        return Err(api_error(e, STEER).await);
    }
    print_ok(ctx, "steered", key, &id)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn interrupt(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, INTERRUPT).await?;
    if let Err(e) = ctx.client.interrupt_session().id(id.as_str()).send().await {
        return Err(api_error(e, INTERRUPT).await);
    }
    print_ok(ctx, "interrupted", key, &id)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn archive(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, ARCHIVE).await?;
    if let Err(e) = ctx.client.archive_session().id(id.as_str()).send().await {
        return Err(api_error(e, ARCHIVE).await);
    }
    print_ok(ctx, "archived", key, &id)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn resume(ctx: &mut Ctx<'_>, key: &str, force: bool) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, RESUME).await?;
    let result = ctx
        .client
        .resume_session()
        .id(id.as_str())
        .body_map(|b| b.force(force.then_some(true)))
        .send()
        .await;
    let session = match result {
        Ok(s) => s.into_inner(),
        Err(e) => return Err(api_error(e, RESUME).await),
    };
    print_created(ctx, "resumed", &session)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn go(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let id = session_id(&ctx.client, key, GO).await?;
    if let Err(e) = ctx.client.release_plan_gate().id(id.as_str()).send().await {
        return Err(api_error(e, GO).await);
    }
    print_done(
        ctx,
        &json!({ "ok": true, "id": id }),
        &format!("plan gate released for {key}"),
    )?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn halt(ctx: &mut Ctx<'_>, yes: bool) -> Result<()> {
    if !yes {
        return Err(CliError::new(
            Exit::Usage,
            "halt interrupts every live working agent; rerun with --yes",
        ));
    }
    let check = VersionCheck::start(&ctx.client);
    let result = match ctx.client.halt_herd().send().await {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, HALT).await),
    };
    let text = format!("halted {} agents", result.halted);
    print_done(ctx, &result, &text)?;
    check.finish(ctx.io).await;
    Ok(())
}

/// Session ids to retry: the given keys resolved, else every session the usage limit halted.
async fn retry_targets(client: &Client, keys: &[String]) -> Result<Vec<String>> {
    if keys.is_empty() {
        let sessions = list_sessions(client, RETRY).await?;
        return Ok(sessions
            .into_iter()
            .filter(|s| s.halt_reason.as_deref() == Some("usage_limit"))
            .map(|s| s.id)
            .collect());
    }
    let mut ids = Vec::with_capacity(keys.len());
    for key in keys {
        ids.push(session_id(client, key, RETRY).await?);
    }
    Ok(ids)
}

pub async fn retry(ctx: &mut Ctx<'_>, keys: &[String], text: Option<String>) -> Result<()> {
    let text = text.unwrap_or_else(|| RETRY_CONTINUE.to_string());
    if text.trim().is_empty() {
        return Err(CliError::new(Exit::Usage, "the retry text is empty"));
    }
    let check = VersionCheck::start(&ctx.client);
    let ids = retry_targets(&ctx.client, keys).await?;
    if ids.is_empty() {
        print_done(
            ctx,
            &json!({ "resumed": 0, "steered": 0, "total": 0 }),
            "nothing to retry",
        )?;
        check.finish(ctx.io).await;
        return Ok(());
    }
    let result = ctx
        .client
        .retry_halted()
        .body_map(|b| b.ids(ids).text(text))
        .send()
        .await;
    let result = match result {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, RETRY).await),
    };
    let summary = format!(
        "resumed {}, steered {} of {}",
        result.resumed, result.steered, result.total
    );
    print_done(ctx, &result, &summary)?;
    check.finish(ctx.io).await;
    Ok(())
}
