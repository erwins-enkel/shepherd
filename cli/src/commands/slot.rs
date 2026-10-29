//! `shepherd slot run -- <command…>`: run a heavy check (tests, type checks, builds) through the
//! host-wide heavy-check slot (#3181, #3550).
//!
//! Same semantics as `scripts/heavy-slot.mjs`: ask the server for the slot BEFORE anything starts;
//!   - granted → run the command with `SHEPHERD_HEAVY_JOB=<job>` stamped on it (the server holds the
//!     slot while any process carrying it lives), report the exit, pass its exit code through;
//!   - queued → do NOT run it: print the server's message (place, estimate) and exit 75;
//!   - unmanaged → run it.
//!
//! Auth: inside a Shepherd session (`SHEPHERD_SESSION_ID`, `SHEPHERD_AGENT_API_URL` and
//! `SHEPHERD_INGRESS_HEADER_FILE` all set) the session's own ingress route is used, with the key
//! header from that file — the only credential a membrane session has. Outside a session the
//! operator token talks to `POST /api/heavy-slot/operator`, where a command that would have to
//! wait is answered `queued` but not queued: nobody can steer a terminal, so re-run to retry.
//!
//! Every failure FAILS OPEN: the command runs unmanaged with a one-line note.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::Ctx;
use crate::error::Result;

/// Exit code when the check was queued and did NOT run (sysexits EX_TEMPFAIL).
pub const EXIT_QUEUED: i32 = 75;
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);
const REPORT_TIMEOUT: Duration = Duration::from_secs(5);

/// Where and how the slot is asked.
struct Route {
    endpoint: String,
    /// The auth header: the session's ingress key header, or the operator's bearer token.
    header: Option<(String, String)>,
}

/// The session's ingress route, or None outside a session (or with an unreadable key file).
fn ingress_route(env: &HashMap<String, String>) -> Option<Route> {
    let base = env
        .get("SHEPHERD_AGENT_API_URL")
        .filter(|v| !v.is_empty())?;
    let id = env.get("SHEPHERD_SESSION_ID").filter(|v| !v.is_empty())?;
    let file = env
        .get("SHEPHERD_INGRESS_HEADER_FILE")
        .filter(|v| !v.is_empty())?;
    let line = std::fs::read_to_string(file).ok()?;
    let (name, value) = line.trim().split_once(':')?;
    if name.trim().is_empty() {
        return None;
    }
    Some(Route {
        endpoint: format!(
            "{}/api/sessions/{}/heavy-slot",
            base.trim_end_matches('/'),
            id
        ),
        header: Some((name.trim().to_string(), value.trim().to_string())),
    })
}

/// The command line: one argument is the shell string itself, several are quoted and joined.
fn command_line(args: &[String]) -> String {
    if let [one] = args {
        return one.clone();
    }
    args.iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

async fn post(
    http: &reqwest::Client,
    route: &Route,
    body: &Value,
    timeout: Duration,
) -> std::result::Result<Value, String> {
    let mut req = http.post(&route.endpoint).timeout(timeout).json(body);
    if let Some((name, value)) = &route.header {
        let mut v = reqwest::header::HeaderValue::from_str(value).map_err(|e| e.to_string())?;
        v.set_sensitive(true);
        req = req.header(name.as_str(), v);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// `shepherd slot run`. Returns the process exit code (the command's own, or 75 when queued).
pub async fn run(ctx: &mut Ctx<'_>, args: Vec<String>) -> Result<i32> {
    let command = command_line(&args);
    let http = reqwest::Client::builder()
        .user_agent(concat!("shepherd-cli/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .ok();
    let route = match ingress_route(&ctx.io.env) {
        Some(r) => Some(r),
        None => operator_route(ctx),
    };
    let (Some(http), Some(route)) = (http, route) else {
        return Ok(unmanaged(ctx, &command, "no way to reach the server").await);
    };

    let cwd = ctx.io.cwd.display().to_string();
    let answer = post(
        &http,
        &route,
        &json!({ "op": "acquire", "command": command, "cwd": cwd, "canWait": true }),
        ACQUIRE_TIMEOUT,
    )
    .await;
    let mut answer = match answer {
        Ok(a) => a,
        Err(e) => {
            return Ok(unmanaged(
                ctx,
                &command,
                &format!("heavy-check slot unavailable ({e})"),
            )
            .await);
        }
    };

    while answer.get("decision").and_then(Value::as_str) == Some("queued") {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let until = answer.get("waitUntil").and_then(Value::as_u64).unwrap_or(0) as u128;
        if until <= now {
            break;
        }
        tokio::time::sleep(Duration::from_millis((until - now).min(1000) as u64)).await;
        match post(
            &http,
            &route,
            &json!({ "op": "acquire", "command": command, "cwd": cwd, "canWait": true }),
            ACQUIRE_TIMEOUT,
        )
        .await
        {
            Ok(next) => answer = next,
            Err(_) => break, // Already queued: do not fail open and start a duplicate.
        }
    }

    let decision = answer.get("decision").and_then(Value::as_str);
    if decision == Some("queued")
        && let Some(message) = answer.get("message").and_then(Value::as_str)
    {
        ctx.io.warn(message);
        return Ok(EXIT_QUEUED);
    }
    let job = match (decision, answer.get("jobId").and_then(Value::as_str)) {
        (Some("run"), Some(job)) => job.to_string(),
        _ => return Ok(spawn(ctx, &command, None, None).await),
    };

    let report = Report {
        http: &http,
        route: &route,
        job: &job,
    };
    let code = spawn(ctx, &command, Some(&job), Some(&report)).await;
    let _ = post(
        &http,
        &route,
        &json!({ "op": "finished", "jobId": job, "exitCode": code }),
        REPORT_TIMEOUT,
    )
    .await;
    Ok(code)
}

/// The operator route: the profile token against `/api/heavy-slot/operator`. None when the stored
/// token must not be sent (a foreign loopback listener).
fn operator_route(ctx: &Ctx<'_>) -> Option<Route> {
    ctx.guard().ok()?;
    Some(Route {
        endpoint: format!(
            "{}/api/heavy-slot/operator",
            ctx.target.url.trim_end_matches('/')
        ),
        header: ctx
            .target
            .token
            .as_ref()
            .map(|t| ("authorization".to_string(), format!("Bearer {t}"))),
    })
}

struct Report<'a> {
    http: &'a reqwest::Client,
    route: &'a Route,
    job: &'a str,
}

async fn unmanaged(ctx: &mut Ctx<'_>, command: &str, why: &str) -> i32 {
    ctx.io
        .warn(&format!("Shepherd: {why}; running without the slot."));
    spawn(ctx, command, None, None).await
}

/// Run `command` through the shell with stdio passed straight through and the job stamped on it.
/// Signals the CLI receives are forwarded to the command. 128 + signal when it was killed.
#[cfg(unix)]
async fn spawn(
    ctx: &mut Ctx<'_>,
    command: &str,
    job: Option<&str>,
    report: Option<&Report<'_>>,
) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    use tokio::signal::unix::{SignalKind, signal};

    let shell = if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(command).current_dir(&ctx.io.cwd);
    if let Some(job) = job {
        cmd.env("SHEPHERD_HEAVY_JOB", job);
    }
    // macOS: the server watches the command's process group, so give it its own.
    let darwin = cfg!(target_os = "macos") && job.is_some();
    if darwin {
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            ctx.io.warn(&format!("error: cannot start {shell}: {e}"));
            return 127;
        }
    };
    let pid = child.id();
    if let (true, Some(pid), Some(r)) = (darwin, pid, report) {
        let _ = post(
            r.http,
            r.route,
            &json!({ "op": "started", "jobId": r.job, "pgid": pid }),
            REPORT_TIMEOUT,
        )
        .await;
    }
    let mut sigint = signal(SignalKind::interrupt()).ok();
    let mut sigterm = signal(SignalKind::terminate()).ok();
    let mut sighup = signal(SignalKind::hangup()).ok();
    let forward = |sig: i32| {
        if let Some(pid) = pid {
            let target = if darwin { -(pid as i32) } else { pid as i32 };
            // SAFETY: plain kill(2) on a child this process spawned.
            unsafe { libc::kill(target, sig) };
        }
    };
    let status = loop {
        tokio::select! {
            s = child.wait() => break s,
            _ = recv(&mut sigint) => forward(libc::SIGINT),
            _ = recv(&mut sigterm) => forward(libc::SIGTERM),
            _ = recv(&mut sighup) => forward(libc::SIGHUP),
        }
    };
    match status {
        Ok(s) => s
            .code()
            .or_else(|| s.signal().map(|n| 128 + n))
            .unwrap_or(1),
        Err(_) => 1,
    }
}

#[cfg(unix)]
async fn recv(s: &mut Option<tokio::signal::unix::Signal>) {
    match s {
        Some(s) => {
            s.recv().await;
        }
        None => std::future::pending().await,
    }
}

#[cfg(not(unix))]
async fn spawn(
    ctx: &mut Ctx<'_>,
    _command: &str,
    _job: Option<&str>,
    _report: Option<&Report<'_>>,
) -> i32 {
    ctx.io.warn("error: `shepherd slot run` needs a Unix shell");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_argument_is_the_shell_string_several_are_quoted() {
        assert_eq!(command_line(&["cargo clippy -q".into()]), "cargo clippy -q");
        assert_eq!(
            command_line(&["cargo".into(), "test".into(), "a b".into(), "it's".into()]),
            "cargo test 'a b' 'it'\\''s'"
        );
    }

    #[test]
    fn ingress_route_needs_all_three_variables_and_a_parsable_header() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("h");
        std::fs::write(&file, "X-Shepherd-Agent-Key: k1\n").unwrap();
        let mut env = HashMap::new();
        env.insert("SHEPHERD_AGENT_API_URL".into(), "http://h:1/".into());
        env.insert("SHEPHERD_SESSION_ID".into(), "s1".into());
        assert!(ingress_route(&env).is_none());
        env.insert(
            "SHEPHERD_INGRESS_HEADER_FILE".into(),
            file.display().to_string(),
        );
        let r = ingress_route(&env).unwrap();
        assert_eq!(r.endpoint, "http://h:1/api/sessions/s1/heavy-slot");
        assert_eq!(r.header, Some(("X-Shepherd-Agent-Key".into(), "k1".into())));
        std::fs::write(&file, "garbage").unwrap();
        assert!(ingress_route(&env).is_none());
    }
}
