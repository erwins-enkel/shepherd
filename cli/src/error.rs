//! Stable exit codes and the mapping from HTTP/transport failures to them.
//!
//! The codes are a public contract (docs/cli.md): agents branch on them, so never renumber one.

use std::fmt;

/// Process exit codes. Documented in docs/cli.md; append only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Ok = 0,
    Failure = 1,
    Usage = 2,
    Unauthenticated = 3,
    InsufficientScope = 4,
    NotFound = 5,
    Refused = 6,
    Unreachable = 7,
    Server = 8,
}

impl Exit {
    pub fn code(self) -> i32 {
        self as i32
    }
}

/// A token scope, mirroring `TOKEN_SCOPES` in src/token-scopes.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Read,
    Submit,
    Full,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Submit => "submit",
            Scope::Full => "full",
        }
    }
}

/// What a request was for: names the verb and the scope its route needs in error messages.
///
/// The server's 403 body is the fixed string `insufficient_scope` and never names the level, so
/// the CLI carries its own copy of the per-route table (src/token-scopes.ts) through `scope`.
#[derive(Clone, Copy, Debug)]
pub struct Op {
    pub verb: &'static str,
    pub scope: Scope,
}

impl Op {
    pub const fn new(verb: &'static str, scope: Scope) -> Self {
        Op { verb, scope }
    }
}

#[derive(Debug)]
pub struct CliError {
    pub exit: Exit,
    pub message: String,
}

impl CliError {
    pub fn new(exit: Exit, message: impl Into<String>) -> Self {
        CliError {
            exit,
            message: message.into(),
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Result<T> = std::result::Result<T, CliError>;

/// Extracts `error` (and `code`) from a JSON error body; falls back to the raw text.
pub fn body_message(body: &[u8]) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) {
        let error = v.get("error").and_then(|e| e.as_str());
        let code = v.get("code").and_then(|c| c.as_str());
        return match (error, code) {
            (Some(e), Some(c)) if e != c => Some(format!("{e} ({c})")),
            (Some(e), _) => Some(e.to_string()),
            (None, Some(c)) => Some(c.to_string()),
            (None, None) => Some(v.to_string()),
        };
    }
    let text = String::from_utf8_lossy(body).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Maps a non-success HTTP status (plus its decoded body message) to a CLI error.
pub fn from_status(status: u16, message: Option<String>, op: Op) -> CliError {
    let detail = message.clone().unwrap_or_else(|| format!("HTTP {status}"));
    match status {
        401 => CliError::new(
            Exit::Unauthenticated,
            format!(
                "unauthorized: the server rejected the credential ({detail}). \
                 Run `shepherd login --token <shp_…>` or set SHEPHERD_TOKEN."
            ),
        ),
        403 if message.as_deref() == Some("insufficient_scope") => CliError::new(
            Exit::InsufficientScope,
            format!(
                "`shepherd {}` needs a '{}' token; this token's scope does not include it. \
                 Mint one in Settings → Access.",
                op.verb,
                op.scope.as_str()
            ),
        ),
        404 if detail.eq_ignore_ascii_case("not found") => CliError::new(Exit::NotFound, detail),
        404 => CliError::new(Exit::NotFound, format!("not found: {detail}")),
        400 | 403 | 409 | 415 | 422 => {
            CliError::new(Exit::Refused, format!("refused ({status}): {detail}"))
        }
        500..=599 => CliError::new(Exit::Server, format!("server error ({status}): {detail}")),
        _ => CliError::new(Exit::Failure, format!("unexpected HTTP {status}: {detail}")),
    }
}

/// A body type a generated error response may carry.
pub trait ErrorBody {
    fn message(&self) -> Option<String>;
}

impl ErrorBody for () {
    fn message(&self) -> Option<String> {
        None
    }
}

impl ErrorBody for crate::api::types::Error {
    fn message(&self) -> Option<String> {
        match &self.code {
            Some(code) if code != &self.error => Some(format!("{} ({code})", self.error)),
            _ => Some(self.error.clone()),
        }
    }
}

fn transport(e: &reqwest::Error) -> CliError {
    let mut msg = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    CliError::new(Exit::Unreachable, format!("cannot reach the server: {msg}"))
}

/// Maps a generated-client error to a CLI error.
pub async fn api_error<E: ErrorBody>(err: progenitor_client::Error<E>, op: Op) -> CliError {
    use progenitor_client::Error as E2;
    match err {
        E2::ErrorResponse(rv) => {
            let status = rv.status().as_u16();
            from_status(status, rv.into_inner().message(), op)
        }
        E2::UnexpectedResponse(resp) => {
            let status = resp.status().as_u16();
            let body = resp.bytes().await.unwrap_or_default();
            from_status(status, body_message(&body), op)
        }
        E2::CommunicationError(e) | E2::InvalidUpgrade(e) => transport(&e),
        E2::ResponseBodyError(e) => {
            CliError::new(Exit::Server, format!("could not read the response: {e}"))
        }
        E2::InvalidResponsePayload(_, e) => CliError::new(
            Exit::Server,
            format!("the server answered a payload this CLI cannot decode: {e}"),
        ),
        E2::InvalidRequest(m) | E2::Custom(m) => CliError::new(Exit::Failure, m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OP: Op = Op::new("steer", Scope::Full);

    #[test]
    fn scope_403_names_verb_and_scope() {
        let e = from_status(403, Some("insufficient_scope".into()), OP);
        assert_eq!(e.exit, Exit::InsufficientScope);
        assert!(e.message.contains("`shepherd steer` needs a 'full' token"));
    }

    #[test]
    fn other_403_is_refused() {
        let e = from_status(403, Some("forbidden: origin not allowed".into()), OP);
        assert_eq!(e.exit, Exit::Refused);
    }

    #[test]
    fn status_table() {
        let cases = [
            (401, Exit::Unauthenticated),
            (404, Exit::NotFound),
            (400, Exit::Refused),
            (409, Exit::Refused),
            (415, Exit::Refused),
            (422, Exit::Refused),
            (500, Exit::Server),
            (502, Exit::Server),
            (418, Exit::Failure),
        ];
        for (status, exit) in cases {
            assert_eq!(from_status(status, None, OP).exit, exit, "{status}");
        }
    }

    #[test]
    fn exit_codes_are_stable() {
        let codes = [
            Exit::Ok,
            Exit::Failure,
            Exit::Usage,
            Exit::Unauthenticated,
            Exit::InsufficientScope,
            Exit::NotFound,
            Exit::Refused,
            Exit::Unreachable,
            Exit::Server,
        ]
        .map(Exit::code);
        assert_eq!(codes, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn body_message_forms() {
        assert_eq!(
            body_message(br#"{"error":"nope"}"#).as_deref(),
            Some("nope")
        );
        assert_eq!(
            body_message(br#"{"error":"taken","code":"name_taken"}"#).as_deref(),
            Some("taken (name_taken)")
        );
        assert_eq!(body_message(b"plain text\n").as_deref(), Some("plain text"));
        assert_eq!(body_message(b""), None);
    }
}
