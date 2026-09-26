//! Epics: `epics list|show|start|pause|stop|approve-next`.

mod common;

use common::Harness;
use serde_json::json;
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn epic_json(status: &str, mode: &str) -> serde_json::Value {
    json!({
        "repoPath": "/work/repo", "parentIssueNumber": 12, "parentTitle": "OAuth epic",
        "source": "sub-issues", "warnings": ["#9 blocks itself"], "noDependencyEdges": false,
        "children": [{
            "number": 13, "title": "Token store", "url": "https://x/13", "order": 0,
            "body": "", "blockedBy": [], "state": "done", "sessionId": null, "prNumber": 40,
            "issueClosed": true, "integrationMerged": false, "claimed": false
        }, {
            "number": 14, "title": "Login flow", "url": "https://x/14", "order": 1,
            "body": "", "blockedBy": [13], "state": "running", "sessionId": "id-7",
            "prNumber": null, "issueClosed": false, "integrationMerged": false, "claimed": true
        }],
        "run": {
            "repoPath": "/work/repo", "parentIssueNumber": 12, "mode": mode, "status": status,
            "agentProvider": "claude", "model": "opus"
        }
    })
}

fn epic_query() -> (
    wiremock::matchers::QueryParamExactMatcher,
    wiremock::matchers::QueryParamExactMatcher,
) {
    (
        query_param("repo", "/work/repo"),
        query_param("parent", "12"),
    )
}

/// The pre-check `pause`, `stop` and `approve-next` make: GET /api/epic answers this run.
async fn mount_run(s: &MockServer, status: &str, mode: &str) {
    Mock::given(method("GET"))
        .and(path("/api/epic"))
        .and(query_param("parent", "12"))
        .respond_with(ResponseTemplate::new(200).set_body_json(epic_json(status, mode)))
        .mount(s)
        .await;
}

#[tokio::test]
async fn list_prints_json_and_a_table() {
    let s = MockServer::start().await;
    let body = json!({
        "epics": [{
            "parentIssueNumber": 12, "parentTitle": "OAuth epic", "total": 5, "merged": 2,
            "status": "running", "source": "sub-issues", "inFlight": 0
        }],
        "subIssues": [13, 14]
    });
    Mock::given(method("GET"))
        .and(path("/api/epics"))
        .and(query_param("repo", "/work/repo"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
        .mount(&s)
        .await;
    let args = ["--url", &s.uri(), "epics", "list", "--repo", "/work/repo"];
    let h = Harness::new();
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json(), body);

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    let out = h.out.text();
    for want in ["OAuth epic", "running", "2/5", "sub-issues"] {
        assert!(out.contains(want), "{want}: {out}");
    }
}

#[tokio::test]
async fn show_prints_the_epic() {
    let s = MockServer::start().await;
    let (repo, parent) = epic_query();
    Mock::given(method("GET"))
        .and(path("/api/epic"))
        .and(repo)
        .and(parent)
        .respond_with(ResponseTemplate::new(200).set_body_json(epic_json("running", "attended")))
        .mount(&s)
        .await;
    // `--repo` is global to `epics`: it may come before the subcommand.
    let args = [
        "--url",
        &s.uri(),
        "epics",
        "--repo",
        "/work/repo",
        "show",
        "12",
    ];
    let h = Harness::new();
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["children"][1]["blockedBy"], json!([13]));

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    let out = h.out.text();
    for want in [
        "epic #12 — OAuth epic",
        "run: running (attended), provider claude, model opus, effort -",
        "warning: #9 blocks itself",
        "Login flow",
        "#13",
        "#40",
        "id-7",
    ] {
        assert!(out.contains(want), "{want}: {out}");
    }
}

#[tokio::test]
async fn start_sends_running_plus_the_given_fields() {
    let s = MockServer::start().await;
    let (repo, parent) = epic_query();
    Mock::given(method("PUT"))
        .and(path("/api/epic"))
        .and(repo)
        .and(parent)
        .and(body_json(json!({
            "status": "running", "mode": "attended", "agentProvider": "codex",
            "model": "gpt-5", "effort": "high"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(epic_json("running", "attended")))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    let args = [
        "--url",
        &s.uri(),
        "epics",
        "start",
        "12",
        "--repo",
        "/work/repo",
        "--mode",
        "attended",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--effort",
        "high",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.out.text().trim(), "epic #12: running (attended)");
}

#[tokio::test]
async fn start_without_options_sends_only_the_status() {
    let s = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/api/epic"))
        .and(body_json(json!({"status": "running"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(epic_json("running", "auto")))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "epics", "start", "12", "--repo", "/r"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["run"]["status"], "running");
}

#[tokio::test]
async fn pause_and_stop_send_their_status() {
    let s = MockServer::start().await;
    mount_run(&s, "running", "auto").await;
    for status in ["paused", "idle"] {
        Mock::given(method("PUT"))
            .and(path("/api/epic"))
            .and(query_param("parent", "12"))
            .and(body_json(json!({"status": status})))
            .respond_with(ResponseTemplate::new(200).set_body_json(epic_json(status, "auto")))
            .expect(1)
            .mount(&s)
            .await;
    }
    for (verb, status) in [("pause", "paused"), ("stop", "idle")] {
        let h = Harness {
            tty: true,
            ..Harness::new()
        };
        let args = ["--url", &s.uri(), "epics", verb, "12", "--repo", "/r"];
        assert_eq!(h.run(&args).await, 0, "{verb}: {}", h.err.text());
        assert_eq!(h.out.text().trim(), format!("epic #12: {status} (auto)"));
    }
}

#[tokio::test]
async fn approve_next_posts_and_accepts_the_ok_answer() {
    let s = MockServer::start().await;
    mount_run(&s, "running", "attended").await;
    let (repo, parent) = epic_query();
    Mock::given(method("POST"))
        .and(path("/api/epic/approve-next"))
        .and(repo)
        .and(parent)
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(2)
        .mount(&s)
        .await;
    let args = [
        "--url",
        &s.uri(),
        "epics",
        "approve-next",
        "12",
        "--repo",
        "/work/repo",
    ];
    let h = Harness::new();
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json(), json!({"ok": true}));
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.out.text().trim(), "epic #12 updated");
}

#[tokio::test]
async fn server_errors_map_to_exit_codes() {
    for (status, exit) in [(503, 8), (400, 6)] {
        let s = MockServer::start().await;
        mount_run(&s, "running", "auto").await;
        Mock::given(method("PUT"))
            .and(path("/api/epic"))
            .respond_with(
                ResponseTemplate::new(status).set_body_json(json!({"error": "drain unavailable"})),
            )
            .mount(&s)
            .await;
        let h = Harness::new();
        let args = ["--url", &s.uri(), "epics", "pause", "12", "--repo", "/r"];
        assert_eq!(h.run(&args).await, exit, "{status}: {}", h.err.text());
        assert!(
            h.err.text().contains("drain unavailable"),
            "{}",
            h.err.text()
        );
    }
}

#[tokio::test]
async fn run_state_mismatch_is_refused_without_a_write() {
    // (verb, run status, run mode): the parent's own run is not in a state the verb acts on —
    // e.g. another epic is the repo's live run, so this parent reads as the idle default.
    let cases = [
        ("pause", "idle", "auto"),
        ("pause", "paused", "auto"),
        ("stop", "idle", "auto"),
        ("approve-next", "running", "auto"),
        ("approve-next", "paused", "attended"),
        ("approve-next", "idle", "auto"),
    ];
    for (verb, status, mode) in cases {
        let s = MockServer::start().await;
        mount_run(&s, status, mode).await;
        for m in ["PUT", "POST"] {
            Mock::given(method(m))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
                .expect(0)
                .mount(&s)
                .await;
        }
        let h = Harness::new();
        let args = ["--url", &s.uri(), "epics", verb, "12", "--repo", "/r"];
        assert_eq!(h.run(&args).await, 6, "{verb} {status} {mode}");
        let err = h.err.text();
        assert!(err.contains("epic #12") && err.contains(status), "{err}");
    }
}

#[tokio::test]
async fn stop_accepts_a_paused_run() {
    let s = MockServer::start().await;
    mount_run(&s, "paused", "auto").await;
    Mock::given(method("PUT"))
        .and(path("/api/epic"))
        .and(body_json(json!({"status": "idle"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(epic_json("idle", "auto")))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "epics", "stop", "12", "--repo", "/r"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
}

#[tokio::test]
async fn parent_zero_is_a_usage_error() {
    let s = MockServer::start().await;
    Mock::given(wiremock::matchers::any())
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&s)
        .await;
    for verb in ["show", "start", "pause", "stop", "approve-next"] {
        let h = Harness::new();
        let args = ["--url", &s.uri(), "epics", verb, "0", "--repo", "/r"];
        assert_eq!(h.run(&args).await, 2, "{verb}");
    }
}
