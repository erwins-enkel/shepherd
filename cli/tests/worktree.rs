mod common;

use common::{EVIL, Harness};
use serde_json::json;
use shepherd_cli::test_support::session_json;
use wiremock::matchers::{method, path, query_param};
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
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!([session_json("id-1", "TASK-01"),])),
        )
        .mount(&s)
        .await;
    s
}

fn status_body() -> serde_json::Value {
    json!({
        "base": "main", "baseRef": "origin/main", "fetchFailed": false,
        "head": "feat/x", "headSha": "aaaaaaaaaaaaaaaa", "mergeBase": "bbbbbbbbbbbbbbbb",
        "baseSha": "cccccccccccccccc", "behindBase": 2, "aheadOfBase": 7,
        "upstream": null, "unpushedCount": 7, "dirty": true,
        "unpushed": [{"sha": "dddddddddddddddd", "subject": "feat: \u{1b}[2Jlast", "authoredAt": 1000}]
    })
}

async fn with_status(s: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/sessions/id-1/worktree/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body()))
        .mount(s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/git"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(s)
        .await;
}

#[tokio::test]
async fn git_session_json_joins_pr_and_worktree() {
    let s = server().await;
    with_status(&s).await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "git", "TASK-01"]).await, 0);
    let v = h.json();
    assert_eq!(v["session"], "TASK-01");
    assert_eq!(v["pr"], serde_json::Value::Null);
    assert_eq!(v["worktree"]["behindBase"], 2);
    assert_eq!(v["worktree"]["unpushedCount"], 7);
    assert_eq!(v["worktree"]["dirty"], true);
}

#[tokio::test]
async fn git_session_table_lists_unpushed_commits() {
    let s = server().await;
    with_status(&s).await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(h.run(&["--url", &s.uri(), "git", "TASK-01"]).await, 0);
    let out = h.out.text();
    assert!(out.contains("behind base"), "{out}");
    assert!(out.contains("bbbbbbbbbb"), "{out}");
    assert!(out.contains("dddddddddd feat: [2Jlast"), "{out:?}");
    assert!(!out.contains('\u{1b}'), "{out:?}");
}

#[tokio::test]
async fn git_session_needs_full_scope() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions/id-1/worktree/status"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error":"insufficient_scope"})),
        )
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/git"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "git", "TASK-01"]).await, 4);
    assert!(
        h.err
            .text()
            .contains("`shepherd git <session>` needs a 'full' token"),
        "{}",
        h.err.text()
    );
}

fn file(path: &str, adds: i64, patch: Option<&str>) -> serde_json::Value {
    json!({"path": path, "status": "modified", "additions": adds, "deletions": 1,
           "binary": false, "patch": patch})
}

async fn with_diff(s: &MockServer) {
    let mut big = file("docs/big.md", 5000, None);
    big["truncated"] = json!(true);
    Mock::given(method("GET"))
        .and(path("/api/sessions/id-1/diff"))
        .and(query_param("worktree", "true"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "base": "main", "baseRef": "origin/main", "head": "feat/x",
            "fetchFailed": false, "truncated": true,
            "files": [
                file("src/a.ts", 3, Some("diff --git a/src/a.ts b/src/a.ts\n+a")),
                file("src/ab.ts", 4, Some("diff --git a/src/ab.ts b/src/ab.ts\n+ab")),
                big,
                json!({"path": "src/new.ts", "oldPath": "src/old.ts", "status": "renamed",
                       "additions": 0, "deletions": 0, "binary": false}),
            ]
        })))
        .mount(s)
        .await;
}

#[tokio::test]
async fn diff_prints_patches_and_marks_truncated() {
    let s = server().await;
    with_diff(&s).await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(h.run(&["--url", &s.uri(), "diff", "TASK-01"]).await, 0);
    let out = h.out.text();
    assert!(out.contains("+a\n"), "{out}");
    assert!(out.contains("# src/old.ts -> src/new.ts: renamed"), "{out}");
    assert!(
        out.contains("# docs/big.md: too large to show (+5000 -1)"),
        "{out}"
    );
}

#[tokio::test]
async fn diff_stat_with_path_filter() {
    let s = server().await;
    with_diff(&s).await;
    let mut h = Harness::new();
    h.tty = true;
    let args = [
        "--url",
        &s.uri(),
        "diff",
        "TASK-01",
        "--stat",
        "--",
        "src/a.ts",
        "docs/",
    ];
    assert_eq!(h.run(&args).await, 0);
    let out = h.out.text();
    assert!(out.contains("src/a.ts"), "{out}");
    assert!(!out.contains("src/ab.ts"), "{out}");
    assert!(out.contains("docs/big.md"), "{out}");
    assert!(out.contains("2 files changed, +5003 -2"), "{out}");
}

#[tokio::test]
async fn diff_json_is_the_filtered_result() {
    let s = server().await;
    with_diff(&s).await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "diff", "TASK-01", "--", "src"])
            .await,
        0
    );
    let v = h.json();
    assert_eq!(v["files"].as_array().unwrap().len(), 3);
    assert_eq!(v["baseRef"], "origin/main");
}

#[tokio::test]
async fn cat_writes_raw_bytes_when_piped() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions/id-1/worktree/download"))
        .and(query_param("path", ".superpowers/plan.md"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(b"# plan\n\x1b[1mx\n".to_vec(), "application/octet-stream"),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "cat", "TASK-01", ".superpowers/plan.md"])
            .await,
        0
    );
    assert_eq!(h.out.text(), "# plan\n\u{1b}[1mx\n");
    // On a terminal, control characters are dropped.
    let mut t = Harness::new();
    t.tty = true;
    assert_eq!(
        t.run(&["--url", &s.uri(), "cat", "TASK-01", ".superpowers/plan.md"])
            .await,
        0
    );
    assert_eq!(t.out.text(), "# plan\n[1mx\n");
}

#[tokio::test]
async fn cat_missing_file_is_not_found() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions/id-1/worktree/download"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "not found"})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "cat", "TASK-01", "../x"]).await,
        5
    );
}

#[tokio::test]
async fn tty_cat_strips_terminal_sequences() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions/id-1/worktree/download"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(format!("{EVIL}\n").into_bytes(), "application/octet-stream"),
        )
        .mount(&s)
        .await;
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    let args = ["--url", &s.uri(), "cat", "TASK-01", "a.txt"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.out.text(), "x]0;pwn[2J31my\n");
    h.assert_clean();
}
