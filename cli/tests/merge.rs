//! Reviews and merging: `review-pr`, `review-plan`, `merge`, `train …`.

mod common;

use common::Harness;
use serde_json::json;
use shepherd_cli::test_support::{repo_config_json, session_json};
use wiremock::matchers::{body_json, method, path, query_param};
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

fn git_json() -> serde_json::Value {
    json!({
        "state": "open", "checks": "success", "deployConfigured": false, "number": 42,
        "headSha": "abc123", "baseRefName": "main",
        "mergeGate": {"handoff": "reviewer", "handoffWho": "alice"}
    })
}

#[tokio::test]
async fn review_pr_and_plan_trigger_by_designation() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/review-pr"))
        .respond_with(
            ResponseTemplate::new(202).set_body_json(json!({"ok": true, "status": "started"})),
        )
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/review-plan"))
        .respond_with(
            ResponseTemplate::new(202).set_body_json(json!({"ok": true, "status": "running"})),
        )
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "review-pr", "7"]).await, 0);
    assert_eq!(h.json()["status"], "started");
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "review-plan", "TASK-07"]).await,
        0
    );
    assert_eq!(h.json()["status"], "running");
}

#[tokio::test]
async fn merge_sends_method_and_branch_choice() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/git/merge"))
        .and(body_json(
            json!({"method": "squash", "deleteBranch": false}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(git_json()))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "merge",
        "TASK-07",
        "--method",
        "squash",
        "--keep-branch",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["number"], 42);
}

#[tokio::test]
async fn merge_confirm_refusal_points_at_takeover() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/git/merge"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "error": "this merge is someone else's responsibility",
            "code": "merge_confirm_required"
        })))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "merge", "TASK-07"]).await, 6);
    assert!(h.err.text().contains("--takeover"), "{}", h.err.text());
}

#[tokio::test]
async fn takeover_echoes_the_cached_pr_state() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/git"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id-7": git_json()})))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/sessions/id-7/git/merge"))
        .and(body_json(json!({"confirm": {
            "headSha": "abc123", "baseRefName": "main",
            "handoff": "reviewer", "handoffWho": "alice"
        }})))
        .respond_with(ResponseTemplate::new(200).set_body_json(git_json()))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "merge", "TASK-07", "--takeover"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
}

#[tokio::test]
async fn train_status_start_stop() {
    let s = server().await;
    Mock::given(method("GET"))
        .and(path("/api/automerge"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "repoPath": "/work/repo", "enabled": true, "state": "idle", "detail": null,
            "sessionId": null
        }])))
        .mount(&s)
        .await;
    for on in [true, false] {
        Mock::given(method("PUT"))
            .and(path("/api/repo-config"))
            .and(query_param("repo", "/work/repo"))
            .and(body_json(json!({"autoMergeEnabled": on})))
            .respond_with(ResponseTemplate::new(200).set_body_json(repo_config_json()))
            .expect(1)
            .mount(&s)
            .await;
    }
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "train", "status"]).await, 0);
    assert_eq!(h.json()[0]["state"], "idle");
    for verb in ["start", "stop"] {
        let h = Harness::new();
        let args = ["--url", &s.uri(), "train", verb, "--repo", "/work/repo"];
        assert_eq!(h.run(&args).await, 0, "{verb}: {}", h.err.text());
        assert_eq!(h.json()["autoMergeEnabled"], verb == "start");
    }
}

#[tokio::test]
async fn train_set_sends_explicit_null_for_default() {
    let s = server().await;
    for enabled in [json!(true), json!(false), json!(null)] {
        Mock::given(method("PUT"))
            .and(path("/api/sessions/id-7/automerge"))
            .and(body_json(json!({ "enabled": enabled })))
            .respond_with(ResponseTemplate::new(200).set_body_json(session_json("id-7", "TASK-07")))
            .expect(1)
            .mount(&s)
            .await;
    }
    for value in ["on", "off", "default"] {
        let h = Harness::new();
        let args = ["--url", &s.uri(), "train", "set", "TASK-07", value];
        assert_eq!(h.run(&args).await, 0, "{value}: {}", h.err.text());
    }
    let h = Harness::new();
    let args = ["--url", &s.uri(), "train", "set", "TASK-07", "maybe"];
    assert_eq!(h.run(&args).await, 2);
}
