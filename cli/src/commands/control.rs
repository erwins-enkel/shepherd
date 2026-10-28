//! Session control: `new`, `steer`, `interrupt`, `archive`, `resume`, `go`, `halt`, `retry`.

use serde_json::json;

use super::{VersionCheck, list_sessions, print_done, repo_path, session_id};
use crate::Ctx;
use crate::api::Client;
use crate::api::types::{
    Capability, CreateSessionSuccess, PlacementPreview, Session, SessionHost, TaskTarget,
};
use crate::cli::NewArgs;
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode};

const NEW: Op = Op::new("new", Scope::Submit);
const NEW_ON: Op = Op::new("new --on", Scope::Submit);
const STEER: Op = Op::new("steer", Scope::Full);
const INTERRUPT: Op = Op::new("interrupt", Scope::Full);
const ARCHIVE: Op = Op::new("archive", Scope::Full);
const RESUME: Op = Op::new("resume", Scope::Full);
const GO: Op = Op::new("go", Scope::Full);
const HALT: Op = Op::new("halt", Scope::Full);
const RETRY: Op = Op::new("retry", Scope::Full);

/// The steer the UI's Retry dialog sends (`retry_continue_steer`; parity-tested against en.json).
const RETRY_CONTINUE: &str = include_str!("../prompts/retry_continue.txt");

/// The capability vocabulary (`CAPABILITIES` in src/remote-instances/capabilities.ts;
/// parity-tested in test/cli-capability-parity.test.ts). The contract keeps it open, so `--require`
/// warns about a value outside it and sends it anyway: the server decides.
const CAPABILITIES: &[&str] = &[
    "platform:linux",
    "platform:macos",
    "platform:windows",
    "xcode",
    "sdk:macos",
    "sdk:ios",
    "ios-simulator",
    "android-sdk",
    "agent:claude",
    "agent:codex",
    "sandbox:trusted",
    "sandbox:standard",
    "sandbox:autonomous",
];

fn print_created(ctx: &mut Ctx<'_>, verb: &str, s: &Session, on: Option<&str>) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, s);
    }
    let on = on.map(|m| format!(" on {m}")).unwrap_or_default();
    output::line(
        &mut ctx.io.stdout,
        &format!("{verb} {} ({}) — {}{on}", s.desig, s.id, s.name),
    )
}

/// Prints what `POST /api/sessions` answered: the created session, the held task, or the task
/// waiting for the machine it is meant for (#2775).
pub fn print_create_result(ctx: &mut Ctx<'_>, created: CreateSessionSuccess) -> Result<()> {
    match created {
        CreateSessionSuccess::Session(s) => {
            // The machine it was placed on (#3527); no record while no machine could take a task.
            let on = s
                .launch_metadata
                .as_ref()
                .and_then(|m| m.placement.as_ref())
                .map(|p| p.target.name.as_str());
            print_created(ctx, "created", &s, on)
        }
        CreateSessionSuccess::HeldTask(h) => {
            if ctx.mode == Mode::Json {
                return output::json(&mut ctx.io.stdout, &h);
            }
            if h.waiting == Some(true) {
                let machine = h.host.as_ref().map_or("its machine", |m| m.name.as_str());
                return output::line(
                    &mut ctx.io.stdout,
                    &format!(
                        "waiting: {machine} is out of reach, so the task waits for it as {} and \
                         starts there once it is back. Cancel or redirect it in the herd.",
                        h.id
                    ),
                );
            }
            if h.reason.as_ref().is_some_and(|r| r.0 == "after") {
                return output::line(
                    &mut ctx.io.stdout,
                    &format!(
                        "held: waiting for its predecessor's PR to land, queued as {} ({} held). \
                         It spawns once that PR merges.",
                        h.id, h.count
                    ),
                );
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

/// What `POST /api/placement` answers for `repo`, with `target` named or not.
async fn preview_placement(
    client: &Client,
    repo: &str,
    target: Option<&str>,
) -> Result<PlacementPreview> {
    let result = client
        .preview_placement()
        .body_map(|b| {
            b.repo_path(repo).target(target.map(|id| TaskTarget {
                instance_id: id.to_string(),
            }))
        })
        .send()
        .await;
    match result {
        Ok(r) => Ok(r.into_inner()),
        Err(e) => Err(api_error(e, NEW_ON).await),
    }
}

/// The instance id of the machine `--on` names, among those a create for `repo` may name (#3527).
async fn resolve_machine(client: &Client, repo: &str, on: &str) -> Result<String> {
    let preview = preview_placement(client, repo, None).await?;
    if preview.active {
        return pick_machine(&preview.machines, on, false);
    }
    // No machine is set up, so the preview lists none. Named as the target, this instance's own id
    // still answers `active: false`; any other value gets this instance listed.
    let named = preview_placement(client, repo, Some(on)).await?;
    if !named.active {
        return Ok(on.to_string());
    }
    pick_machine(&named.machines, on, true)
}

/// `on` among `machines` (this instance first): an exact instance id, else the one name that
/// matches ignoring case. `alone`: no other machine is connected.
fn pick_machine(machines: &[SessionHost], on: &str, alone: bool) -> Result<String> {
    if let Some(m) = machines.iter().find(|m| m.instance_id == on) {
        return Ok(m.instance_id.clone());
    }
    let wanted = on.to_lowercase();
    let named: Vec<&SessionHost> = machines
        .iter()
        .filter(|m| m.name.to_lowercase() == wanted)
        .collect();
    let message = match named.as_slice() {
        [m] => return Ok(m.instance_id.clone()),
        [] if alone => format!(
            "--on: no other machine is connected to this server, so the task runs on this machine \
             ({}); drop --on",
            machines.first().map_or("this one", |m| m.name.as_str())
        ),
        [] => format!(
            "--on: no machine '{on}' can take a task for this repo right now; available: {}",
            machines
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        several => format!(
            "--on: '{on}' names several machines: {}; pass the instance id",
            several
                .iter()
                .map(|m| format!("{} ({})", m.name, m.instance_id))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    Err(CliError::new(Exit::Usage, message))
}

pub async fn new(ctx: &mut Ctx<'_>, args: NewArgs) -> Result<()> {
    let prompt = ctx.io.text_arg(&args.prompt)?;
    if prompt.trim().is_empty() {
        return Err(CliError::new(Exit::Usage, "the prompt is empty"));
    }
    let repo = repo_path(ctx, args.repo)?;
    let after = args
        .after
        .map(|a| a.parse())
        .transpose()
        .map_err(|_| CliError::new(Exit::Usage, "--after takes a task id or designation"))?;
    // The server refuses it too (after_remote): a predecessor lives in this machine's namespace.
    if after.is_some() && args.on.is_some() {
        return Err(CliError::new(
            Exit::Usage,
            "--after tasks run on this machine, where their predecessor lives; drop --on",
        ));
    }
    for unknown in args
        .require
        .iter()
        .filter(|c| !CAPABILITIES.contains(&c.as_str()))
    {
        ctx.io.warn(&format!(
            "warning: unknown capability '{unknown}' (known: {}); sending it anyway",
            CAPABILITIES.join(", ")
        ));
    }
    let check = VersionCheck::start(&ctx.client);
    let target = match &args.on {
        Some(on) => Some(resolve_machine(&ctx.client, &repo, on).await?),
        None => None,
    };
    let requirements: Vec<Capability> = args.require.into_iter().map(Capability).collect();
    let result = ctx
        .client
        .create_session()
        .body_map(|b| {
            let mut b = b
                .repo_path(repo)
                .target(target.map(|instance_id| TaskTarget { instance_id }))
                .requirements(requirements)
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
            if let Some(after) = after {
                b = b.after_session(Some(after));
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
    print_created(ctx, "resumed", &session, None)?;
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
