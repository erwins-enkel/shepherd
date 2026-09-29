//! `shepherd wait`: block until a session reaches one of the requested states, print one line
//! naming it, and exit with that state's code.
//!
//! Level-triggered: a state that already holds returns at once. The state is derived from what a
//! `read` token can see (`GET /api/sessions`, `/api/holds`, `/api/git`), and those are re-read
//! each time `/events` reports a change to the session, so nothing polls on a timer. The socket
//! opens BEFORE the first read, so a change landing between the read and the subscription still
//! triggers a re-read. A reconnect re-reads for the same reason.

use std::time::{Duration, Instant};

use clap::ValueEnum;
use futures::{FutureExt, StreamExt};
use serde_json::{Value, json};

use super::events::{MAX_BACKOFF, STABLE_CONNECTION, Socket, connect, events_url, parse};
use super::{VersionCheck, list_sessions};
use crate::Ctx;
use crate::api::types::{GitState, HoldReason, Session};
use crate::cli::{WaitArgs, WaitState};
use crate::error::{CliError, Exit, Op, Result, Scope, api_error};
use crate::output::{self, Mode};
use crate::resolve;

const WAIT: Op = Op::new("wait", Scope::Read);
/// `GET /api/sessions/{id}` is not in the read allowlist: only a session missing from the active
/// list (e.g. archived) needs it.
const WAIT_BY_ID: Op = Op::new("wait", Scope::Full);
/// `GET /api/plan-gates` is `full`-only; a `read` token learns the gate from `/events` instead.
const PLAN_GATES: Op = Op::new("wait", Scope::Full);

/// When several requested states hold at once, the first of these is reported.
const PRECEDENCE: [WaitState; 5] = [
    WaitState::Done,
    WaitState::Halted,
    WaitState::NeedsInput,
    WaitState::PlanReady,
    WaitState::Pr,
];

/// Hold codes (src/hold.ts) meaning the agent or its plan gate waits on an answer. A stall, a
/// quota, red CI or a merge hand-off may need the operator too, but nobody asked a question.
const INPUT_HOLDS: [&str; 7] = [
    "autopilot-paused",
    "blocked-menu",
    "blocked-yes-no",
    "blocked-awaiting-input",
    "blocked-generic",
    "plan-question",
    "plan-rework",
];

/// Frames that can move one of the inputs the states derive from.
const RECHECK: [&str; 7] = [
    "session:status",
    "session:hold",
    "session:halt",
    "session:autopilot",
    "session:plangate",
    "session:git",
    "session:archived",
];

/// The session as last read.
struct View {
    session: Session,
    /// Gone from the active list, or read back with `archivedAt` set.
    archived: bool,
    hold: Option<HoldReason>,
    git: Option<GitState>,
    gate_approved: bool,
}

impl View {
    fn pr_state(&self) -> Option<&str> {
        self.git.as_ref().map(|g| g.state.0.as_str())
    }

    fn holds(&self, state: WaitState) -> bool {
        let s = &self.session;
        match state {
            WaitState::Done => {
                self.archived || self.pr_state() == Some("merged") || s.autopilot_complete
            }
            WaitState::Halted => s.halt_reason.is_some(),
            WaitState::NeedsInput => {
                s.autopilot_paused
                    || self
                        .hold
                        .as_ref()
                        .is_some_and(|h| INPUT_HOLDS.contains(&h.code.0.as_str()))
            }
            WaitState::PlanReady => {
                s.plan_phase.as_deref() == Some("planning") && self.gate_approved
            }
            WaitState::Pr => matches!(self.pr_state(), Some("open" | "merged")),
        }
    }

    /// The first requested state that holds, by `PRECEDENCE`.
    fn reached(&self, wanted: &[WaitState]) -> Option<WaitState> {
        PRECEDENCE
            .into_iter()
            .find(|s| wanted.contains(s) && self.holds(*s))
    }

    fn question(&self) -> Option<&str> {
        self.hold
            .as_ref()
            .and_then(|h| h.params.as_ref()?.question.as_deref())
            .or(self.session.autopilot_question.as_deref())
    }

    fn done_reason(&self) -> &'static str {
        if self.pr_state() == Some("merged") {
            "merged"
        } else if self.archived {
            "archived"
        } else {
            "complete"
        }
    }
}

fn state_name(state: WaitState) -> String {
    state
        .to_possible_value()
        .map(|v| v.get_name().to_string())
        .unwrap_or_default()
}

fn exit_for(state: WaitState) -> Exit {
    match state {
        WaitState::NeedsInput => Exit::NeedsInput,
        WaitState::PlanReady => Exit::PlanReady,
        WaitState::Pr => Exit::Pr,
        WaitState::Done => Exit::Done,
        WaitState::Halted => Exit::Halted,
    }
}

/// The one result line: the state (or `timeout`), the session, and what the state is about.
fn outcome(view: Option<&View>, state: Option<WaitState>) -> Value {
    let name = state.map_or_else(|| "timeout".to_string(), state_name);
    let Some(v) = view else {
        return json!({ "state": name, "session": null, "desig": null, "status": null });
    };
    let s = &v.session;
    let status = if v.archived {
        "archived"
    } else {
        s.status.0.as_str()
    };
    let mut out = json!({ "state": name, "session": s.id, "desig": s.desig, "status": status });
    if let Some(g) = v.git.as_ref().filter(|g| g.number.is_some()) {
        out["pr"] = json!({ "number": g.number, "url": g.url, "state": g.state.0 });
    }
    match state {
        Some(WaitState::NeedsInput) => {
            out["hold"] = json!(v.hold.as_ref().map(|h| h.code.0.as_str()));
            out["question"] = json!(v.question());
        }
        Some(WaitState::Halted) => out["haltReason"] = json!(s.halt_reason),
        Some(WaitState::Done) => {
            out["reason"] = json!(v.done_reason());
            if v.done_reason() == "complete" {
                out["summary"] = json!(s.autopilot_question);
            }
        }
        _ => {}
    }
    out
}

/// The same line for a terminal.
fn human(line: &Value) -> String {
    let text = |k: &str| line.get(k).and_then(Value::as_str);
    let who = text("desig").unwrap_or("session");
    let state = text("state").unwrap_or_default();
    let pr = line.get("pr").map(|pr| {
        let number = pr.get("number").and_then(Value::as_i64).unwrap_or_default();
        match pr.get("url").and_then(Value::as_str) {
            Some(url) => format!("PR #{number} {url}"),
            None => format!("PR #{number}"),
        }
    });
    let detail = match state {
        "timeout" => text("status").map(|s| format!("timed out ({s})")),
        "needs-input" => Some(match text("question") {
            Some(q) => format!("needs input: {q}"),
            None => format!("needs input ({})", text("hold").unwrap_or("paused")),
        }),
        "halted" => text("haltReason").map(|r| format!("halted ({r})")),
        "done" => text("reason").map(|r| format!("done ({r})")),
        "pr" => pr.clone(),
        _ => None,
    };
    let mut out = format!("{who}: {}", detail.unwrap_or_else(|| state.to_string()));
    if let Some(pr) = pr.filter(|_| state != "pr") {
        out.push_str(&format!(" · {pr}"));
    }
    out
}

struct Watch {
    key: String,
    /// Resolved on the first read, so frames can be matched by id.
    id: Option<String>,
    gate_approved: bool,
    /// Set after `GET /api/plan-gates` answered 403: rely on `/events` alone from then on.
    gates_forbidden: bool,
    last: Option<View>,
}

impl Watch {
    async fn read(&mut self, ctx: &mut Ctx<'_>, wanted: &[WaitState]) -> Result<View> {
        let (sessions, holds, git) = tokio::join!(
            list_sessions(&ctx.client, WAIT),
            ctx.client.get_holds().send(),
            ctx.client.git_states().send(),
        );
        let sessions = sessions?;
        let mut holds = match holds {
            Ok(h) => h.into_inner().0,
            Err(e) => return Err(api_error(e, WAIT).await),
        };
        let mut git = match git {
            Ok(g) => g.into_inner().0,
            Err(e) => return Err(api_error(e, WAIT).await),
        };
        let key = self.id.as_deref().unwrap_or(&self.key);
        let (session, archived) = match resolve::find(&sessions, key) {
            Some(s) => (s.clone(), false),
            None => match &self.last {
                Some(v) => (v.session.clone(), true),
                None => match ctx.client.get_session().id(key.trim()).send().await {
                    Ok(s) => {
                        let s = s.into_inner();
                        let archived = s.archived_at.is_some();
                        (s, archived)
                    }
                    Err(e) => {
                        let e = api_error(e, WAIT_BY_ID).await;
                        if e.exit != Exit::InsufficientScope {
                            return Err(e);
                        }
                        return Err(CliError::new(
                            e.exit,
                            format!(
                                "no active session matches {key:?}, and looking among archived \
                                 sessions needs a 'full' token. Mint one in Settings → Access."
                            ),
                        ));
                    }
                },
            },
        };
        self.id = Some(session.id.clone());
        let planning = session.plan_phase.as_deref() == Some("planning");
        if planning && !archived && !self.gates_forbidden && wanted.contains(&WaitState::PlanReady)
        {
            match ctx.client.list_plan_gates().send().await {
                Ok(gates) => {
                    self.gate_approved = gates.get(&session.id).is_some_and(|g| g.approved);
                }
                Err(e) => {
                    let e = api_error(e, PLAN_GATES).await;
                    if e.exit != Exit::InsufficientScope {
                        return Err(e);
                    }
                    self.gates_forbidden = true;
                    ctx.io.warn(
                        "warning: this token cannot read plan gates, so an already-approved plan \
                         is noticed only when its gate next changes",
                    );
                }
            }
        }
        // A merge lands as a merged PR, then the archive; both may arrive in one burst, after
        // which `/api/git` no longer lists the session. Keep the PR it was last seen with.
        let git = git
            .remove(&session.id)
            .or_else(|| self.last.as_ref().filter(|_| archived)?.git.clone());
        Ok(View {
            hold: holds.remove(&session.id),
            git,
            gate_approved: self.gate_approved,
            session,
            archived,
        })
    }

    /// Records what a frame carries and says whether it calls for a re-read.
    fn note(&mut self, frame: &Value) -> bool {
        if self.id.is_none()
            || frame.pointer("/data/id").and_then(Value::as_str) != self.id.as_deref()
        {
            return false;
        }
        let event = frame.get("event").and_then(Value::as_str).unwrap_or("");
        if event == "session:plangate"
            && let Some(approved) = frame
                .pointer("/data/gate/approved")
                .and_then(Value::as_bool)
        {
            self.gate_approved = approved;
        }
        RECHECK.contains(&event)
    }

    /// Reads, then re-reads on every relevant frame, until a wanted state holds (`Some`) or the
    /// socket drops (`None`).
    async fn watch(
        &mut self,
        ctx: &mut Ctx<'_>,
        socket: &mut Socket,
        wanted: &[WaitState],
    ) -> Result<Option<WaitState>> {
        loop {
            let view = self.read(ctx, wanted).await?;
            let reached = view.reached(wanted);
            self.last = Some(view);
            if reached.is_some() {
                return Ok(reached);
            }
            loop {
                match socket.next().await {
                    Some(Ok(m)) => {
                        if parse(m).is_some_and(|f| self.note(&f)) {
                            break;
                        }
                    }
                    Some(Err(_)) | None => return Ok(None),
                }
            }
            // A burst of frames (status, hold, git …) is covered by one re-read.
            while let Some(Some(Ok(m))) = socket.next().now_or_never() {
                if let Some(f) = parse(m) {
                    self.note(&f);
                }
            }
        }
    }

    async fn run(&mut self, ctx: &mut Ctx<'_>, wanted: &[WaitState]) -> Result<WaitState> {
        let url = events_url(&ctx.target.url)?;
        let token = ctx.target.token.clone();
        let mut first = true;
        let mut backoff = Duration::from_secs(1);
        loop {
            match connect(&url, token.as_deref(), WAIT).await {
                Ok(mut socket) => {
                    let connected = Instant::now();
                    match self.watch(ctx, &mut socket, wanted).await {
                        Ok(Some(state)) => return Ok(state),
                        Ok(None) => {
                            if connected.elapsed() >= STABLE_CONNECTION {
                                backoff = Duration::from_secs(1);
                            }
                            ctx.io.warn(&format!(
                                "event stream disconnected; reconnecting in {}s",
                                backoff.as_secs()
                            ));
                        }
                        Err(e) if first => return Err(e),
                        Err(e) => ctx.io.warn(&format!("read failed: {e}; reconnecting")),
                    }
                }
                Err(e) if first => return Err(e),
                Err(e) => ctx
                    .io
                    .warn(&format!("{e}; retrying in {}s", backoff.as_secs())),
            }
            first = false;
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

pub async fn wait(ctx: &mut Ctx<'_>, args: WaitArgs) -> Result<Exit> {
    let wanted = if args.until.is_empty() {
        WaitState::value_variants().to_vec()
    } else {
        args.until
    };
    let check = VersionCheck::start(&ctx.client);
    let mut watch = Watch {
        key: args.session,
        id: None,
        gate_approved: false,
        gates_forbidden: false,
        last: None,
    };
    let reached = match args.timeout {
        Some(limit) => tokio::time::timeout(limit, watch.run(ctx, &wanted))
            .await
            .ok(),
        None => Some(watch.run(ctx, &wanted).await),
    }
    .transpose()?;
    let line = outcome(watch.last.as_ref(), reached);
    if ctx.mode == Mode::Json {
        output::json(&mut ctx.io.stdout, &line)?;
    } else {
        output::line(&mut ctx.io.stdout, &human(&line))?;
    }
    check.finish(ctx.io).await;
    Ok(reached.map_or(Exit::TimedOut, exit_for))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::session_json;

    fn view(patch: Value) -> View {
        let mut s = session_json("id-1", "TASK-01");
        for (k, v) in patch.as_object().unwrap() {
            s[k] = v.clone();
        }
        View {
            session: serde_json::from_value(s).unwrap(),
            archived: false,
            hold: None,
            git: None,
            gate_approved: false,
        }
    }

    fn git(state: &str) -> GitState {
        serde_json::from_value(json!({
            "state": state, "checks": "success", "deployConfigured": false,
            "number": 12, "url": "https://forge/pr/12"
        }))
        .unwrap()
    }

    fn hold(code: &str, question: Option<&str>) -> HoldReason {
        serde_json::from_value(json!({"code": code, "params": {"question": question}})).unwrap()
    }

    const ALL: [WaitState; 5] = PRECEDENCE;

    #[test]
    fn running_session_reaches_nothing() {
        assert_eq!(view(json!({})).reached(&ALL), None);
    }

    #[test]
    fn needs_input_from_input_holds_and_autopilot_pause() {
        let mut v = view(json!({}));
        v.hold = Some(hold("blocked-menu", None));
        assert_eq!(v.reached(&ALL), Some(WaitState::NeedsInput));
        v.hold = Some(hold("blocked-stall", None));
        assert_eq!(v.reached(&ALL), None, "a stall asks no question");
        v.hold = Some(hold("ci-red", None));
        assert_eq!(v.reached(&ALL), None);
        let mut v = view(json!({"autopilotPaused": true, "autopilotQuestion": "Push?"}));
        assert_eq!(v.reached(&ALL), Some(WaitState::NeedsInput));
        assert_eq!(v.question(), Some("Push?"));
        v.hold = Some(hold("autopilot-paused", Some("Open the PR?")));
        assert_eq!(v.question(), Some("Open the PR?"));
    }

    #[test]
    fn pr_counts_open_and_merged_but_not_closed() {
        let mut v = view(json!({}));
        v.git = Some(git("open"));
        assert_eq!(v.reached(&ALL), Some(WaitState::Pr));
        v.git = Some(git("closed"));
        assert_eq!(v.reached(&ALL), None);
        v.git = Some(git("merged"));
        assert_eq!(v.reached(&ALL), Some(WaitState::Done), "done outranks pr");
        assert_eq!(v.reached(&[WaitState::Pr]), Some(WaitState::Pr));
        assert_eq!(v.done_reason(), "merged");
    }

    #[test]
    fn plan_ready_needs_planning_and_an_approved_gate() {
        let mut v = view(json!({"planPhase": "planning"}));
        assert_eq!(v.reached(&ALL), None);
        v.gate_approved = true;
        assert_eq!(v.reached(&ALL), Some(WaitState::PlanReady));
        let mut v = view(json!({"planPhase": "executing"}));
        v.gate_approved = true;
        assert_eq!(v.reached(&ALL), None);
    }

    #[test]
    fn only_requested_states_count_in_precedence_order() {
        let mut v = view(json!({"haltReason": "usage_limit"}));
        v.git = Some(git("open"));
        v.hold = Some(hold("blocked-generic", None));
        assert_eq!(v.reached(&ALL), Some(WaitState::Halted));
        assert_eq!(
            v.reached(&[WaitState::Pr, WaitState::NeedsInput]),
            Some(WaitState::NeedsInput)
        );
        assert_eq!(v.reached(&[WaitState::Pr]), Some(WaitState::Pr));
        assert_eq!(v.reached(&[WaitState::Done]), None);
        v.archived = true;
        assert_eq!(v.reached(&ALL), Some(WaitState::Done));
        assert_eq!(v.done_reason(), "archived");
    }

    #[test]
    fn outcome_lines() {
        let mut v = view(json!({"autopilotPaused": true, "autopilotQuestion": "Push?"}));
        v.git = Some(git("open"));
        let line = outcome(Some(&v), Some(WaitState::NeedsInput));
        assert_eq!(
            line,
            json!({
                "state": "needs-input", "session": "id-1", "desig": "TASK-01",
                "status": "running", "hold": null, "question": "Push?",
                "pr": {"number": 12, "url": "https://forge/pr/12", "state": "open"}
            })
        );
        assert_eq!(
            human(&line),
            "TASK-01: needs input: Push? · PR #12 https://forge/pr/12"
        );
        let done = view(json!({"autopilotComplete": true, "autopilotQuestion": "Filed #9"}));
        let line = outcome(Some(&done), Some(WaitState::Done));
        assert_eq!(line["reason"], "complete");
        assert_eq!(line["summary"], "Filed #9");
        let line = outcome(Some(&view(json!({}))), None);
        assert_eq!(line["state"], "timeout");
        assert_eq!(human(&line), "TASK-01: timed out (running)");
        assert_eq!(outcome(None, None)["session"], Value::Null);
    }

    #[test]
    fn frames_trigger_rereads_only_for_this_session() {
        let mut w = Watch {
            key: "TASK-01".into(),
            id: Some("id-1".into()),
            gate_approved: false,
            gates_forbidden: true,
            last: None,
        };
        assert!(w.note(&json!({"event": "session:hold", "data": {"id": "id-1"}})));
        assert!(!w.note(&json!({"event": "session:hold", "data": {"id": "id-2"}})));
        assert!(!w.note(&json!({"event": "session:activity", "data": {"id": "id-1"}})));
        let gate = json!({"event": "session:plangate", "data": {"id": "id-1", "gate": {"approved": true}}});
        assert!(w.note(&gate));
        assert!(w.gate_approved);
        let phase =
            json!({"event": "session:plangate", "data": {"id": "id-1", "planPhase": "executing"}});
        assert!(w.note(&phase));
        assert!(w.gate_approved, "a phase flip carries no gate");
    }

    #[test]
    fn exit_codes_per_state() {
        let codes = ALL.map(|s| exit_for(s).code());
        assert_eq!(codes, [13, 14, 10, 11, 12]);
    }
}
