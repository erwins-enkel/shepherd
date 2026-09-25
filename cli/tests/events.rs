//! `events tail` against an in-test server speaking both the snapshot routes and `/events`.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::Harness;
use futures::SinkExt;
use serde_json::{Value, json};
use shepherd_cli::test_support::session_json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

#[derive(Default)]
struct Seen {
    auth: Mutex<Vec<String>>,
    connections: AtomicUsize,
}

fn frame(event: &str, id: &str) -> Message {
    Message::text(json!({"event": event, "data": {"id": id}}).to_string())
}

async fn http(mut stream: TcpStream) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
    let body = match path.as_str() {
        "/api/sessions" => {
            // Slow on purpose: live frames must arrive while the snapshot is still loading.
            tokio::time::sleep(Duration::from_millis(200)).await;
            json!([
                session_json("id-1", "TASK-01"),
                session_json("id-2", "TASK-02")
            ])
        }
        "/api/holds" => json!({"id-2": {"code": "usage"}}),
        "/api/git" => json!({}),
        "/api/health" => json!({"ok": true, "version": shepherd_cli::CLI_VERSION}),
        _ => json!({"error": "not found"}),
    }
    .to_string();
    let reply = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
}

async fn events(stream: TcpStream, seen: Arc<Seen>, reject: Option<(u16, &'static str)>) {
    let seen2 = seen.clone();
    // The callback's signature is fixed by tungstenite's `Callback` trait.
    #[allow(clippy::result_large_err)]
    let callback = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let auth = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        seen2.auth.lock().unwrap().push(auth);
        if let Some((status, body)) = reject {
            let mut r = ErrorResponse::new(Some(body.to_string()));
            *r.status_mut() = status.try_into().unwrap();
            return Err(r);
        }
        Ok(resp)
    };
    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    let n = seen.connections.fetch_add(1, Ordering::SeqCst);
    if n == 0 {
        ws.send(frame("session:status", "id-1")).await.unwrap();
        ws.send(frame("session:new", "id-2")).await.unwrap();
        ws.send(frame("spawn:progress", "id-1")).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = ws.close(None).await;
    } else {
        ws.send(frame("session:status", "id-2")).await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

async fn serve(reject: Option<(u16, &'static str)>) -> (String, Arc<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Seen::default());
    let seen2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut peek = [0u8; 64];
            let n = stream.peek(&mut peek).await.unwrap_or(0);
            if peek[..n].starts_with(b"GET /events ") {
                tokio::spawn(events(stream, seen2.clone(), reject));
            } else {
                tokio::spawn(http(stream));
            }
        }
    });
    (url, seen)
}

fn lines(text: &str) -> Vec<Value> {
    text.lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

async fn wait_for(h: &Harness, count: usize) -> Vec<Value> {
    for _ in 0..100 {
        let got = lines(&h.out.text());
        if got.len() >= count {
            return got;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out; stdout so far:\n{}", h.out.text());
}

#[tokio::test]
async fn snapshot_first_then_buffered_then_live_and_resnapshot_on_reconnect() {
    let (url, seen) = serve(None).await;
    let h = Harness::new();
    let mut io = h.io();
    let task = tokio::spawn(async move {
        shepherd_cli::run(["shepherd", "--url", &url, "events", "tail"], &mut io).await
    });
    let got = wait_for(&h, 6).await;
    task.abort();
    let events: Vec<&str> = got.iter().map(|v| v["event"].as_str().unwrap()).collect();
    assert_eq!(
        events,
        [
            "snapshot",
            "session:status",
            "session:new",
            "spawn:progress",
            "snapshot",
            "session:status"
        ]
    );
    assert_eq!(got[0]["data"]["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(got[0]["data"]["holds"]["id-2"]["code"], "usage");
    assert!(
        seen.auth
            .lock()
            .unwrap()
            .iter()
            .all(|a| a == "Bearer shp_test")
    );
    assert!(h.err.text().contains("reconnecting"), "{}", h.err.text());
}

#[tokio::test]
async fn filters_by_event_prefix_and_session() {
    let (url, _) = serve(None).await;
    let h = Harness::new();
    let mut io = h.io();
    let task = tokio::spawn(async move {
        let args = [
            "shepherd",
            "--url",
            &url,
            "events",
            "tail",
            "--session",
            "TASK-01",
        ];
        let mut argv = args.to_vec();
        argv.extend(["--event", "session:"]);
        shepherd_cli::run(argv, &mut io).await
    });
    // snapshot, session:status(id-1), snapshot — spawn:progress and id-2 frames are filtered.
    let got = wait_for(&h, 3).await;
    task.abort();
    assert_eq!(got[0]["event"], "snapshot");
    assert_eq!(got[0]["data"]["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(got[0]["data"]["holds"], json!({}));
    assert_eq!(
        got[1],
        json!({"event": "session:status", "data": {"id": "id-1"}})
    );
    assert_eq!(got[2]["event"], "snapshot");
}

#[tokio::test]
async fn no_snapshot_streams_only_frames() {
    let (url, _) = serve(None).await;
    let h = Harness::new();
    let mut io = h.io();
    let task = tokio::spawn(async move {
        shepherd_cli::run(
            ["shepherd", "--url", &url, "events", "tail", "--no-snapshot"],
            &mut io,
        )
        .await
    });
    let got = wait_for(&h, 3).await;
    task.abort();
    assert_eq!(got[0]["event"], "session:status");
}

#[tokio::test]
async fn upgrade_rejections_map_to_exit_codes() {
    for (status, body, code) in [
        (401, r#"{"error":"unauthorized"}"#, 3),
        (403, r#"{"error":"insufficient_scope"}"#, 4),
    ] {
        let (url, _) = serve(Some((status, body))).await;
        let h = Harness::new();
        let got = h.run(&["--url", &url, "events", "tail"]).await;
        assert_eq!(got, code, "{status}: {}", h.err.text());
    }
}
