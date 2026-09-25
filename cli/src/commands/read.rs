//! Read verbs: `sessions list|show`, `status`, `holds`, `git`, `reviews`.

use std::collections::BTreeMap;

use serde_json::json;

use super::{VersionCheck, label, list_sessions, warn_mismatch};
use crate::api::types::Session;
use crate::error::{Op, Result, Scope, api_error};
use crate::output::{self, Mode, ago, or_dash};
use crate::{CLI_VERSION, Ctx, resolve};

const LIST: Op = Op::new("sessions list", Scope::Read);
const SHOW: Op = Op::new("sessions show", Scope::Read);
/// `GET /api/sessions/{id}` is not in the read allowlist: only a session missing from the active
/// list (e.g. archived) needs it.
const SHOW_BY_ID: Op = Op::new("sessions show", Scope::Full);
const STATUS: Op = Op::new("status", Scope::Read);
const HOLDS: Op = Op::new("holds", Scope::Read);
const GIT: Op = Op::new("git", Scope::Read);
const REVIEWS: Op = Op::new("reviews", Scope::Read);

fn repo_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

pub async fn sessions_list(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let sessions = list_sessions(&ctx.client, LIST).await?;
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

fn print_session(ctx: &mut Ctx<'_>, s: &Session) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, s);
    }
    let mut t = output::table(&["FIELD", "VALUE"]);
    let rows: [(&str, String); 11] = [
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
    print_session(ctx, &session)?;
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
