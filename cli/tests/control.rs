mod common;

use common::Harness;
use serde_json::json;
use shepherd_cli::test_support::session_json;
use wiremock::matchers::{body_json, body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!([session_json("id-7", "TASK-07")])),
        )
        .mount(&s)
        .await;
    s
}

#[tokio::test]
async fn new_creates_session() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(json!({
            "repoPath": "/work/repo", "baseBranch": "dev", "prompt": "Add OAuth",
            "effort": "high", "agentProvider": "codex", "planGateEnabled": true
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(session_json("id-9", "TASK-09")))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "new",
            "--repo",
            "/work/repo",
            "--base",
            "dev",
            "--effort",
            "high",
            "--provider",
            "codex",
            "--plan-gate",
            "Add OAuth",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
    assert_eq!(h.json()["desig"], "TASK-09");
}

#[tokio::test]
async fn new_reads_prompt_from_stdin_and_reports_held() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"prompt": "from stdin\n", "baseBranch": "main"}),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"held": true, "id": "h-1", "count": 3})),
        )
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.stdin = "from stdin\n".into();
    h.tty = true;
    assert_eq!(
        h.run(&["--url", &s.uri(), "new", "--repo", "/r", "-"])
            .await,
        0
    );
    assert!(h.out.text().contains("held"), "{}", h.out.text());
}

#[tokio::test]
async fn new_submit_scope_message() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error": "insufficient_scope"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "new", "--repo", "/r", "x"])
            .await,
        4
    );
    assert!(
        h.err
            .text()
            .contains("`shepherd new` needs a 'submit' token"),
        "{}",
        h.err.text()
    );
}

#[tokio::test]
async fn new_without_repo_outside_git_is_usage() {
    let h = Harness::new();
    assert_eq!(h.run(&["--url", "http://127.0.0.1:1", "new", "x"]).await, 2);
}

#[tokio::test]
async fn steer_resolves_desig_and_sends_text() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/reply"))
        .and(body_json(json!({"text": "please rebase"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "steer", "TASK-07", "please rebase"])
            .await,
        0
    );
    assert_eq!(h.json(), json!({"ok": true, "id": "id-7"}));
}

#[tokio::test]
async fn steer_with_read_token_names_full() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/reply"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error": "insufficient_scope"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "steer", "7", "hi"]).await, 4);
    assert!(
        h.err
            .text()
            .contains("`shepherd steer` needs a 'full' token")
    );
}

#[tokio::test]
async fn interrupt_archive_resume() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/interrupt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/sessions/id-7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/resume"))
        .and(body_json(json!({"force": true})))
        .respond_with(ResponseTemplate::new(200).set_body_json(session_json("id-7", "TASK-07")))
        .expect(1)
        .mount(&s)
        .await;
    let uri = s.uri();
    for args in [
        vec!["interrupt", "TASK-07"],
        vec!["archive", "TASK-07"],
        vec!["resume", "TASK-07", "--force"],
    ] {
        let h = Harness::new();
        let mut argv = vec!["--url", uri.as_str()];
        argv.extend(args.iter());
        assert_eq!(h.run(&argv).await, 0, "{args:?}: {}", h.err.text());
    }
}

#[tokio::test]
async fn resume_conflict_is_refused() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/resume"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({"error": "archived"})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "resume", "TASK-07"]).await, 6);
    assert!(h.err.text().contains("archived"));
}

#[tokio::test]
async fn empty_steer_text_is_usage() {
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", "http://127.0.0.1:1", "steer", "x", "  "])
            .await,
        2
    );
}

fn halted(id: &str, desig: &str, reason: Option<&str>) -> serde_json::Value {
    let mut s = session_json(id, desig);
    s["haltReason"] = json!(reason);
    s
}

#[tokio::test]
async fn go_releases_the_plan_gate() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/go"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(h.run(&["--url", &s.uri(), "go", "TASK-07"]).await, 0);
    assert!(h.out.text().contains("plan gate released for TASK-07"));
}

#[tokio::test]
async fn go_not_releasable_is_refused() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/go"))
        .respond_with(
            ResponseTemplate::new(409).set_body_json(json!({"error": "plan gate not approved"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "go", "TASK-07"]).await, 6);
    assert!(h.err.text().contains("plan gate not approved"));
}

#[tokio::test]
async fn halt_without_yes_is_usage_and_sends_nothing() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/halt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"halted": 3})))
        .expect(0)
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "halt"]).await, 2);
    assert!(h.err.text().contains("--yes"), "{}", h.err.text());
    assert!(s.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn halt_yes_halts_the_herd() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/halt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"halted": 3})))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(h.run(&["--url", &s.uri(), "halt", "--yes"]).await, 0);
    assert!(h.out.text().contains("halted 3 agents"), "{}", h.out.text());
}

#[tokio::test]
async fn retry_defaults_to_usage_limit_sessions_and_continue_text() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            halted("id-1", "TASK-01", Some("usage_limit")),
            halted("id-2", "TASK-02", Some("operator")),
            halted("id-3", "TASK-03", None),
            halted("id-4", "TASK-04", Some("usage_limit")),
        ])))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/retry"))
        .and(body_json(json!({
            "ids": ["id-1", "id-4"],
            "text": "Please continue — your usage limit should have reset."
        })))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"resumed": 1, "steered": 1, "total": 2})),
        )
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(
        h.run(&["--url", &s.uri(), "retry"]).await,
        0,
        "{}",
        h.err.text()
    );
    assert!(h.out.text().contains("resumed 1, steered 1 of 2"));
}

#[tokio::test]
async fn retry_named_sessions_with_text() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/retry"))
        .and(body_json(json!({"ids": ["id-7"], "text": "go on"})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"resumed": 1, "steered": 0, "total": 1})),
        )
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "retry", "TASK-07", "--text", "go on"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["resumed"], 1);
}

#[tokio::test]
async fn retry_with_nothing_halted_posts_nothing() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/retry"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "retry"]).await, 0);
    assert_eq!(h.json(), json!({"resumed": 0, "steered": 0, "total": 0}));
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(h.run(&["--url", &s.uri(), "retry"]).await, 0);
    assert!(h.out.text().contains("nothing to retry"));
}
