mod common;

use common::Harness;
use serde_json::json;
use shepherd_cli::test_support::session_json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true, "version": shepherd_cli::CLI_VERSION
        })))
        .mount(&s)
        .await;
    s
}

async fn with_sessions(s: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .and(header("authorization", "Bearer shp_test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            session_json("id-1", "TASK-01"),
            session_json("id-2", "TASK-02"),
        ])))
        .mount(s)
        .await;
}

#[tokio::test]
async fn sessions_list_json_when_piped() {
    let s = server().await;
    with_sessions(&s).await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "sessions", "list"]).await, 0);
    let v = h.json();
    assert_eq!(v[0]["desig"], "TASK-01");
    assert_eq!(v[1]["id"], "id-2");
    assert_eq!(h.err.text(), "");
}

#[tokio::test]
async fn sessions_list_table_on_tty() {
    let s = server().await;
    with_sessions(&s).await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(h.run(&["--url", &s.uri(), "sessions", "list"]).await, 0);
    let out = h.out.text();
    assert!(out.contains("DESIG"), "{out}");
    assert!(out.contains("TASK-02"), "{out}");
    // --json forces JSON on a TTY too.
    let h2 = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(
        h2.run(&["--url", &s.uri(), "--json", "sessions", "list"])
            .await,
        0
    );
    assert!(h2.json().is_array());
}

#[tokio::test]
async fn show_resolves_designation_without_full_scope() {
    let s = server().await;
    with_sessions(&s).await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "sessions", "show", "task-2"])
            .await,
        0
    );
    assert_eq!(h.json()["id"], "id-2");
}

#[tokio::test]
async fn show_falls_back_to_get_session_and_names_full_scope() {
    let s = server().await;
    with_sessions(&s).await;
    Mock::given(method("GET"))
        .and(path("/api/sessions/archived-id"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error":"insufficient_scope"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "sessions", "show", "archived-id"])
        .await;
    assert_eq!(code, 4);
    assert!(
        h.err.text().contains("needs a 'full' token"),
        "{}",
        h.err.text()
    );
    assert_eq!(h.out.text(), "");
}

#[tokio::test]
async fn show_unknown_is_not_found() {
    let s = server().await;
    with_sessions(&s).await;
    Mock::given(method("GET"))
        .and(path("/api/sessions/nope"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error":"not found"})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "sessions", "show", "nope"])
            .await,
        5
    );
}

#[tokio::test]
async fn status_summarizes() {
    let s = server().await;
    with_sessions(&s).await;
    Mock::given(method("GET"))
        .and(path("/api/holds"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id-1": {"code": "usage"}})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "status"]).await, 0);
    let v = h.json();
    assert_eq!(v["sessions"]["total"], 2);
    assert_eq!(v["sessions"]["byStatus"]["running"], 2);
    assert_eq!(v["held"], 1);
    assert_eq!(v["versionMatch"], true);
}

#[tokio::test]
async fn version_mismatch_warns_on_stderr() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/health"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"ok": true, "version": "0.0.1"})),
        )
        .mount(&s)
        .await;
    with_sessions(&s).await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "sessions", "list"]).await, 0);
    assert!(
        h.err.text().contains("server is v0.0.1"),
        "{}",
        h.err.text()
    );
}

#[tokio::test]
async fn holds_git_reviews_label_by_designation() {
    let s = server().await;
    with_sessions(&s).await;
    Mock::given(method("GET"))
        .and(path("/api/holds"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"id-1": {"code": "usage", "params": {"pct": 90}}})),
        )
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/git"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id-2": {"state": "open", "checks": "passing", "deployConfigured": false, "number": 12, "title": "feat: x"}
        })))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/reviews/inflight"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"id": "id-1", "provider": "claude", "model": "opus", "effort": "high"}
        ])))
        .mount(&s)
        .await;
    for (verb, needle) in [("holds", "TASK-01"), ("git", "#12"), ("reviews", "opus")] {
        let mut h = Harness::new();
        h.tty = true;
        assert_eq!(h.run(&["--url", &s.uri(), verb]).await, 0, "{verb}");
        assert!(h.out.text().contains(needle), "{verb}: {}", h.out.text());
    }
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "git"]).await, 0);
    assert_eq!(h.json()["id-2"]["number"], 12);
}

#[tokio::test]
async fn unauthorized_without_token_says_login() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":"unauthorized"})))
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.env.remove("SHEPHERD_TOKEN");
    assert_eq!(h.run(&["--url", &s.uri(), "sessions", "list"]).await, 3);
    assert!(
        h.err.text().contains("no access token configured"),
        "{}",
        h.err.text()
    );
}

#[tokio::test]
async fn server_error_and_unreachable() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error":"boom"})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "sessions", "list"]).await, 8);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &dead, "sessions", "list"]).await, 7);
}

#[tokio::test]
async fn usage_errors_exit_2() {
    let h = Harness::new();
    assert_eq!(h.run(&["bogus"]).await, 2);
    assert_eq!(h.run(&["--url", "ftp://x", "status"]).await, 2);
    let h = Harness::new();
    assert_eq!(h.run(&["--version"]).await, 0);
    assert!(h.out.text().contains(shepherd_cli::CLI_VERSION));
}
