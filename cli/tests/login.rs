mod common;

use common::Harness;
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn config_text(h: &Harness) -> Option<String> {
    std::fs::read_to_string(h.config_home.path().join("shepherd/config.toml")).ok()
}

#[tokio::test]
async fn login_validates_then_saves_and_later_commands_use_it() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .and(header("authorization", "Bearer shp_good"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.env.remove("SHEPHERD_TOKEN");
    assert_eq!(
        h.run(&["--url", &s.uri(), "login", "--token", "shp_good"])
            .await,
        0
    );
    let text = config_text(&h).unwrap();
    assert!(
        text.contains("shp_good") && text.contains(&s.uri()),
        "{text}"
    );
    assert!(
        !h.out.text().contains("shp_good"),
        "token must never be printed"
    );

    // No --url now: the stored profile supplies url + token.
    let h2 = Harness {
        env: h.env.clone(),
        ..Harness::new()
    };
    assert_eq!(h2.run(&["sessions", "list"]).await, 0, "{}", h2.err.text());
}

#[tokio::test]
async fn login_rejected_token_saves_nothing() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "unauthorized"})))
        .mount(&s)
        .await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &s.uri(), "login", "--token", "shp_bad"])
            .await,
        3
    );
    assert!(config_text(&h).is_none());
}

#[tokio::test]
async fn named_profile() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&s)
        .await;
    let h = Harness::new();
    let code = h
        .run(&[
            "--url",
            &s.uri(),
            "--profile",
            "remote",
            "login",
            "--token",
            "shp_r",
        ])
        .await;
    assert_eq!(code, 0);
    assert!(config_text(&h).unwrap().contains("[profiles.remote]"));
    assert!(h.err.text().contains("SHEPHERD_TOKEN is set"));
    let h2 = Harness {
        env: h.env.clone(),
        ..Harness::new()
    };
    assert_eq!(h2.run(&["--profile", "nope", "status"]).await, 2);
}

#[tokio::test]
async fn token_from_stdin() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .and(header("authorization", "Bearer shp_piped"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .expect(1)
        .mount(&s)
        .await;
    let mut h = Harness::new();
    h.stdin = "shp_piped\n".into();
    assert_eq!(
        h.run(&["--url", &s.uri(), "login", "--token", "-"]).await,
        0
    );
    assert!(config_text(&h).unwrap().contains("token = \"shp_piped\""));
}
