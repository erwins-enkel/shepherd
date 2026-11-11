//! Operator schedules (#3469): `schedule ls|add|run`.

use serde_json::{Map, Value};

use super::{VersionCheck, print_done, repo_path};
use crate::Ctx;
use crate::api::Client;
use crate::api::types::{CreateScheduleBody, ScheduleList, ScheduleRun};
use crate::cli::{ScheduleAddArgs, ScheduleCmd, WEEKDAYS};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode};
use crate::resolve;

const SCHEDULE_LIST: Op = Op::new("schedule ls", Scope::Full);
const SCHEDULE_ADD: Op = Op::new("schedule add", Scope::Full);
const SCHEDULE_RUN: Op = Op::new("schedule run", Scope::Full);

pub async fn run(ctx: &mut Ctx<'_>, cmd: ScheduleCmd) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let result = match cmd {
        ScheduleCmd::List { repo } => list(ctx, repo).await,
        ScheduleCmd::Add(args) => add(ctx, args).await,
        ScheduleCmd::Run { schedule, repo } => run_now(ctx, &schedule, repo).await,
    };
    check.finish(ctx.io).await;
    result
}

async fn fetch(client: &Client, repo: Option<String>, op: Op) -> Result<ScheduleList> {
    let mut req = client.list_schedules();
    if let Some(repo) = repo {
        req = req.repo(repo);
    }
    match req.send().await {
        Ok(l) => Ok(l.into_inner()),
        Err(e) => Err(api_error(e, op).await),
    }
}

async fn list(ctx: &mut Ctx<'_>, repo: Option<String>) -> Result<()> {
    let listing = fetch(&ctx.client, repo, SCHEDULE_LIST).await?;
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, &listing);
    }
    let mut t = output::table(&["ID", "NAME", "REPO", "DAYS", "TIMES", "ON", "NEXT", "LAST"]);
    for s in &listing.schedules {
        output::add_row(
            &mut t,
            [
                s.id.clone(),
                s.name.clone(),
                s.repo_path.clone(),
                days_label(s.days),
                match &s.interval {
                    Some(interval) => format!(
                        "every {}m {}",
                        *interval.every_minutes,
                        match (&interval.from, &interval.until) {
                            (Some(from), Some(until)) => format!("{}-{}", **from, **until),
                            _ => "all day".into(),
                        }
                    ),
                    None => s.times.join(","),
                },
                if s.enabled { "yes" } else { "no" }.into(),
                output::or_dash(s.next_at.map(output::until)),
                output::or_dash(s.last_run.as_ref().map(|r| {
                    let tokens = r
                        .tokens_used
                        .map(|n| format!(" ({n} tokens)"))
                        .unwrap_or_default();
                    format!("{}{tokens} {}", r.outcome, output::ago(r.at))
                })),
            ],
        );
    }
    output::print_table(&mut ctx.io.stdout, &t)
}

/// `daily`, `weekdays`, `weekends`, else the days in order: `mon,wed,fri`.
pub fn days_label(mask: i64) -> String {
    match mask {
        0b1111111 => "daily".into(),
        0b0011111 => "weekdays".into(),
        0b1100000 => "weekends".into(),
        _ => WEEKDAYS
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, d)| *d)
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// Only the launch options given; the server fills the rest with its defaults.
fn launch(args: &ScheduleAddArgs) -> Map<String, Value> {
    let mut m = Map::new();
    if let Some(p) = args.provider {
        m.insert("agentProvider".into(), p.to_string().into());
    }
    if let Some(model) = &args.model {
        m.insert("model".into(), model.clone().into());
    }
    if let Some(effort) = args.effort {
        m.insert("effort".into(), effort.to_string().into());
    }
    if args.autopilot {
        m.insert("autopilotEnabled".into(), true.into());
    }
    if args.plan_gate {
        m.insert("planGateEnabled".into(), true.into());
    }
    if let Some(base) = &args.base {
        m.insert("baseBranch".into(), base.clone().into());
    }
    m
}

async fn add(ctx: &mut Ctx<'_>, args: ScheduleAddArgs) -> Result<()> {
    let repo = repo_path(ctx, args.repo.clone())?;
    let prompt = ctx.io.text_arg(&args.prompt)?;
    let body = CreateScheduleBody {
        repo_path: repo,
        name: args.name.clone(),
        prompt,
        days: args.days,
        times: args.times.clone(),
        interval: None,
        usage_limit: None,
        token_budget: None,
        enabled: Some(!args.disabled),
        launch: launch(&args),
    };
    let s = match ctx.client.create_schedule().body(body).send().await {
        Ok(s) => s.into_inner(),
        Err(e) => return Err(api_error(e, SCHEDULE_ADD).await),
    };
    let next = output::or_dash(s.next_at.map(output::until));
    let text = format!("schedule \"{}\" created ({}), next {next}", s.name, s.id);
    print_done(ctx, &s, &text)
}

/// A UUID is used verbatim; anything else must be exactly one schedule's name.
async fn schedule_id(client: &Client, key: &str, repo: Option<String>) -> Result<String> {
    if resolve::looks_like_id(key) {
        return Ok(key.trim().to_string());
    }
    let listing = fetch(client, repo, SCHEDULE_RUN).await?;
    let matches: Vec<_> = listing.schedules.iter().filter(|s| s.name == key).collect();
    match matches.as_slice() {
        [s] => Ok(s.id.clone()),
        [] => Err(CliError::new(
            Exit::NotFound,
            format!("no schedule named \"{key}\""),
        )),
        many => Err(CliError::new(
            Exit::Usage,
            format!(
                "{} schedules are named \"{key}\"; pass the id (`shepherd schedule ls`) or --repo",
                many.len()
            ),
        )),
    }
}

async fn run_now(ctx: &mut Ctx<'_>, key: &str, repo: Option<String>) -> Result<()> {
    let id = schedule_id(&ctx.client, key, repo).await?;
    let run = match ctx.client.run_schedule_now().id(&id).send().await {
        Ok(r) => r.into_inner(),
        Err(e) => return Err(api_error(e, SCHEDULE_RUN).await),
    };
    print_done(ctx, &run, &run_text(key, &run))?;
    outcome_exit(key, &run)
}

fn run_text(key: &str, run: &ScheduleRun) -> String {
    let mut text = format!("schedule {key}: {}", run.outcome);
    if let Some(session) = &run.session_id {
        text.push_str(&format!(", session {session}"));
    }
    if let Some(reason) = &run.reason {
        text.push_str(&format!(" ({reason})"));
    }
    text
}

/// Launched, held or waiting is success; a skip is the server refusing; anything else failed.
fn outcome_exit(key: &str, run: &ScheduleRun) -> Result<()> {
    let reason = run.reason.as_deref().unwrap_or("no reason given");
    match run.outcome.as_str() {
        "spawned" | "spawned:failover" | "held" | "waiting:limit" | "paused" => Ok(()),
        o if o.starts_with("skipped") => Err(CliError::new(
            Exit::Refused,
            format!("schedule {key} did not run: {o} ({reason})"),
        )),
        o => Err(CliError::new(
            Exit::Failure,
            format!("schedule {key} failed: {o} ({reason})"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_limit_skip_is_refused() {
        let run: ScheduleRun = serde_json::from_value(serde_json::json!({
            "id": 1, "scheduleId": "s", "slotKey": "slot", "outcome": "skipped:limit",
            "sessionId": null, "reason": "below-start", "at": 1,
            "usage": { "provider": "claude", "window": "week", "usedPct": 79, "thresholdPct": 80 }
        }))
        .unwrap();
        assert_eq!(outcome_exit("test", &run).unwrap_err().exit, Exit::Refused);
    }

    #[test]
    fn schedule_outcome_exit_classes() {
        for (outcome, expected) in [
            ("spawned", None),
            ("held", None),
            ("spawned:failover", None),
            ("waiting:limit", None),
            ("paused", None),
            ("skipped:limit", Some(Exit::Refused)),
            ("skipped:limit-expired", Some(Exit::Refused)),
            ("skipped:overlap", Some(Exit::Refused)),
            ("skipped:stale", Some(Exit::Refused)),
            ("error", Some(Exit::Failure)),
            ("claimed", Some(Exit::Failure)),
        ] {
            let run: ScheduleRun = serde_json::from_value(serde_json::json!({
                "id": 1, "scheduleId": "s", "slotKey": "slot", "outcome": outcome,
                "sessionId": null, "reason": null, "at": 1, "usage": null
            }))
            .unwrap();
            assert_eq!(outcome_exit("test", &run).err().map(|e| e.exit), expected);
        }
    }

    #[test]
    fn day_labels() {
        assert_eq!(days_label(127), "daily");
        assert_eq!(days_label(31), "weekdays");
        assert_eq!(days_label(96), "weekends");
        assert_eq!(days_label(21), "mon,wed,fri");
        assert_eq!(days_label(65), "mon,sun");
    }
}
