//! `shepherd events tail`: NDJSON of the `/events` WebSocket.
//!
//! `/events` has no replay, so a client that only streamed would miss every fact that happened
//! before it connected. The socket is opened FIRST and its frames buffered while the snapshot
//! routes are read, then one synthetic `snapshot` line is printed, then the buffer, then the live
//! stream — no gap between snapshot and stream. A reconnect re-snapshots for the same reason.

use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{self, Message};

use super::{list_sessions, session_id, warn_mismatch};
use crate::cli::TailArgs;
use crate::error::{CliError, Exit, Op, Result, Scope, api_error, body_message, from_status};
use crate::{Ctx, api::Client};

const TAIL: Op = Op::new("events tail", Scope::Read);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A connection that lived this long was healthy: the next reconnect starts from the minimum
/// backoff again. A socket that keeps dropping sooner backs off, so a flapping server is not
/// re-snapshotted every second.
const STABLE_CONNECTION: Duration = Duration::from_secs(30);

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Which frames to print.
pub struct Filter {
    pub prefixes: Vec<String>,
    pub session: Option<String>,
}

impl Filter {
    pub fn admits(&self, frame: &Value) -> bool {
        let event = frame.get("event").and_then(Value::as_str).unwrap_or("");
        if !self.prefixes.is_empty() && !self.prefixes.iter().any(|p| event.starts_with(p.as_str()))
        {
            return false;
        }
        match &self.session {
            Some(id) => frame.pointer("/data/id").and_then(Value::as_str) == Some(id.as_str()),
            None => true,
        }
    }
}

/// `http(s)://host[:port]/base` → `ws(s)://host[:port]/base/events`.
pub fn events_url(base: &str) -> Result<String> {
    let rest = if let Some(r) = base.strip_prefix("https://") {
        format!("wss://{r}")
    } else if let Some(r) = base.strip_prefix("http://") {
        format!("ws://{r}")
    } else {
        return Err(CliError::new(
            Exit::Usage,
            format!("invalid server URL {base:?}"),
        ));
    };
    Ok(format!("{}/events", rest.trim_end_matches('/')))
}

fn ws_error(e: tungstenite::Error) -> CliError {
    match e {
        tungstenite::Error::Http(resp) => {
            let body = resp.body().as_deref().unwrap_or_default();
            from_status(resp.status().as_u16(), body_message(body), TAIL)
        }
        other => CliError::new(
            Exit::Unreachable,
            format!("cannot open the event stream: {other}"),
        ),
    }
}

async fn connect(url: &str, token: Option<&str>) -> Result<Socket> {
    let mut request = url
        .into_client_request()
        .map_err(|e| CliError::new(Exit::Usage, format!("invalid events URL: {e}")))?;
    if let Some(t) = token {
        let mut v = HeaderValue::from_str(&format!("Bearer {t}")).map_err(|_| {
            CliError::new(Exit::Usage, "the access token contains invalid characters")
        })?;
        v.set_sensitive(true);
        request.headers_mut().insert("Authorization", v);
    }
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(ws_error)?;
    Ok(socket)
}

async fn snapshot(client: &Client, filter: &Filter) -> Result<Value> {
    let (sessions, holds, git) = tokio::join!(
        list_sessions(client, TAIL),
        client.get_holds().send(),
        client.git_states().send(),
    );
    let sessions = serde_json::to_value(sessions?).unwrap_or_default();
    let holds = match holds {
        Ok(h) => serde_json::to_value(h.into_inner()).unwrap_or_default(),
        Err(e) => return Err(api_error(e, TAIL).await),
    };
    let git = match git {
        Ok(g) => serde_json::to_value(g.into_inner()).unwrap_or_default(),
        Err(e) => return Err(api_error(e, TAIL).await),
    };
    let (sessions, holds, git) = match &filter.session {
        None => (sessions, holds, git),
        Some(id) => {
            let only = |v: Value| -> Value {
                json!(
                    v.get(id)
                        .map(|x| HashMap::from([(id.clone(), x.clone())]))
                        .unwrap_or_default()
                )
            };
            let list: Vec<Value> = sessions
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str()))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            (Value::from(list), only(holds), only(git))
        }
    };
    Ok(json!({ "event": "snapshot", "data": { "sessions": sessions, "holds": holds, "git": git } }))
}

/// Why one connection's stream ended.
enum End {
    /// The server closed or dropped the socket: reconnect.
    Disconnected,
    /// stdout is gone (e.g. `| head`): stop quietly.
    OutputClosed,
}

fn emit(out: &mut dyn Write, frame: &Value) -> bool {
    writeln!(out, "{frame}").and_then(|()| out.flush()).is_ok()
}

fn parse(msg: Message) -> Option<Value> {
    match msg {
        Message::Text(t) => serde_json::from_str(t.as_str()).ok(),
        Message::Binary(b) => serde_json::from_slice(&b).ok(),
        _ => None,
    }
}

async fn stream(
    ctx: &mut Ctx<'_>,
    mut socket: Socket,
    filter: &Filter,
    with_snapshot: bool,
) -> Result<End> {
    let mut buffered = Vec::new();
    let mut open = true;
    if with_snapshot {
        let snap = snapshot(&ctx.client, filter);
        tokio::pin!(snap);
        let snap = loop {
            tokio::select! {
                s = &mut snap => break s?,
                msg = socket.next(), if open => match msg {
                    Some(Ok(m)) => buffered.extend(parse(m)),
                    Some(Err(_)) | None => open = false,
                },
            }
        };
        if !emit(&mut ctx.io.stdout, &snap) {
            return Ok(End::OutputClosed);
        }
    }
    for frame in buffered.iter().filter(|f| filter.admits(f)) {
        if !emit(&mut ctx.io.stdout, frame) {
            return Ok(End::OutputClosed);
        }
    }
    while open {
        match socket.next().await {
            Some(Ok(m)) => {
                if let Some(frame) = parse(m).filter(|f| filter.admits(f))
                    && !emit(&mut ctx.io.stdout, &frame)
                {
                    return Ok(End::OutputClosed);
                }
            }
            Some(Err(_)) | None => open = false,
        }
    }
    Ok(End::Disconnected)
}

async fn tail_loop(ctx: &mut Ctx<'_>, filter: Filter, with_snapshot: bool) -> Result<()> {
    let url = events_url(&ctx.target.url)?;
    let token = ctx.target.token.clone();
    let mut first = true;
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(&url, token.as_deref()).await {
            Ok(socket) => {
                if first && let Ok(h) = ctx.client.get_health().send().await {
                    warn_mismatch(ctx.io, &h.into_inner().version);
                }
                let connected = Instant::now();
                match stream(ctx, socket, &filter, with_snapshot).await {
                    Ok(End::OutputClosed) => return Ok(()),
                    Ok(End::Disconnected) => {
                        if connected.elapsed() >= STABLE_CONNECTION {
                            backoff = Duration::from_secs(1);
                        }
                        ctx.io.warn(&format!(
                            "event stream disconnected; reconnecting in {}s",
                            backoff.as_secs()
                        ));
                    }
                    Err(e) if first => return Err(e),
                    Err(e) => ctx.io.warn(&format!("snapshot failed: {e}; reconnecting")),
                }
            }
            Err(e) if first => return Err(e),
            Err(e) => ctx
                .io
                .warn(&format!("{e}; retrying in {}s", backoff.as_secs())),
        }
        first = false;
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

pub async fn tail(ctx: &mut Ctx<'_>, args: TailArgs) -> Result<()> {
    let session = match &args.session {
        Some(key) => Some(session_id(&ctx.client, key, TAIL).await?),
        None => None,
    };
    let filter = Filter {
        prefixes: args.events,
        session,
    };
    tokio::select! {
        r = tail_loop(ctx, filter, !args.no_snapshot) => r,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_mapping() {
        assert_eq!(
            events_url("http://127.0.0.1:7330").unwrap(),
            "ws://127.0.0.1:7330/events"
        );
        assert_eq!(
            events_url("https://box.ts.net/").unwrap(),
            "wss://box.ts.net/events"
        );
        assert!(events_url("ftp://x").is_err());
    }

    #[test]
    fn filter_rules() {
        let f = Filter {
            prefixes: vec!["session:status".into()],
            session: Some("a".into()),
        };
        assert!(f.admits(&json!({"event":"session:status","data":{"id":"a"}})));
        assert!(!f.admits(&json!({"event":"session:status","data":{"id":"b"}})));
        assert!(!f.admits(&json!({"event":"session:new","data":{"id":"a"}})));
        let all = Filter {
            prefixes: vec![],
            session: None,
        };
        assert!(all.admits(&json!({"event":"anything","data":{}})));
    }
}
