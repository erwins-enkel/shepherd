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
    for body in [
        json!({"autoMergeEnabled": true, "draftMode": false}),
        json!({"autoMergeEnabled": false}),
    ] {
        Mock::given(method("PUT"))
            .and(path("/api/repo-config"))
            .and(query_param("repo", "/work/repo"))
            .and(body_json(body))
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

#[tokio::test]
async fn merge_pr_sends_repo_number_and_choices() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/prs/merge"))
        .and(body_json(json!({
            "repo": "/work/repo", "number": 42, "method": "rebase", "deleteBranch": false
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    let args = [
        "--url",
        &s.uri(),
        "merge-pr",
        "42",
        "--repo",
        "/work/repo",
        "--method",
        "rebase",
        "--keep-branch",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert!(h.out.text().contains("merged PR #42"), "{}", h.out.text());
}

fn refusal() -> serde_json::Value {
    json!({
        "error": "this merge is someone else's responsibility",
        "code": "merge_confirm_required",
        "gate": {"handoff": "merger", "handoffWho": "bob", "reviewBlockBy": "carol"},
        "headSha": "def456", "baseRefName": "main"
    })
}

#[tokio::test]
async fn merge_pr_confirm_refusal_points_at_takeover() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/prs/merge"))
        .respond_with(ResponseTemplate::new(409).set_body_json(refusal()))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "merge-pr", "42", "--repo", "/work/repo"];
    assert_eq!(h.run(&args).await, 6);
    assert!(
        h.err.text().contains("merge_confirm_required"),
        "{}",
        h.err.text()
    );
    assert!(h.err.text().contains("--takeover"), "{}", h.err.text());
}

#[tokio::test]
async fn merge_pr_takeover_echoes_the_refusal_once() {
    let s = MockServer::start().await;
    let confirmed = json!({
        "repo": "/work/repo", "number": 42,
        "confirm": {
            "headSha": "def456", "baseRefName": "main", "handoff": "merger",
            "handoffWho": "bob", "reviewBlockBy": "carol"
        }
    });
    Mock::given(method("POST"))
        .and(path("/api/prs/merge"))
        .and(body_json(confirmed))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/prs/merge"))
        .and(body_json(json!({"repo": "/work/repo", "number": 42})))
        .respond_with(ResponseTemplate::new(409).set_body_json(refusal()))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "merge-pr",
        "42",
        "--repo",
        "/work/repo",
        "--takeover",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(
        h.json(),
        json!({"ok": true, "repo": "/work/repo", "number": 42})
    );
}

#[tokio::test]
async fn merge_pr_takeover_second_refusal_is_final() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/prs/merge"))
        .respond_with(ResponseTemplate::new(409).set_body_json(refusal()))
        .expect(2)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "merge-pr",
        "42",
        "--repo",
        "/work/repo",
        "--takeover",
    ];
    assert_eq!(h.run(&args).await, 6);
    assert!(
        !h.err.text().contains("Rerun with --takeover"),
        "{}",
        h.err.text()
    );
}

fn ready(id: &str, desig: &str, repo: &str) -> serde_json::Value {
    let mut s = session_json(id, desig);
    s["readyToMerge"] = json!(true);
    s["repoPath"] = json!(repo);
    s
}

fn open_pr(number: i64, title: Option<&str>, url: Option<&str>) -> serde_json::Value {
    json!({
        "state": "open", "checks": "success", "deployConfigured": false, "number": number,
        "title": title, "url": url
    })
}

/// Four ready sessions in /work/repo (one reviewing, one in plan review, one merged) plus one in
/// /other, and a not-ready one.
async fn train_server() -> MockServer {
    let s = MockServer::start().await;
    let mut not_ready = session_json("id-6", "TASK-06");
    not_ready["repoPath"] = json!("/work/repo");
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            ready("id-1", "TASK-01", "/work/repo"),
            ready("id-2", "TASK-02", "/work/repo"),
            ready("id-3", "TASK-03", "/other"),
            ready("id-4", "TASK-04", "/work/repo"),
            ready("id-5", "TASK-05", "/work/repo"),
            not_ready,
            ready("id-7", "TASK-07", "/work/repo"),
        ])))
        .mount(&s)
        .await;
    let mut merged = open_pr(17, Some("Merged"), None);
    merged["state"] = json!("merged");
    Mock::given(method("GET"))
        .and(path("/api/git"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id-1": open_pr(12, Some("Title"), Some("url")),
            "id-2": open_pr(13, Some("Reviewing"), None),
            "id-3": open_pr(5, Some("Elsewhere"), None),
            "id-4": open_pr(14, Some("Planning"), None),
            "id-5": open_pr(15, None, None),
            "id-6": open_pr(16, Some("Not ready"), None),
            "id-7": merged,
        })))
        .mount(&s)
        .await;
    let inflight = |id: &str| json!([{"id": id, "effort": null, "model": null, "provider": null}]);
    Mock::given(method("GET"))
        .and(path("/api/reviews/inflight"))
        .respond_with(ResponseTemplate::new(200).set_body_json(inflight("id-2")))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/plan-gates/inflight"))
        .respond_with(ResponseTemplate::new(200).set_body_json(inflight("id-4")))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(201).set_body_json(session_json("id-9", "TASK-09")))
        .mount(&s)
        .await;
    s
}

async fn created_body(s: &MockServer) -> serde_json::Value {
    let reqs = s.received_requests().await.unwrap();
    let posts: Vec<_> = reqs
        .iter()
        .filter(|r| r.method.as_str() == "POST" && r.url.path() == "/api/sessions")
        .collect();
    assert_eq!(posts.len(), 1);
    serde_json::from_slice(&posts[0].body).unwrap()
}

#[tokio::test]
async fn train_launch_runs_the_ready_prs_of_the_busiest_repo() {
    let s = train_server().await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "train", "launch"]).await,
        0,
        "{}",
        h.err.text()
    );
    assert_eq!(h.json()["desig"], "TASK-09");
    assert!(
        h.err
            .text()
            .contains("1 ready PRs in other repos not included"),
        "{}",
        h.err.text()
    );
    let body = created_body(&s).await;
    assert_eq!(body["repoPath"], "/work/repo");
    assert_eq!(body["baseBranch"], "main");
    assert_eq!(body["mergeTrainPrs"], json!([12, 15]));
    assert_eq!(body["planGateEnabled"], false);
    assert_eq!(body["autopilotEnabled"], false);
    assert_eq!(body["force"], true);
    let prompt = body["prompt"].as_str().unwrap();
    assert!(prompt.contains("I've flagged ready to merge"), "{prompt}");
    assert!(prompt.contains("- #12 Title — url\n- #15\n"), "{prompt}");
    assert!(!prompt.contains("{prs}"));
}

#[tokio::test]
async fn train_launch_repo_flag_scopes_the_ready_prs() {
    let s = train_server().await;
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "train",
        "launch",
        "--repo",
        "/other",
        "--base",
        "dev",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert!(!h.err.text().contains("other repos"), "{}", h.err.text());
    let body = created_body(&s).await;
    assert_eq!(body["repoPath"], "/other");
    assert_eq!(body["baseBranch"], "dev");
    assert_eq!(body["mergeTrainPrs"], json!([5]));
}

#[tokio::test]
async fn train_launch_handpicked_uses_the_selected_prompt() {
    let s = train_server().await;
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "train",
        "launch",
        "12",
        "99",
        "--repo",
        "/work/repo",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    let body = created_body(&s).await;
    assert_eq!(body["mergeTrainPrs"], json!([12, 99]));
    assert_eq!(body["planGateEnabled"], false);
    assert_eq!(body["force"], true);
    let prompt = body["prompt"].as_str().unwrap();
    assert!(prompt.contains("I've selected"), "{prompt}");
    assert!(prompt.contains("- #12 Title — url\n- #99\n"), "{prompt}");
}

#[tokio::test]
async fn train_launch_without_ready_prs_is_refused() {
    let s = train_server().await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "train", "launch", "--repo", "/empty"];
    assert_eq!(h.run(&args).await, 6);
    assert!(
        h.err.text().contains("no ready-to-merge PRs"),
        "{}",
        h.err.text()
    );
    let posts = s
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0);
}
