//! Work intake: `backlog`, `issues`, `drain …`, `held …`.

mod common;

use common::Harness;
use serde_json::json;
use shepherd_cli::test_support::{repo_config_json, session_json};
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn held_json(id: &str) -> serde_json::Value {
    json!({
        "id": id, "repoPath": "/work/repo", "createdAt": 0, "reason": "usage",
        "input": {"repoPath": "/work/repo", "baseBranch": "main", "prompt": "Add OAuth\nmore"}
    })
}

#[tokio::test]
async fn backlog_prints_the_payload() {
    let s = MockServer::start().await;
    let body = json!({
        "pinnedPath": null,
        "projects": [{
            "path": "/work/repo", "display": "repo", "slug": "o/repo", "kind": "github",
            "lastUsedAt": null, "recentAgentCount": 1, "openIssues": 4, "openPRs": 2,
            "prKinds": {"release": 0, "dependabot": 1, "regular": 1}, "workflows": 3,
            "ciStatus": "success", "hidden": false
        }],
        "totals": {"openIssues": 4, "openPRs": 2}
    });
    Mock::given(method("GET"))
        .and(path("/api/backlog"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "backlog"]).await, 0);
    assert_eq!(h.json(), body);

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&["--url", &s.uri(), "backlog"]).await, 0);
    assert!(h.out.text().contains("o/repo"), "{}", h.out.text());
    assert!(h.out.text().contains("4 open issues, 2 open PRs"));
}

#[tokio::test]
async fn issues_queries_the_repo() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/issues"))
        .and(query_param("repo", "/work/repo"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "slug": "o/repo", "webUrl": null, "viewer": null, "issues": [{
                "number": 12, "title": "Bug", "body": "", "url": "https://x/12",
                "labels": ["bug"], "createdAt": 0, "assignees": []
            }]
        })))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "issues", "--repo", "/work/repo"])
            .await,
        0,
        "{}",
        h.err.text()
    );
    assert_eq!(h.json()["issues"][0]["number"], 12);
}

#[tokio::test]
async fn drain_status_and_queue() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/drain"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "repoPath": "/work/repo", "enabled": true, "paused": false, "reason": null,
            "detail": null, "queued": 3, "inFlight": 1, "max": 2, "epicParent": null
        }])))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/drain/queue"))
        .and(query_param("repo", "/work/repo"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"number": 5, "title": "Next", "url": "https://x/5"}
        ])))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "drain", "status"]).await, 0);
    assert_eq!(h.json()[0]["queued"], 3);
    let h = Harness::new();
    let args = ["--url", &s.uri(), "drain", "queue", "--repo", "/work/repo"];
    assert_eq!(h.run(&args).await, 0);
    assert_eq!(h.json()[0]["number"], 5);
}

#[tokio::test]
async fn drain_start_and_stop_flip_the_repo_flag() {
    let s = MockServer::start().await;
    for on in [true, false] {
        Mock::given(method("PUT"))
            .and(path("/api/repo-config"))
            .and(query_param("repo", "/work/repo"))
            .and(body_json(json!({"autoDrainEnabled": on})))
            .respond_with(ResponseTemplate::new(200).set_body_json(repo_config_json()))
            .expect(1)
            .mount(&s)
            .await;
    }
    for verb in ["start", "stop"] {
        let h = Harness::new();
        let args = ["--url", &s.uri(), "drain", verb, "--repo", "/work/repo"];
        assert_eq!(h.run(&args).await, 0, "{verb}: {}", h.err.text());
        assert_eq!(h.json()["autoDrainEnabled"], verb == "start");
    }
}

#[tokio::test]
async fn drain_start_needs_full_scope() {
    let s = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/api/repo-config"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error": "insufficient_scope"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "drain", "start", "--repo", "/r"];
    assert_eq!(h.run(&args).await, 4);
    assert!(
        h.err
            .text()
            .contains("`shepherd drain start` needs a 'full' token")
    );
}

#[tokio::test]
async fn held_list_spawn_discard() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/held"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([held_json("h1")])))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/held/h1/spawn"))
        .and(body_json(json!({"agentProvider": "codex"})))
        .respond_with(ResponseTemplate::new(201).set_body_json(session_json("id-3", "TASK-03")))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/held/h1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    let uri = s.uri();
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&["--url", &uri, "held", "list"]).await, 0);
    assert!(h.out.text().contains("Add OAuth"), "{}", h.out.text());
    assert!(!h.out.text().contains("more"));
    let h = Harness::new();
    let args = ["--url", &uri, "held", "spawn", "h1", "--provider", "codex"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["desig"], "TASK-03");
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &uri, "held", "discard", "h1"]).await, 0);
    assert_eq!(h.json(), json!({"ok": true, "id": "h1"}));
}

#[tokio::test]
async fn held_needs_submit_scope() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/held"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error": "insufficient_scope"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "held", "list"]).await, 4);
    assert!(
        h.err
            .text()
            .contains("`shepherd held list` needs a 'submit' token")
    );
}

#[tokio::test]
async fn repo_defaults_to_the_git_toplevel_and_fails_outside_one() {
    // The harness cwd is `/`, which is not inside a git repository.
    let h = Harness::new();
    assert_eq!(h.run(&["--url", "http://127.0.0.1:1", "issues"]).await, 2);
    assert!(h.err.text().contains("pass --repo"));
}
