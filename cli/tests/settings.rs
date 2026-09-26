//! Settings and diagnostics: `settings …`, `repo-config …`, `diagnose …`.

mod common;

use common::Harness;
use serde_json::json;
use shepherd_cli::test_support::repo_config_json;
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn settings_json() -> serde_json::Value {
    json!({
        "repoRoot": "/work", "repoRootDisplay": "~/work", "firstRunPending": false,
        "defaultModel": "auto", "defaultEffort": "high", "defaultAgentProvider": "claude",
        "authMode": "subscription", "operatorLanguage": "en", "namerModel": "haiku",
        "providerFailover": {"active": false, "from": null, "current": "claude"},
        "telemetryHealth": {"lastSentAt": 5, "lastErrorAt": null, "lastError": null}
    })
}

fn diagnostics_json() -> serde_json::Value {
    json!({
        "generatedAt": 1, "overall": "error",
        "checks": [
            {"id": "bun", "state": "ok", "hintKey": "diagnostics_hint_bun_ok"},
            {"id": "herdr", "state": "error", "hintKey": "diagnostics_hint_herdr_missing",
             "remediation": "curl -fsSL https://x | sh"}
        ]
    })
}

/// A PATCH mock that must never be hit.
async fn no_patch(s: &MockServer) {
    Mock::given(method("PATCH"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(s)
        .await;
}

#[tokio::test]
async fn settings_keeps_contract_fields() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/settings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(settings_json()))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "settings"]).await, 0);
    let out = h.json();
    assert_eq!(out["namerModel"], "haiku");
    assert_eq!(out["providerFailover"]["current"], "claude");
    assert_eq!(out["telemetryHealth"]["lastSentAt"], 5);

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&["--url", &s.uri(), "settings"]).await, 0);
    assert!(h.out.text().contains("namerModel"), "{}", h.out.text());
}

#[tokio::test]
async fn settings_set_sends_typed_values() {
    let s = MockServer::start().await;
    for (body, answer) in [
        (json!({"usageHoldPct": 80}), json!({"usageHoldPct": 80})),
        (
            json!({"tuiFullscreen": true}),
            json!({"tuiFullscreen": true}),
        ),
        (
            json!({"defaultModel": "opus"}),
            json!({"defaultModel": "opus"}),
        ),
    ] {
        Mock::given(method("PATCH"))
            .and(path("/api/settings"))
            .and(body_json(&body))
            .respond_with(ResponseTemplate::new(200).set_body_json(answer))
            .expect(1..)
            .mount(&s)
            .await;
    }
    for (key, value) in [
        ("usageHoldPct", "80"),
        ("tuiFullscreen", "true"),
        ("defaultModel", "opus"),
    ] {
        let h = Harness::new();
        let code = h
            .run(&["--url", &s.uri(), "settings", "set", key, value])
            .await;
        assert_eq!(code, 0, "{key}: {}", h.err.text());
    }
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    let args = ["--url", &s.uri(), "settings", "set", "defaultModel", "opus"];
    assert_eq!(h.run(&args).await, 0);
    assert_eq!(h.out.text().trim(), "set defaultModel = opus");
}

#[tokio::test]
async fn settings_set_refuses_before_sending() {
    let s = MockServer::start().await;
    no_patch(&s).await;
    let uri = s.uri();
    for (args, message) in [
        (["nope", "1"], "unknown key `nope`"),
        (["usageHoldPct", "lots"], "invalid value for `usageHoldPct`"),
        (["anthropicApiKey", "sk-x"], "only read from stdin"),
    ] {
        let h = Harness::new();
        let mut argv = vec!["--url", &uri, "settings", "set"];
        argv.extend(args);
        assert_eq!(h.run(&argv).await, 2);
        assert!(h.err.text().contains(message), "{}", h.err.text());
        assert!(!h.err.text().contains("sk-x"));
    }
}

#[tokio::test]
async fn settings_set_reads_the_api_key_from_stdin() {
    let s = MockServer::start().await;
    Mock::given(method("PATCH"))
        .and(path("/api/settings"))
        .and(body_json(json!({"anthropicApiKey": "sk-secret"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"hasApiKey": true})))
        .expect(1)
        .mount(&s)
        .await;
    let h = Harness {
        tty: true,
        stdin: "sk-secret\n".into(),
        ..Harness::new()
    };
    let args = ["--url", &s.uri(), "settings", "set", "anthropicApiKey", "-"];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.out.text().trim(), "set anthropicApiKey (stored)");
}

#[tokio::test]
async fn settings_set_never_clears_the_api_key_from_empty_stdin() {
    let s = MockServer::start().await;
    no_patch(&s).await;
    for stdin in ["", "  \n"] {
        let h = Harness {
            stdin: stdin.into(),
            ..Harness::new()
        };
        let args = ["--url", &s.uri(), "settings", "set", "anthropicApiKey", "-"];
        assert_eq!(h.run(&args).await, 2);
        assert!(h.err.text().contains("stdin was empty"), "{}", h.err.text());
    }
}

#[tokio::test]
async fn settings_set_clears_the_api_key_explicitly() {
    let s = MockServer::start().await;
    Mock::given(method("PATCH"))
        .and(path("/api/settings"))
        .and(body_json(json!({"anthropicApiKey": null})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"hasApiKey": false})))
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
        "settings",
        "set",
        "anthropicApiKey",
        "null",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.out.text().trim(), "cleared anthropicApiKey");
}

#[tokio::test]
async fn settings_scope_message() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/settings"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({"error": "insufficient_scope"})),
        )
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "settings"]).await, 4);
    assert!(
        h.err
            .text()
            .contains("`shepherd settings` needs a 'full' token"),
        "{}",
        h.err.text()
    );
}

#[tokio::test]
async fn repo_config_show_and_set() {
    let s = MockServer::start().await;
    let mut cfg = repo_config_json();
    cfg["automationConfirmed"] = json!(true);
    Mock::given(method("GET"))
        .and(path("/api/repo-config"))
        .and(query_param("repo", "/r"))
        .respond_with(ResponseTemplate::new(200).set_body_json(cfg.clone()))
        .expect(1)
        .mount(&s)
        .await;
    for body in [
        json!({"maxAuto": 3}),
        json!({"egressExtraHosts": ["a.com"]}),
        json!({"egressExtraHosts": []}),
        json!({"previewStartCommand": ""}),
        json!({"previewStartCommand": null}),
    ] {
        Mock::given(method("PUT"))
            .and(path("/api/repo-config"))
            .and(query_param("repo", "/r"))
            .and(body_json(&body))
            .respond_with(ResponseTemplate::new(200).set_body_json(repo_config_json()))
            .expect(1)
            .mount(&s)
            .await;
    }
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "repo-config", "--repo", "/r"])
            .await,
        0,
        "{}",
        h.err.text()
    );
    assert_eq!(h.json()["automationConfirmed"], true);

    for (key, value) in [
        ("maxAuto", "3"),
        ("egressExtraHosts", r#"["a.com"]"#),
        ("egressExtraHosts", "[]"),
        ("previewStartCommand", ""),
        ("previewStartCommand", "null"),
    ] {
        let h = Harness::new();
        let args = [
            "--url",
            &s.uri(),
            "repo-config",
            "set",
            key,
            value,
            "--repo",
            "/r",
        ];
        assert_eq!(h.run(&args).await, 0, "{key}: {}", h.err.text());
        assert_eq!(h.json()["maxAuto"], 2);
    }

    let h = Harness::new();
    let args = [
        "--url",
        &s.uri(),
        "repo-config",
        "--repo",
        "/r",
        "set",
        "x",
        "1",
    ];
    assert_eq!(h.run(&args).await, 2);
    assert!(h.err.text().contains("unknown key `x`"));
}

#[tokio::test]
async fn diagnose_lists_and_refreshes() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/diagnostics"))
        .and(query_param("refresh", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(diagnostics_json()))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/diagnostics"))
        .respond_with(ResponseTemplate::new(200).set_body_json(diagnostics_json()))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &s.uri(), "diagnose"]).await, 0);
    assert_eq!(h.json(), diagnostics_json());

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(
        h.run(&["--url", &s.uri(), "diagnose", "--refresh"]).await,
        0
    );
    let text = h.out.text();
    assert!(text.contains("curl -fsSL https://x | sh"), "{text}");
    assert!(text.trim_end().ends_with("overall: error"), "{text}");
}

#[tokio::test]
async fn diagnose_fix_posts_the_check() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/diagnostics/fix"))
        .and(body_json(json!({"checkId": "herdr"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(diagnostics_json()))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/diagnostics/fix"))
        .and(body_json(json!({"checkId": "tailscale"})))
        .respond_with(
            ResponseTemplate::new(409)
                .set_body_json(json!({"error": "no remediation for tailscale"})),
        )
        .mount(&s)
        .await;
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(
        h.run(&["--url", &s.uri(), "diagnose", "fix", "herdr"])
            .await,
        0
    );
    let text = h.out.text();
    assert!(text.contains("herdr") && !text.contains("bun"), "{text}");

    let h = Harness::new();
    let code = h
        .run(&["--url", &s.uri(), "diagnose", "fix", "tailscale"])
        .await;
    assert_eq!(code, 6);
    assert!(
        h.err.text().contains("no remediation for tailscale"),
        "{}",
        h.err.text()
    );
}
