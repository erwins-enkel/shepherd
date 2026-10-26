//! Operator schedules: `schedule ls|add|run`.

mod common;

use common::{EVIL, Harness};
use serde_json::json;
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const ID: &str = "0b8f3c1e-6d2a-4f7b-9c1d-2e3f4a5b6c7d";

fn run_json(outcome: &str, session: Option<&str>, reason: Option<&str>) -> serde_json::Value {
    json!({
        "id": 3, "scheduleId": ID, "slotKey": "manual:2026-10-27T09:00:00.000Z",
        "outcome": outcome, "sessionId": session, "reason": reason, "at": 1_700_000_000_000i64
    })
}

fn schedule_json(id: &str, name: &str) -> serde_json::Value {
    json!({
        "id": id, "repoPath": "/work/repo", "name": name, "prompt": "/triage-feedback",
        "days": 21, "times": ["09:00", "17:30"], "enabled": true,
        "launch": {
            "agentProvider": null, "model": null, "effort": null, "autopilotEnabled": false,
            "planGateEnabled": null, "research": false, "sandboxProfile": null, "baseBranch": null
        },
        "baselineAt": 0, "createdAt": 0, "updatedAt": 0,
        "lastRun": run_json("spawned", Some("id-7"), None),
        "nextAt": 4_102_444_800_000i64
    })
}

async fn mount_list(s: &MockServer, schedules: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path("/api/schedules"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "schedules": schedules })))
        .mount(s)
        .await;
}

async fn mount_run(s: &MockServer, body: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path(format!("/api/schedules/{ID}/run")))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(s)
        .await;
}

/// Requests to anything but the version probe.
async fn api_calls(s: &MockServer) -> Vec<String> {
    s.received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| format!("{} {}", r.method, r.url.path()))
        .filter(|p| !p.ends_with("/api/health"))
        .collect()
}

#[tokio::test]
async fn ls_prints_json_and_a_table() {
    let s = MockServer::start().await;
    mount_list(&s, json!([schedule_json(ID, &format!("triage {EVIL}"))])).await;
    let args = ["--url", &s.uri(), "schedule", "ls"];
    let h = Harness::new();
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["schedules"][0]["id"], ID);

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&["--url", &s.uri(), "schedule", "list"]).await, 0);
    let out = h.out.text();
    for want in [
        ID,
        "triage",
        "/work/repo",
        "mon,wed,fri",
        "09:00,17:30",
        "yes",
        "in ",
        "spawned",
    ] {
        assert!(out.contains(want), "{want}: {out}");
    }
    h.assert_clean();
}

#[tokio::test]
async fn ls_filters_by_repo() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/schedules"))
        .and(query_param("repo", "/work/repo"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "schedules": [] })))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = ["--url", &s.uri(), "schedule", "ls", "--repo", "/work/repo"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
}

#[tokio::test]
async fn add_sends_defaults_and_reads_stdin() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/schedules"))
        .and(body_json(json!({
            "repoPath": "/work/repo", "name": "triage", "prompt": "/triage-feedback",
            "days": 127, "times": ["09:00"], "enabled": true
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(schedule_json(ID, "triage")))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness {
        stdin: "/triage-feedback".into(),
        ..Harness::new()
    };
    let args = [
        "--url",
        &s.uri(),
        "schedule",
        "add",
        "--repo",
        "/work/repo",
        "--name",
        "triage",
        "--at",
        "09:00",
        "-",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["id"], ID);
}

#[tokio::test]
async fn add_sends_only_the_launch_flags_given() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/schedules"))
        .and(body_json(json!({
            "repoPath": "/work/repo", "name": "nightly", "prompt": "/audit",
            "days": 21, "times": ["09:00", "17:30"], "enabled": false,
            "launch": {
                "agentProvider": "codex", "model": "gpt-5", "effort": "high",
                "autopilotEnabled": true, "planGateEnabled": true, "baseBranch": "dev"
            }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(schedule_json(ID, "nightly")))
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
        "schedule",
        "add",
        "--repo",
        "/work/repo",
        "--name",
        "nightly",
        "--at",
        "09:00",
        "--at",
        "17:30",
        "--days",
        "mon,wed,fri",
        "--disabled",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--effort",
        "high",
        "--autopilot",
        "--plan-gate",
        "--base",
        "dev",
        "/audit",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    let out = h.out.text();
    assert!(
        out.contains(&format!("schedule \"nightly\" created ({ID}), next in ")),
        "{out}"
    );
}

#[tokio::test]
async fn add_rejects_bad_times_and_days_before_sending() {
    let s = MockServer::start().await;
    let uri = s.uri();
    for bad in [["--at", "25:00"], ["--days", "funday"]] {
        let h = Harness::new();
        let mut args = vec![
            "--url", &uri, "schedule", "add", "--repo", "/r", "--name", "n", "p",
        ];
        args.extend(bad);
        if bad[0] == "--days" {
            args.extend(["--at", "09:00"]);
        }
        assert_eq!(h.run(&args).await, 2, "{bad:?}");
    }
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "schedule",
        "add",
        "--repo",
        "/r",
        "--name",
        "n",
        "p",
    ];
    assert_eq!(h.run(&args).await, 2, "--at is required");
    assert!(api_calls(&s).await.is_empty());
}

#[tokio::test]
async fn add_maps_a_400_to_refused() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/schedules"))
        .respond_with(
            ResponseTemplate::new(400).set_body_json(json!({ "error": "name must be 1–80 chars" })),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "schedule",
        "add",
        "--repo",
        "/r",
        "--name",
        " ",
        "--at",
        "09:00",
        "p",
    ];
    assert_eq!(h.run(&args).await, 6);
    assert!(h.err.text().contains("name must be"), "{}", h.err.text());
}

#[tokio::test]
async fn run_by_id_skips_the_lookup() {
    let s = MockServer::start().await;
    mount_run(&s, run_json("spawned", Some("id-7"), None)).await;
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&["--url", &s.uri(), "schedule", "run", ID]).await, 0);
    assert!(
        h.out.text().contains("spawned, session id-7"),
        "{}",
        h.out.text()
    );
    assert_eq!(
        api_calls(&s).await,
        [format!("POST /api/schedules/{ID}/run")]
    );
}

#[tokio::test]
async fn run_by_name_resolves_then_fires() {
    let s = MockServer::start().await;
    mount_list(
        &s,
        json!([
            schedule_json(ID, "triage"),
            schedule_json("other-id", "audit")
        ]),
    )
    .await;
    mount_run(&s, run_json("held", None, Some("usage"))).await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "schedule", "run", "triage"])
            .await,
        0
    );
    assert_eq!(h.json()["outcome"], "held");
}

#[tokio::test]
async fn run_by_name_refuses_ambiguous_and_unknown() {
    let s = MockServer::start().await;
    mount_list(
        &s,
        json!([
            schedule_json(ID, "triage"),
            schedule_json("other-id", "triage")
        ]),
    )
    .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "schedule", "run", "triage"])
            .await,
        2
    );
    assert!(
        h.err.text().contains("2 schedules are named"),
        "{}",
        h.err.text()
    );
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "schedule", "run", "nope"]).await,
        5
    );
    assert!(api_calls(&s).await.iter().all(|c| c.starts_with("GET")));
}

#[tokio::test]
async fn run_exits_by_outcome() {
    for (outcome, reason, code) in [
        ("skipped:overlap", "previous run still open", 6),
        ("error", "no default branch", 1),
    ] {
        let s = MockServer::start().await;
        mount_run(&s, run_json(outcome, None, Some(reason))).await;
        let h = Harness::new();
        assert_eq!(
            h.run(&["--url", &s.uri(), "schedule", "run", ID]).await,
            code
        );
        assert_eq!(h.json()["outcome"], outcome, "the run is still printed");
        assert!(h.err.text().contains(reason), "{}", h.err.text());
    }
}

#[tokio::test]
async fn run_of_a_missing_schedule_is_not_found() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("/api/schedules/{ID}/run")))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "error": "not found" })))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "schedule", "run", ID]).await, 5);
}
