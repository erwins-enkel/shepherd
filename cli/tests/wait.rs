//! `wait` against an in-test server whose state a test changes mid-run, announcing it on
//! `/events` the way the real server does.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::Harness;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use shepherd_cli::test_support::session_json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

/// A frame the socket task turns into a close instead of forwarding.
const CLOSE: &str = "close";

struct Server {
    url: String,
    sessions: Mutex<Vec<Value>>,
    holds: Mutex<Value>,
    git: Mutex<Value>,
    /// `None` answers 403 insufficient_scope, like a `read` token gets.
    plan_gates: Mutex<Option<Value>>,
    /// Times `GET /api/sessions` was served: one per read.
    reads: AtomicUsize,
    frames: broadcast::Sender<String>,
}

impl Server {
    async fn start(sessions: Vec<Value>) -> Arc<Server> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = Arc::new(Server {
            url: format!("http://{}", listener.local_addr().unwrap()),
            sessions: Mutex::new(sessions),
            holds: Mutex::new(json!({})),
            git: Mutex::new(json!({})),
            plan_gates: Mutex::new(None),
            reads: AtomicUsize::new(0),
            frames: broadcast::channel(64).0,
        });
        let s = server.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let mut peek = [0u8; 64];
                let n = stream.peek(&mut peek).await.unwrap_or(0);
                if peek[..n].starts_with(b"GET /events ") {
                    tokio::spawn(events(stream, s.frames.subscribe()));
                } else {
                    tokio::spawn(http(stream, s.clone()));
                }
            }
        });
        server
    }

    fn set(&self, field: &Mutex<Value>, id: &str, value: Value) {
        field.lock().unwrap()[id] = value;
    }

    fn patch_session(&self, id: &str, patch: Value) {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.iter_mut().find(|s| s["id"] == id).unwrap();
        for (k, v) in patch.as_object().unwrap() {
            s[k] = v.clone();
        }
    }

    fn frame(&self, event: &str, data: Value) {
        let _ = self
            .frames
            .send(json!({"event": event, "data": data}).to_string());
    }

    /// Waits until the CLI has finished `n` reads and is listening on `/events`.
    async fn reads(&self, n: usize) {
        for _ in 0..200 {
            if self.reads.load(Ordering::SeqCst) >= n && self.frames.receiver_count() > 0 {
                // The read's other two routes are answered alongside this one.
                tokio::time::sleep(Duration::from_millis(100)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the CLI never finished read {n}");
    }
}

async fn http(mut stream: TcpStream, s: Arc<Server>) {
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
    let (status, body) = match path.as_str() {
        "/api/sessions" => {
            let body = json!(*s.sessions.lock().unwrap());
            s.reads.fetch_add(1, Ordering::SeqCst);
            (200, body)
        }
        "/api/holds" => (200, s.holds.lock().unwrap().clone()),
        "/api/git" => (200, s.git.lock().unwrap().clone()),
        "/api/plan-gates" => match s.plan_gates.lock().unwrap().clone() {
            Some(gates) => (200, gates),
            None => (403, json!({"error": "insufficient_scope"})),
        },
        "/api/health" => (
            200,
            json!({"ok": true, "version": shepherd_cli::CLI_VERSION}),
        ),
        // What a `read` token gets when it asks for a session outside the active list.
        "/api/sessions/TASK-77" => (403, json!({"error": "insufficient_scope"})),
        _ => (404, json!({"error": "not found"})),
    };
    let body = body.to_string();
    let reply = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
}

async fn events(stream: TcpStream, mut frames: broadcast::Receiver<String>) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut tx, mut rx) = ws.split();
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Ok(f) if f == CLOSE => {
                    let _ = tx.close().await;
                    return;
                }
                Ok(f) => {
                    if tx.send(Message::text(f)).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            },
            msg = rx.next() => if !matches!(msg, Some(Ok(_))) {
                return;
            },
        }
    }
}

fn running() -> Vec<Value> {
    vec![
        session_json("id-1", "TASK-01"),
        session_json("id-2", "TASK-02"),
    ]
}

fn pr(state: &str) -> Value {
    json!({
        "state": state, "checks": "success", "deployConfigured": false,
        "number": 12, "url": "https://forge/pr/12"
    })
}

/// Starts `shepherd wait <args>` in the background; `.await` it for the exit code.
fn spawn(h: &Harness, s: &Server, args: &[&str]) -> tokio::task::JoinHandle<i32> {
    let mut argv = vec![
        "shepherd".to_string(),
        "--url".to_string(),
        s.url.clone(),
        "wait".to_string(),
    ];
    argv.extend(args.iter().map(|a| a.to_string()));
    let mut io = h.io();
    tokio::spawn(async move { shepherd_cli::run(argv, &mut io).await })
}

async fn exit(task: tokio::task::JoinHandle<i32>) -> i32 {
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("wait never returned")
        .unwrap()
}

#[tokio::test]
async fn a_state_that_already_holds_returns_at_once_with_its_code() {
    let cases = [
        (json!({"haltReason": "usage_limit"}), None, 14, "halted"),
        (json!({"autopilotComplete": true}), None, 13, "done"),
        (json!({}), Some(pr("merged")), 13, "done"),
        (json!({}), Some(pr("open")), 12, "pr"),
        (json!({"autopilotPaused": true}), None, 10, "needs-input"),
    ];
    for (patch, git, code, state) in cases {
        let s = Server::start(running()).await;
        s.patch_session("id-1", patch);
        if let Some(g) = git {
            s.set(&s.git, "id-1", g);
        }
        let h = Harness::new();
        assert_eq!(exit(spawn(&h, &s, &["TASK-01"])).await, code, "{state}");
        let v = h.json();
        assert_eq!(v["state"], state);
        assert_eq!(v["session"], "id-1");
        assert_eq!(v["desig"], "TASK-01");
    }
}

#[tokio::test]
async fn wakes_on_a_frame_and_names_the_question() {
    let s = Server::start(running()).await;
    let h = Harness::new();
    let task = spawn(&h, &s, &["TASK-01", "--until", "needs-input,pr"]);
    s.reads(1).await;
    s.set(
        &s.holds,
        "id-1",
        json!({"code": "autopilot-paused", "params": {"question": "Open the PR?"}}),
    );
    s.frame("session:hold", json!({"id": "id-1"}));
    assert_eq!(exit(task).await, 10, "{}", h.err.text());
    let v = h.json();
    assert_eq!(v["state"], "needs-input");
    assert_eq!(v["hold"], "autopilot-paused");
    assert_eq!(v["question"], "Open the PR?");
    assert!(s.reads.load(Ordering::SeqCst) >= 2);
}

#[tokio::test]
async fn ignores_unrequested_states_and_other_sessions() {
    let s = Server::start(running()).await;
    let h = Harness::new();
    let task = spawn(&h, &s, &["TASK-01", "--until", "pr"]);
    s.reads(1).await;
    // Needs input, but only `pr` was asked for.
    s.set(&s.holds, "id-1", json!({"code": "blocked-menu"}));
    s.frame("session:hold", json!({"id": "id-1"}));
    // Another session's PR.
    s.set(&s.git, "id-2", pr("open"));
    s.frame("session:git", json!({"id": "id-2"}));
    s.reads(2).await;
    assert!(!task.is_finished(), "{}", h.out.text());
    s.set(&s.git, "id-1", pr("open"));
    s.frame("session:git", json!({"id": "id-1"}));
    assert_eq!(exit(task).await, 12);
    let v = h.json();
    assert_eq!(v["state"], "pr");
    assert_eq!(
        v["pr"],
        json!({"number": 12, "url": "https://forge/pr/12", "state": "open"})
    );
}

#[tokio::test]
async fn an_archived_session_is_done_and_keeps_its_last_pr() {
    let s = Server::start(running()).await;
    s.set(&s.git, "id-1", pr("open"));
    let h = Harness::new();
    let task = spawn(&h, &s, &["1", "--until", "done"]);
    s.reads(1).await;
    // Archiving drops the session from the active list and from /api/git in one burst.
    s.sessions.lock().unwrap().retain(|x| x["id"] != "id-1");
    s.git
        .lock()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("id-1");
    s.frame("session:git", json!({"id": "id-1"}));
    s.frame("session:archived", json!({"id": "id-1"}));
    assert_eq!(exit(task).await, 13);
    let v = h.json();
    assert_eq!(v["reason"], "archived");
    assert_eq!(v["status"], "archived");
    assert_eq!(v["pr"]["url"], "https://forge/pr/12");
}

#[tokio::test]
async fn a_change_missed_while_disconnected_is_read_on_reconnect() {
    let s = Server::start(running()).await;
    let h = Harness::new();
    let task = spawn(&h, &s, &["TASK-01"]);
    s.reads(1).await;
    // No frame announces this halt; the reconnect's re-read must find it.
    s.patch_session("id-1", json!({"haltReason": "error"}));
    let _ = s.frames.send(CLOSE.to_string());
    assert_eq!(exit(task).await, 14);
    assert_eq!(h.json()["haltReason"], "error");
    assert!(h.err.text().contains("reconnecting"), "{}", h.err.text());
}

#[tokio::test]
async fn plan_ready_from_the_plan_gates_route() {
    let s = Server::start(running()).await;
    s.patch_session("id-1", json!({"planPhase": "planning"}));
    *s.plan_gates.lock().unwrap() = Some(json!({"id-1": {
        "sessionId": "id-1", "planHash": "h", "decision": "approve", "summary": "",
        "body": "", "findings": [], "round": 1, "cap": 3, "approved": true, "plan": "p",
        "updatedAt": 0
    }}));
    let h = Harness::new();
    assert_eq!(
        exit(spawn(&h, &s, &["TASK-01"])).await,
        11,
        "{}",
        h.err.text()
    );
    assert_eq!(h.json()["state"], "plan-ready");
    assert_eq!(h.err.text(), "");
}

#[tokio::test]
async fn plan_ready_from_a_frame_when_the_token_cannot_read_plan_gates() {
    let s = Server::start(running()).await;
    s.patch_session("id-1", json!({"planPhase": "planning"}));
    let h = Harness::new();
    let task = spawn(&h, &s, &["TASK-01", "--until", "plan-ready"]);
    s.reads(1).await;
    s.frame(
        "session:plangate",
        json!({"id": "id-1", "gate": {"approved": true}}),
    );
    assert_eq!(exit(task).await, 11, "{}", h.err.text());
    assert!(
        h.err.text().contains("cannot read plan gates"),
        "{}",
        h.err.text()
    );
}

#[tokio::test]
async fn timeout_prints_the_last_state_and_exits_9() {
    let s = Server::start(running()).await;
    let h = Harness::new();
    assert_eq!(
        exit(spawn(&h, &s, &["TASK-01", "--timeout", "1s"])).await,
        9
    );
    let v = h.json();
    assert_eq!(v["state"], "timeout");
    assert_eq!(v["status"], "running");
    assert_eq!(h.err.text(), "");
}

#[tokio::test]
async fn human_line_on_a_terminal() {
    let s = Server::start(running()).await;
    s.set(&s.git, "id-1", pr("open"));
    let h = Harness {
        tty: true,
        ..Harness::new()
    };
    assert_eq!(exit(spawn(&h, &s, &["TASK-01"])).await, 12);
    assert_eq!(h.out.text(), "TASK-01: PR #12 https://forge/pr/12\n");
}

#[tokio::test]
async fn unknown_session_and_bad_flags() {
    let s = Server::start(running()).await;
    let h = Harness::new();
    assert_eq!(exit(spawn(&h, &s, &["TASK-99"])).await, 5);
    let h = Harness::new();
    assert_eq!(exit(spawn(&h, &s, &["TASK-77"])).await, 4);
    assert!(
        h.err
            .text()
            .contains("no active session matches \"TASK-77\""),
        "{}",
        h.err.text()
    );
    for args in [
        ["TASK-01", "--until", "nope"],
        ["TASK-01", "--timeout", "soon"],
    ] {
        let h = Harness::new();
        assert_eq!(exit(spawn(&h, &s, &args)).await, 2, "{args:?}");
    }
}
