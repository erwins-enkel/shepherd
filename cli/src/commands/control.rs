//! Session control: `new`, `steer`, `interrupt`, `archive`, `resume`.

use std::path::Path;

use serde_json::json;

use super::{VersionCheck, session_id};
use crate::Ctx;
use crate::api::types::{CreateSessionSuccess, Session};
use crate::cli::NewArgs;
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode};

const NEW: Op = Op::new("new", Scope::Submit);
const STEER: Op = Op::new("steer", Scope::Full);
const INTERRUPT: Op = Op::new("interrupt", Scope::Full);
const ARCHIVE: Op = Op::new("archive", Scope::Full);
const RESUME: Op = Op::new("resume", Scope::Full);

fn git_toplevel(cwd: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    let path = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !path.is_empty()).then_some(path)
}

fn print_created(ctx: &mut Ctx<'_>, verb: &str, s: &Session) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, s);
    }
    output::line(
        &mut ctx.io.stdout,
        &format!("{verb} {} ({}) — {}", s.desig, s.id, s.name),
    )
}

pub async fn new(ctx: &mut Ctx<'_>, args: NewArgs) -> Result<()> {
    let prompt = ctx.io.text_arg(&args.prompt)?;
    if prompt.trim().is_empty() {
        return Err(CliError::new(Exit::Usage, "the prompt is empty"));
    }
    let repo = match args.repo.or_else(|| git_toplevel(&ctx.io.cwd)) {
        Some(r) => r,
        None => {
            return Err(CliError::new(
                Exit::Usage,
                "not inside a git repository: pass --repo <path on the server>",
            ));
        }
    };
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
    match created {
        CreateSessionSuccess::Session(s) => print_created(ctx, "created", &s)?,
        CreateSessionSuccess::HeldTask(h) => {
            if ctx.mode == Mode::Json {
                output::json(&mut ctx.io.stdout, &h)?;
            } else {
                output::line(
                    &mut ctx.io.stdout,
                    &format!(
                        "held: the usage hold tripped, so the task was queued as {} ({} held). \
                         Pass --force to spawn now.",
                        h.id, h.count
                    ),
                )?;
            }
        }
    }
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
