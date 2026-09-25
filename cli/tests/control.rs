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
