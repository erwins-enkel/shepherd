mod common;

use common::Harness;
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const OPERATOR: &str = "/api/heavy-slot/operator";

async fn answer(s: &MockServer, route: &str, op: &str, status: u16, body: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path(route))
        .and(body_partial_json(json!({ "op": op })))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(s)
        .await;
}

#[tokio::test]
async fn operator_run_stamps_the_job_passes_the_exit_code_and_reports_it() {
    let s = MockServer::start().await;
    answer(
        &s,
        OPERATOR,
        "acquire",
        200,
        json!({ "decision": "run", "jobId": "j1" }),
    )
    .await;
    Mock::given(method("POST"))
        .and(path(OPERATOR))
        .and(header("authorization", "Bearer shp_test"))
        .and(body_partial_json(
            json!({ "op": "finished", "jobId": "j1", "exitCode": 3 }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "slot",
            "run",
            "--",
            "test \"$SHEPHERD_HEAVY_JOB\" = j1 && exit 3; exit 9",
        ])
        .await;
    // 3 comes back only when the job is stamped on the command (9 otherwise).
    assert_eq!(code, 3, "stderr: {}", h.err.text());
}

#[tokio::test]
async fn queued_prints_the_message_and_exits_75_without_running() {
    let s = MockServer::start().await;
    answer(
        &s,
        OPERATOR,
        "acquire",
        200,
        json!({ "decision": "queued", "jobId": "j2", "message": "NOT RUN: place 1 of 1" }),
    )
    .await;
    let marker = tempfile::tempdir().unwrap().keep().join("ran");
    let h = Harness::new();
    let cmd = format!("touch {}", marker.display());
    let code = h.run(&["--url", &s.uri(), "slot", "run", "--", &cmd]).await;
    assert_eq!(code, 75);
    assert!(h.err.text().contains("NOT RUN: place 1 of 1"));
    assert!(!marker.exists());
}

#[tokio::test]
async fn a_session_uses_its_ingress_route_and_key_header() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/s1/heavy-slot"))
        .and(header("x-shepherd-agent-key", "k1"))
        .and(body_partial_json(
            json!({ "op": "acquire", "command": "echo hi" }),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "decision": "run" , "unmanaged": true })),
        )
        .expect(1)
        .mount(&s)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("header");
    std::fs::write(&file, "X-Shepherd-Agent-Key: k1\n").unwrap();
    let mut h = Harness::new();
    h.env.insert("SHEPHERD_SESSION_ID".into(), "s1".into());
    h.env.insert("SHEPHERD_AGENT_API_URL".into(), s.uri());
    h.env.insert(
        "SHEPHERD_INGRESS_HEADER_FILE".into(),
        file.display().to_string(),
    );
    // --url points elsewhere: the session route must win, and no operator call may be made.
    let code = h
        .run(&[
            "--url",
            "http://127.0.0.1:1",
            "slot",
            "run",
            "--",
            "echo",
            "hi",
        ])
        .await;
    assert_eq!(code, 0, "stderr: {}", h.err.text());
}

#[tokio::test]
async fn a_failing_server_fails_open_and_runs_the_command() {
    let s = MockServer::start().await;
    answer(
        &s,
        OPERATOR,
        "acquire",
        503,
        json!({ "error": "unavailable" }),
    )
    .await;
    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "slot", "run", "--", "exit 4"])
        .await;
    assert_eq!(code, 4);
    assert!(h.err.text().contains("running without the slot"));
}

#[tokio::test]
async fn a_missing_command_is_a_usage_error() {
    let h = Harness::new();
    assert_eq!(h.run(&["slot", "run"]).await, 2);
}

#[tokio::test]
async fn bounded_wait_claims_the_slot_before_running() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    let s = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let until = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 5000;
    Mock::given(method("POST"))
        .and(path(OPERATOR))
        .and(body_partial_json(json!({ "op": "acquire", "canWait": true })))
        .respond_with(move |_: &wiremock::Request| {
            let body = if count.fetch_add(1, Ordering::SeqCst) == 0 {
                json!({ "decision": "queued", "jobId": "j2", "message": "NOT RUN", "waitUntil": until as u64 })
            } else { json!({ "decision": "run", "jobId": "j2" }) };
            ResponseTemplate::new(200).set_body_json(body)
        }).mount(&s).await;
    answer(&s, OPERATOR, "finished", 200, json!({ "ok": true })).await;
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "slot",
            "run",
            "--",
            "test \"$SHEPHERD_HEAVY_JOB\" = j2",
        ])
        .await;
    assert_eq!(code, 0, "stderr: {}", h.err.text());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

/// A server that grants with `scope: true` (#3784); records whether the command had already run
/// when the bind arrived, answers the bind with `bind_status`, and `finished` with `finished`.
#[cfg(target_os = "linux")]
async fn scoped_server(
    ran: std::path::PathBuf,
    bind_status: u16,
    finished: serde_json::Value,
) -> (MockServer, std::sync::Arc<std::sync::Mutex<Option<bool>>>) {
    use std::sync::{Arc, Mutex};
    let s = MockServer::start().await;
    answer(
        &s,
        OPERATOR,
        "acquire",
        200,
        json!({ "decision": "run", "jobId": "g1", "scope": true }),
    )
    .await;
    let ran_at_bind = Arc::new(Mutex::new(None));
    let seen = ran_at_bind.clone();
    Mock::given(method("POST"))
        .and(path(OPERATOR))
        .and(body_partial_json(json!({ "op": "bind", "jobId": "g1" })))
        .respond_with(move |_: &wiremock::Request| {
            *seen.lock().unwrap() = Some(ran.exists());
            ResponseTemplate::new(bind_status).set_body_json(json!({ "ok": true, "scoped": true }))
        })
        .expect(1)
        .mount(&s)
        .await;
    answer(&s, OPERATOR, "finished", 200, finished).await;
    (s, ran_at_bind)
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_scoped_run_execs_only_after_the_bind_answered() {
    let dir = tempfile::tempdir().unwrap();
    let ran = dir.path().join("ran");
    let (s, ran_at_bind) = scoped_server(ran.clone(), 200, json!({ "ok": true })).await;
    let h = Harness::new();
    let cmd = format!(
        "test \"$SHEPHERD_HEAVY_JOB\" = g1 && touch '{}' && exit 7; exit 9",
        ran.display()
    );
    let code = h.run(&["--url", &s.uri(), "slot", "run", "--", &cmd]).await;
    assert_eq!(code, 7, "stderr: {}", h.err.text());
    assert_eq!(*ran_at_bind.lock().unwrap(), Some(false));
    assert!(ran.exists());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_failing_bind_still_runs_the_command() {
    let dir = tempfile::tempdir().unwrap();
    let ran = dir.path().join("ran");
    let (s, ran_at_bind) = scoped_server(ran.clone(), 500, json!({ "ok": true })).await;
    let h = Harness::new();
    let cmd = format!("touch '{}'", ran.display());
    let code = h.run(&["--url", &s.uri(), "slot", "run", "--", &cmd]).await;
    assert_eq!(code, 0, "stderr: {}", h.err.text());
    assert_eq!(*ran_at_bind.lock().unwrap(), Some(false));
    assert!(ran.exists());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_exit_reports_oom_note_is_printed() {
    let dir = tempfile::tempdir().unwrap();
    let (s, _) = scoped_server(
        dir.path().join("ran"),
        200,
        json!({ "ok": true, "oom": true, "message": "Shepherd: this heavy check hit its memory limit (6 GiB)" }),
    )
    .await;
    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "slot", "run", "--", "exit 137"])
        .await;
    assert_eq!(code, 137);
    assert!(h.err.text().contains("hit its memory limit (6 GiB)"));
}

#[tokio::test]
async fn no_scope_answer_means_no_bind() {
    let s = MockServer::start().await;
    answer(
        &s,
        OPERATOR,
        "acquire",
        200,
        json!({ "decision": "run", "jobId": "j1" }),
    )
    .await;
    answer(&s, OPERATOR, "finished", 200, json!({ "ok": true })).await;
    Mock::given(method("POST"))
        .and(path(OPERATOR))
        .and(body_partial_json(json!({ "op": "bind" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
        .expect(0)
        .mount(&s)
        .await;
    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "slot", "run", "--", "exit 0"])
        .await;
    assert_eq!(code, 0, "stderr: {}", h.err.text());
}
