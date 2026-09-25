//! `up-next list|start` against an in-test server: the snapshot arrives over `/events` only after
//! the CLI's `POST /api/up-next/refresh`, as on a real server.

mod common;

use std::sync::{Arc, Mutex};

use common::Harness;
use futures::SinkExt;
use serde_json::{Value, json};
use shepherd_cli::test_support::session_json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct State {
    refreshed: Notify,
    /// Status the refresh answers (202 unless overridden).
    refresh_status: Mutex<Option<u16>>,
    started: Mutex<Vec<Value>>,
}

fn item(repo: &str, slug: &str, n: i64) -> Value {
    json!({
        "repoPath": format!("/work/{repo}"), "repoSlug": slug, "repoLabel": repo,
        "number": n, "title": format!("Issue {n}"), "url": format!("https://x/{slug}/{n}"),
        "kind": "bug", "priority": false, "createdAt": 0, "labels": [],
        "issueRef": {"number": n, "url": format!("https://x/{slug}/{n}"),
                     "title": format!("Issue {n}"), "body": "details"}
    })
}

fn snapshot() -> Value {
    let a5 = item("alpha", "o/alpha", 5);
    json!({
        "generatedAt": 0, "repoCount": 2, "fallback": null, "failedRepoCount": 0,
        "sections": [
            {"kind": "priority", "repoPath": null, "repoSlug": null, "repoLabel": null,
             "items": [a5.clone()], "totalCount": 1},
            {"kind": "repo", "repoPath": "/work/alpha", "repoSlug": "o/alpha",
             "repoLabel": "alpha", "items": [a5, item("alpha", "o/alpha", 7)], "totalCount": 2},
            {"kind": "repo", "repoPath": "/work/beta", "repoSlug": "o/beta",
             "repoLabel": "beta", "items": [item("beta", "o/beta", 7)], "totalCount": 1}
        ]
    })
}

async fn read_request(stream: &mut TcpStream) -> (String, Vec<u8>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let len = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    let _ = stream.read_exact(&mut body).await;
    (head, body)
}

async fn http(mut stream: TcpStream, state: Arc<State>) {
    let (head, body) = read_request(&mut stream).await;
    let line = head.lines().next().unwrap_or("").to_string();
    let (status, reply) = if line.starts_with("POST /api/up-next/refresh ") {
        let status = state.refresh_status.lock().unwrap().unwrap_or(202);
        if status == 202 {
            state.refreshed.notify_one();
            (202, json!({"ok": true}))
        } else {
            (status, json!({"error": "up-next unavailable"}))
        }
    } else if line.starts_with("POST /api/up-next/start ") {
        state
            .started
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&body).unwrap());
        let created = vec![session_json("id-9", "TASK-09")];
        (201, json!({"created": created, "held": [], "errors": []}))
    } else if line.starts_with("GET /api/health ") {
        (
            200,
            json!({"ok": true, "version": shepherd_cli::CLI_VERSION}),
        )
    } else {
        (404, json!({"error": "not found"}))
    };
    let reply = reply.to_string();
    let text = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
        reply.len()
    );
    let _ = stream.write_all(text.as_bytes()).await;
}

async fn events(stream: TcpStream, state: Arc<State>) {
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    // Unrelated traffic first: the CLI must skip it.
    let noise = json!({"event": "session:status", "data": {"id": "x"}});
    ws.send(Message::text(noise.to_string())).await.unwrap();
    state.refreshed.notified().await;
    let frame = json!({"event": "upnext:snapshot", "data": {"snapshot": snapshot()}});
    ws.send(Message::text(frame.to_string())).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
}

async fn serve() -> (String, Arc<State>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(State::default());
    let state2 = state.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut peek = [0u8; 64];
            let n = stream.peek(&mut peek).await.unwrap_or(0);
            if peek[..n].starts_with(b"GET /events ") {
                tokio::spawn(events(stream, state2.clone()));
            } else {
                tokio::spawn(http(stream, state2.clone()));
            }
        }
    });
    (url, state)
}

#[tokio::test]
async fn list_refreshes_then_prints_the_pushed_snapshot() {
    let (url, _) = serve().await;
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &url, "up-next", "list"]).await,
        0,
        "{}",
        h.err.text()
    );
    assert_eq!(h.json(), snapshot());

    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(h.run(&["--url", &url, "up-next", "list"]).await, 0);
    let out = h.out.text();
    // The priority section repeats o/alpha#5; it is listed once.
    assert_eq!(out.matches("o/alpha#5").count(), 1, "{out}");
    assert!(out.contains("o/beta#7"));
}

#[tokio::test]
async fn start_sends_the_snapshot_items_issue_refs() {
    let (url, state) = serve().await;
    let h = Harness::new();
    let args = [
        "--url",
        &url,
        "up-next",
        "start",
        "5",
        "beta#7",
        "--provider",
        "codex",
        "--effort",
        "high",
    ];
    assert_eq!(h.run(&args).await, 0, "{}", h.err.text());
    assert_eq!(h.json()["created"][0]["desig"], "TASK-09");
    let started = state.started.lock().unwrap().clone();
    assert_eq!(
        started,
        vec![json!({
            "items": [
                {"repoPath": "/work/alpha", "issueRef": item("alpha", "o/alpha", 5)["issueRef"]},
                {"repoPath": "/work/beta", "issueRef": item("beta", "o/beta", 7)["issueRef"]}
            ],
            "agentProvider": "codex", "effort": "high"
        })]
    );
}

#[tokio::test]
async fn ambiguous_or_missing_items_are_usage_errors() {
    let (url, state) = serve().await;
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &url, "up-next", "start", "7"]).await, 2);
    assert!(
        h.err.text().contains("o/alpha#7, o/beta#7"),
        "{}",
        h.err.text()
    );
    let h = Harness::new();
    assert_eq!(
        h.run(&["--url", &url, "up-next", "start", "alpha#9"]).await,
        2
    );
    assert!(state.started.lock().unwrap().is_empty());
}

#[tokio::test]
async fn model_without_provider_is_usage() {
    let h = Harness::new();
    let args = [
        "--url",
        "http://127.0.0.1:1",
        "up-next",
        "start",
        "5",
        "--model",
        "m",
    ];
    assert_eq!(h.run(&args).await, 2);
}

#[tokio::test]
async fn unavailable_up_next_is_a_server_error() {
    let (url, state) = serve().await;
    *state.refresh_status.lock().unwrap() = Some(503);
    let h = Harness::new();
    assert_eq!(h.run(&["--url", &url, "up-next", "list"]).await, 8);
    assert!(h.err.text().contains("up-next unavailable"));
}
