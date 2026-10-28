mod common;

use common::{EVIL, Harness};
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
async fn new_reports_a_task_waiting_for_its_machine() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "held": true, "waiting": true, "id": "d-1", "count": 1,
            "host": {"instanceId": "m-1", "name": "MacBook", "platform": "macos"}
        })))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(
        h.run(&["--url", &s.uri(), "new", "--repo", "/r", "Port the app"])
            .await,
        0
    );
    let out = h.out.text();
    assert!(out.contains("waiting: MacBook is out of reach"), "{out}");
    assert!(!out.contains("usage hold"), "{out}");
}

#[tokio::test]
async fn new_after_sends_the_predecessor_and_reports_the_dependency_hold() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(json!({"afterSession": "TASK-1490"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "held": true, "id": "h-2", "count": 1, "reason": "after"
        })))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    assert_eq!(
        h.run(&[
            "--url",
            &s.uri(),
            "new",
            "--repo",
            "/r",
            "--after",
            "TASK-1490",
            "Follow-up"
        ])
        .await,
        0
    );
    let out = h.out.text();
    assert!(out.contains("predecessor's PR to land"), "{out}");
    assert!(!out.contains("usage hold"), "{out}");
}

#[tokio::test]
async fn new_after_rejects_a_malformed_task_key() {
    let h = Harness::new();
    assert_eq!(
        h.run(&[
            "--url",
            "http://127.0.0.1:1",
            "new",
            "--repo",
            "/r",
            "--after",
            "a b",
            "x"
        ])
        .await,
        2
    );
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

// ── machine choice: --on / --require (#3527) ──

fn host(id: &str, name: &str, platform: &str) -> serde_json::Value {
    json!({"instanceId": id, "name": name, "platform": platform})
}

/// This instance, as `POST /api/placement` lists it first.
fn here() -> serde_json::Value {
    host("m-here", "moes-tavern", "linux")
}

/// A created session whose `launchMetadata.placement` names `name` as its machine.
fn placed_session(name: &str) -> serde_json::Value {
    let mut s = session_json("id-9", "TASK-09");
    s["launchMetadata"] = json!({"placement": {
        "mode": "manual", "target": host("m-x", name, "macos"), "requirements": [],
        "basis": "manual", "preferred": null,
        "by": {"instanceId": "m-here", "name": "moes-tavern"}, "decidedAt": 0
    }});
    s
}

/// The preview of a server with machines connected, listing `machines`.
async fn preview(s: &MockServer, machines: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/api/placement"))
        .and(body_json(json!({"repoPath": "/r"})))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"active": true, "machines": machines})),
        )
        .expect(1)
        .mount(s)
        .await;
}

/// A create that must not be sent.
async fn no_create(s: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(201).set_body_json(session_json("id-9", "TASK-09")))
        .expect(0)
        .mount(s)
        .await;
}

#[tokio::test]
async fn new_on_resolves_a_machine_name_and_names_it_in_the_output() {
    let s = server().await;
    preview(&s, json!([here(), host("m-mac", "macbook", "macos")])).await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"target": {"instanceId": "m-mac"}}),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(placed_session("macbook")))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.tty = true;
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "new",
            "--repo",
            "/r",
            "--on",
            "MacBook",
            "Port it",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
    assert_eq!(
        h.out.text().trim(),
        "created TASK-09 (id-9) — TASK-09 name on macbook"
    );
}

#[tokio::test]
async fn new_on_takes_an_instance_id() {
    let s = server().await;
    preview(&s, json!([here(), host("m-mac", "macbook", "macos")])).await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"target": {"instanceId": "m-mac"}}),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(placed_session("macbook")))
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
            "/r",
            "--on",
            "m-mac",
            "x",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
    assert_eq!(h.json()["desig"], "TASK-09");
}

#[tokio::test]
async fn new_on_an_unknown_machine_is_usage_and_lists_the_names() {
    let s = server().await;
    preview(&s, json!([here(), host("m-mac", "macbook", "macos")])).await;
    no_create(&s).await;
    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "new", "--repo", "/r", "--on", "pi", "x"])
        .await;
    assert_eq!(code, 2);
    let err = h.err.text();
    assert!(err.contains("no machine 'pi'"), "{err}");
    assert!(err.contains("available: moes-tavern, macbook"), "{err}");
}

#[tokio::test]
async fn new_on_an_ambiguous_name_is_usage() {
    let s = server().await;
    preview(
        &s,
        json!([host("m-1", "box", "linux"), host("m-2", "Box", "macos")]),
    )
    .await;
    no_create(&s).await;
    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "new", "--repo", "/r", "--on", "BOX", "x"])
        .await;
    assert_eq!(code, 2);
    let err = h.err.text();
    assert!(err.contains("box (m-1), Box (m-2)"), "{err}");
}

/// No machine set up: the plain preview is `{active:false}`; named as the target, a value that is
/// not this instance's id gets this instance listed.
async fn no_other_machine(s: &MockServer, on: &str) {
    Mock::given(method("POST"))
        .and(path("/api/placement"))
        .and(body_json(json!({"repoPath": "/r"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"active": false})))
        .expect(1)
        .mount(s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/placement"))
        .and(body_json(json!({"repoPath": "/r", "target": {"instanceId": on}})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "active": true,
            "refusal": {"code": "remote_target_unknown", "error": "no connected machine has this instance ID"},
            "machines": [here()]
        })))
        .expect(1)
        .mount(s)
        .await;
}

#[tokio::test]
async fn new_on_is_usage_while_no_other_machine_is_connected() {
    let s = server().await;
    no_other_machine(&s, "macbook").await;
    no_create(&s).await;
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "new",
            "--repo",
            "/r",
            "--on",
            "macbook",
            "x",
        ])
        .await;
    assert_eq!(code, 2);
    let err = h.err.text();
    assert!(err.contains("no other machine is connected"), "{err}");
    assert!(err.contains("moes-tavern"), "{err}");
}

#[tokio::test]
async fn new_on_this_machine_by_name_while_no_other_is_connected() {
    let s = server().await;
    no_other_machine(&s, "Moes-Tavern").await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"target": {"instanceId": "m-here"}}),
        ))
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
            "/r",
            "--on",
            "Moes-Tavern",
            "x",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
}

#[tokio::test]
async fn new_on_this_machine_by_id_while_no_other_is_connected() {
    let s = server().await;
    // This instance's own id as the target is "here", so the preview stays inactive.
    Mock::given(method("POST"))
        .and(path("/api/placement"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"active": false})))
        .expect(2)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"target": {"instanceId": "m-here"}}),
        ))
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
            "/r",
            "--on",
            "m-here",
            "x",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
}

#[tokio::test]
async fn new_require_sends_requirements_without_a_preview() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"requirements": ["xcode", "sdk:ios", "ios-simulator"]}),
        ))
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
            "/r",
            "--require",
            "xcode",
            "--require",
            "sdk:ios, ios-simulator",
            "x",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
    assert!(h.err.text().is_empty(), "{}", h.err.text());
    let requests = s.received_requests().await.unwrap();
    assert!(requests.iter().all(|r| r.url.path() != "/api/placement"));
}

#[tokio::test]
async fn new_require_warns_about_an_unknown_capability_and_sends_it() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .and(body_partial_json(
            json!({"requirements": ["xcode", "quantum"]}),
        ))
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
            "/r",
            "--require",
            "xcode,quantum",
            "x",
        ])
        .await;
    assert_eq!(code, 0, "{}", h.err.text());
    let err = h.err.text();
    assert!(
        err.contains("warning: unknown capability 'quantum'"),
        "{err}"
    );
    assert!(err.contains("sdk:ios"), "{err}");
    assert!(!err.contains("'xcode'"), "{err}");
}

#[tokio::test]
async fn new_require_rejects_an_empty_capability() {
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            "http://127.0.0.1:1",
            "new",
            "--repo",
            "/r",
            "--require",
            "xcode,",
            "x",
        ])
        .await;
    assert_eq!(code, 2);
}

#[tokio::test]
async fn new_after_with_on_is_usage_before_any_request() {
    let s = MockServer::start().await;
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "new",
            "--repo",
            "/r",
            "--after",
            "TASK-07",
            "--on",
            "macbook",
            "x",
        ])
        .await;
    assert_eq!(code, 2);
    assert!(h.err.text().contains("drop --on"), "{}", h.err.text());
    assert!(s.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn new_reports_a_placement_refusal_as_refused() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "error": "no connected machine has xcode; macbook would, but has no checkout of this \
                      project; nothing was started",
            "code": "no_suitable_machine",
            "missing": ["xcode"],
            "together": false,
            "elsewhere": [host("m-mac", "macbook", "macos")]
        })))
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
            "/r",
            "--require",
            "xcode",
            "x",
        ])
        .await;
    assert_eq!(code, 6);
    let err = h.err.text();
    assert!(
        err.contains("refused (422): no connected machine has xcode"),
        "{err}"
    );
    assert!(err.contains("macbook would, but has no checkout"), "{err}");
    assert!(err.contains("(no_suitable_machine)"), "{err}");
}

#[tokio::test]
async fn new_without_machine_flags_sends_neither_target_nor_requirements() {
    let s = server().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(201).set_body_json(session_json("id-9", "TASK-09")))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "new", "--repo", "/r", "x"])
            .await,
        0
    );
    let requests = s.received_requests().await.unwrap();
    assert!(requests.iter().all(|r| r.url.path() != "/api/placement"));
    let create = requests
        .iter()
        .find(|r| r.url.path() == "/api/sessions" && r.method.as_str() == "POST")
        .expect("a create");
    let body: serde_json::Value = serde_json::from_slice(&create.body).unwrap();
    assert!(body.get("target").is_none(), "{body}");
    assert!(body.get("requirements").is_none(), "{body}");
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

#[tokio::test]
async fn tty_new_strips_terminal_sequences() {
    let s = server().await;
    let mut created = session_json("id-9", "TASK-09");
    created["name"] = json!(EVIL);
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(201).set_body_json(created))
        .mount(&s)
        .await;
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    let args = ["--url", &s.uri(), "new", "--repo", "/r", "go"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert!(h.out.text().contains("x]0;pwn"), "{}", h.out.text());
    h.assert_clean();
}
