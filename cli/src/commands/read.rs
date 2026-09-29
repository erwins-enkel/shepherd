//! Read verbs: `sessions list|show`, `status`, `holds`, `git`, `reviews`, `messages`.

use std::collections::BTreeMap;

use serde_json::json;

use super::{VersionCheck, label, list_sessions, warn_mismatch};
use crate::api::Client;
use crate::api::types::{Session, SessionMessages};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode, ago, or_dash};
use crate::{CLI_VERSION, Ctx, resolve};

const LIST: Op = Op::new("sessions list", Scope::Read);
/// `GET /api/sessions/archived` is not in the read allowlist.
const LIST_ALL: Op = Op::new("sessions list --all", Scope::Full);
const SHOW: Op = Op::new("sessions show", Scope::Read);
/// `GET /api/sessions/{id}` is not in the read allowlist: only a session missing from the active
/// list (e.g. archived) needs it.
const SHOW_BY_ID: Op = Op::new("sessions show", Scope::Full);
const STATUS: Op = Op::new("status", Scope::Read);
const HOLDS: Op = Op::new("holds", Scope::Read);
const GIT: Op = Op::new("git", Scope::Read);
const REVIEWS: Op = Op::new("reviews", Scope::Read);
/// `GET /api/sessions/{id}/messages` is transcript text, so `full` only.
const MESSAGES: Op = Op::new("messages", Scope::Full);
/// The same route read by `sessions show` for `awaitingInput`/`pendingQuestion`.
const SHOW_MESSAGES: Op = Op::new("sessions show", Scope::Full);

fn repo_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

pub async fn sessions_list(ctx: &mut Ctx<'_>, all: bool) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let mut sessions = list_sessions(&ctx.client, LIST).await?;
    if all {
        match ctx.client.list_archived_sessions().send().await {
            Ok(archived) => sessions.extend(archived.into_inner().0),
            Err(e) => return Err(api_error(e, LIST_ALL).await),
        }
    }
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &sessions)?;
    } else {
        let mut t = output::table(&["DESIG", "NAME", "STATUS", "REPO", "BRANCH", "UPDATED"]);
        for s in &sessions {
            t.add_row(vec![
                s.desig.clone(),
                s.name.clone(),
                s.status.0.clone(),
                repo_name(&s.repo_path).to_string(),
                or_dash(s.branch.as_ref()),
                ago(s.updated_at),
            ]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

async fn get_messages(
    client: &Client,
    id: &str,
    limit: i64,
    include_user: bool,
    op: Op,
) -> Result<SessionMessages> {
    let mut req = client.get_session_messages().id(id).limit(limit);
    if include_user {
        req = req.include_user(true);
    }
    match req.send().await {
        Ok(m) => Ok(m.into_inner()),
        Err(e) => Err(api_error(e, op).await),
    }
}

/// Whether the agent waits on a question. Both `None` when the token can't read the transcript.
struct Awaiting {
    awaiting_input: Option<bool>,
    pending_question: Option<String>,
}

fn print_session(ctx: &mut Ctx<'_>, s: &Session, a: Awaiting) -> Result<()> {
    if ctx.mode == Mode::Json {
        let mut v = serde_json::to_value(s)
            .map_err(|e| CliError::new(Exit::Failure, format!("cannot encode JSON: {e}")))?;
        if let Some(obj) = v.as_object_mut() {
            obj.insert("awaitingInput".into(), json!(a.awaiting_input));
            obj.insert("pendingQuestion".into(), json!(a.pending_question));
        }
        return output::json(&mut ctx.io.stdout, &v);
    }
    let awaiting = a.awaiting_input.map(|b| if b { "yes" } else { "no" });
    let mut t = output::table(&["FIELD", "VALUE"]);
    let rows: [(&str, String); 14] = [
        ("id", s.id.clone()),
        ("desig", s.desig.clone()),
        ("name", s.name.clone()),
        ("status", s.status.0.clone()),
        ("state", s.last_state.0.clone()),
        ("repo", s.repo_path.clone()),
        ("branch", or_dash(s.branch.as_ref())),
        ("base", s.base_branch.clone()),
        ("issue", or_dash(s.issue_number.map(|n| format!("#{n}")))),
        ("updated", ago(s.updated_at)),
        ("archived", or_dash(s.archived_at.map(ago))),
        ("awaiting", or_dash(awaiting)),
        ("question", or_dash(a.pending_question.as_ref())),
        ("prompt", s.prompt.clone()),
    ];
    for (k, v) in rows {
        t.add_row(vec![k.to_string(), v]);
    }
    output::print_table(&mut ctx.io.stdout, &t)
}

pub async fn sessions_show(ctx: &mut Ctx<'_>, key: &str) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let sessions = list_sessions(&ctx.client, SHOW).await?;
    let session = match resolve::find(&sessions, key) {
        Some(s) => s.clone(),
        None => match ctx.client.get_session().id(key.trim()).send().await {
            Ok(s) => s.into_inner(),
            Err(e) => return Err(api_error(e, SHOW_BY_ID).await),
        },
    };
    let awaiting = match get_messages(&ctx.client, &session.id, 0, false, SHOW_MESSAGES).await {
        Ok(m) => Awaiting {
            awaiting_input: Some(m.awaiting_input),
            pending_question: m.pending_question,
        },
        Err(e) if e.exit == Exit::InsufficientScope => {
            ctx.io.warn(
                "warning: awaitingInput and pendingQuestion need a 'full' token; showing them as null",
            );
            Awaiting {
                awaiting_input: None,
                pending_question: None,
            }
        }
        Err(e) => return Err(e),
    };
    print_session(ctx, &session, awaiting)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn messages(ctx: &mut Ctx<'_>, key: &str, limit: i64, include_user: bool) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let sessions = list_sessions(&ctx.client, MESSAGES).await?;
    // A key missing from the active list (e.g. an archived session's id) goes to the server as is.
    let (id, desig) = match resolve::find(&sessions, key) {
        Some(s) => (s.id.clone(), s.desig.clone()),
        None => (key.trim().to_string(), key.trim().to_string()),
    };
    let m = get_messages(&ctx.client, &id, limit, include_user, MESSAGES).await?;
    if ctx.mode == Mode::Json {
        output::json(
            &mut ctx.io.stdout,
            &json!({
                "session": desig,
                "awaitingInput": m.awaiting_input,
                "pendingQuestion": m.pending_question,
                "unavailable": m.unavailable,
                "messages": m.messages,
            }),
        )?;
    } else {
        let out = &mut ctx.io.stdout;
        if let Some(q) = &m.pending_question {
            output::line(out, &format!("awaiting input: {q}"))?;
        }
        if let Some(reason) = &m.unavailable {
            output::line(out, &format!("(no transcript: {reason})"))?;
        } else if m.messages.is_empty() && limit > 0 {
            output::line(out, "(no messages)")?;
        }
        for msg in &m.messages {
            let when = if msg.ts > 0 { ago(msg.ts) } else { "-".into() };
            output::line(out, &format!("── {} · {when} ──", msg.role))?;
            output::line(out, &msg.text)?;
        }
    }
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn status(ctx: &mut Ctx<'_>) -> Result<()> {
    let (health, sessions, holds) = tokio::join!(
        ctx.client.get_health().send(),
        list_sessions(&ctx.client, STATUS),
        ctx.client.get_holds().send(),
    );
    let health = match health {
        Ok(h) => h.into_inner(),
        Err(e) => return Err(api_error(e, STATUS).await),
    };
    let sessions = sessions?;
    let holds = match holds {
        Ok(h) => h.into_inner().0,
        Err(e) => return Err(api_error(e, STATUS).await),
    };
    let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
    for s in &sessions {
        *by_status.entry(s.status.0.clone()).or_default() += 1;
    }
    if ctx.mode == Mode::Json {
        output::json(
            &mut ctx.io.stdout,
            &json!({
                "url": ctx.target.url,
                "serverVersion": health.version,
                "cliVersion": CLI_VERSION,
                "versionMatch": health.version == CLI_VERSION,
                "sessions": { "total": sessions.len(), "byStatus": by_status },
                "held": holds.len(),
            }),
        )?;
    } else {
        let breakdown = by_status
            .iter()
            .map(|(k, v)| format!("{v} {k}"))
            .collect::<Vec<_>>()
            .join(", ");
        let out = &mut ctx.io.stdout;
        output::line(
            out,
            &format!("server    {} (v{})", ctx.target.url, health.version),
        )?;
        output::line(out, &format!("cli       v{CLI_VERSION}"))?;
        let detail = if breakdown.is_empty() {
            String::new()
        } else {
            format!(" ({breakdown})")
        };
        output::line(out, &format!("sessions  {}{detail}", sessions.len()))?;
        output::line(out, &format!("held      {}", holds.len()))?;
    }
    warn_mismatch(ctx.io, &health.version);
    Ok(())
}

pub async fn holds(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let (holds, sessions) = tokio::join!(
        ctx.client.get_holds().send(),
        list_sessions(&ctx.client, HOLDS)
    );
    let holds = match holds {
        Ok(h) => h.into_inner(),
        Err(e) => return Err(api_error(e, HOLDS).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &holds)?;
    } else {
        let sessions = sessions.unwrap_or_default();
        let mut rows: Vec<_> = holds.0.iter().collect();
        rows.sort_by(|a, b| a.0.cmp(b.0));
        let mut t = output::table(&["SESSION", "HOLD", "PARAMS"]);
        for (id, reason) in rows {
            let params = reason
                .params
                .as_ref()
                .and_then(|p| serde_json::to_string(p).ok())
                .unwrap_or_else(|| "-".into());
            t.add_row(vec![label(&sessions, id), reason.code.0.clone(), params]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn git(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let (states, sessions) = tokio::join!(
        ctx.client.git_states().send(),
        list_sessions(&ctx.client, GIT)
    );
    let states = match states {
        Ok(s) => s.into_inner(),
        Err(e) => return Err(api_error(e, GIT).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &states)?;
    } else {
        let sessions = sessions.unwrap_or_default();
        let mut rows: Vec<_> = states.0.iter().collect();
        rows.sort_by(|a, b| a.0.cmp(b.0));
        let mut t = output::table(&[
            "SESSION",
            "PR",
            "STATE",
            "DRAFT",
            "CHECKS",
            "MERGEABLE",
            "TITLE",
        ]);
        for (id, g) in rows {
            t.add_row(vec![
                label(&sessions, id),
                or_dash(g.number.map(|n| format!("#{n}"))),
                g.state.0.clone(),
                or_dash(g.is_draft),
                g.checks.0.clone(),
                or_dash(g.mergeable),
                or_dash(g.title.as_ref()),
            ]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn reviews(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let (inflight, sessions) = tokio::join!(
        ctx.client.list_reviews_inflight().send(),
        list_sessions(&ctx.client, REVIEWS)
    );
    let inflight = match inflight {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, REVIEWS).await),
    };
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &inflight)?;
    } else {
        let sessions = sessions.unwrap_or_default();
        let mut t = output::table(&["SESSION", "PROVIDER", "MODEL", "EFFORT"]);
        for r in &inflight.0 {
            t.add_row(vec![
                label(&sessions, &r.id),
                or_dash(r.provider.as_ref().map(|p| p.0.clone())),
                or_dash(r.model.as_ref()),
                or_dash(r.effort.as_ref()),
            ]);
        }
        output::print_table(&mut ctx.io.stdout, &t)?;
    }
    check.finish(ctx.io).await;
    Ok(())
}
