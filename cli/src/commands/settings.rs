//! Settings and diagnostics: `settings …`, `repo-config …`, `diagnose …`.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::{VersionCheck, print_done, repo_path};
use crate::Ctx;
use crate::api::types::{
    DiagnosticsSnapshot, RepoConfig, RepoConfigPatch, SettingsPatch, SettingsPatchResult,
};
use crate::api::{Client, ClientInfo};
use crate::cli::{DiagnoseCmd, RepoConfigCmd, SettingsCmd};
use crate::error::{
    CliError, Exit, Op, Result, Scope, api_error, body_message, from_status, transport,
};
use crate::output::{self, Mode, or_dash};

const SETTINGS: Op = Op::new("settings", Scope::Full);
const SETTINGS_SET: Op = Op::new("settings set", Scope::Full);
const REPO_CONFIG: Op = Op::new("repo-config", Scope::Full);
const REPO_CONFIG_SET: Op = Op::new("repo-config set", Scope::Full);
const DIAGNOSE: Op = Op::new("diagnose", Scope::Full);
const DIAGNOSE_FIX: Op = Op::new("diagnose fix", Scope::Full);

/// The one setting that is a secret: it may only arrive on stdin.
const SECRET_KEY: &str = "anthropicApiKey";

fn usage(message: String) -> CliError {
    CliError::new(Exit::Usage, message)
}

/// Builds a one-key patch body `{key: value}`, validated client-side against the generated type
/// `T` (`deny_unknown_fields`, typed fields). `raw` is tried as a JSON literal first (`true`,
/// `80`, `["a"]`, `null`), then as plain text, so `defaultModel opus` needs no quoting.
///
/// Returns the JSON body, not `T`: re-serializing `T` would drop what typify skips (`null` on an
/// optional field, an empty list), and the server reads both as "clear".
pub fn parse_patch<T: DeserializeOwned>(key: &str, raw: &str) -> Result<Value> {
    let literal = serde_json::from_str::<Value>(raw).ok();
    let mut last = None;
    for value in literal.into_iter().chain([Value::String(raw.to_string())]) {
        let mut body = Map::new();
        body.insert(key.to_string(), value);
        let body = Value::Object(body);
        match T::deserialize(&body) {
            Ok(_) => return Ok(body),
            Err(e) => last = Some(e),
        }
    }
    let err = last.map(|e| e.to_string()).unwrap_or_default();
    if err.starts_with("unknown field") {
        return Err(usage(format!("unknown key `{key}`")));
    }
    Err(usage(format!("invalid value for `{key}`: {err}")))
}

/// Sends a validated patch body verbatim and decodes the answer as `R`. The generated builders
/// only take the typed body, which loses `null` and `[]` (see `parse_patch`), so this one request
/// goes through the generated client's own HTTP client (same base URL, token and timeouts).
async fn send_patch<R: DeserializeOwned>(
    client: &Client,
    method: reqwest::Method,
    path: &str,
    query: &[(&str, &str)],
    body: &Value,
    op: Op,
) -> Result<R> {
    let url = format!("{}{path}", client.baseurl());
    let resp = client
        .client()
        .request(method, url)
        .query(query)
        .json(body)
        .send()
        .await
        .map_err(|e| transport(&e))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CliError::new(Exit::Server, format!("could not read the response: {e}")))?;
    if !status.is_success() {
        return Err(from_status(status.as_u16(), body_message(&bytes), op));
    }
    serde_json::from_slice(&bytes).map_err(|e| {
        CliError::new(
            Exit::Server,
            format!("the server answered a payload this CLI cannot decode: {e}"),
        )
    })
}

/// One KEY/VALUE row per top-level field, sorted by key; nested values as compact JSON.
fn print_kv(ctx: &mut Ctx<'_>, value: &impl Serialize) -> Result<()> {
    let Ok(Value::Object(map)) = serde_json::to_value(value) else {
        return output::json(&mut ctx.io.stdout, value);
    };
    let mut rows: Vec<_> = map.into_iter().collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let mut t = output::table(&["KEY", "VALUE"]);
    for (k, v) in rows {
        t.add_row(vec![k, cell(v)]);
    }
    output::print_table(&mut ctx.io.stdout, &t)
}

fn print_payload(ctx: &mut Ctx<'_>, value: &impl Serialize) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, value);
    }
    print_kv(ctx, value)
}

/// `key = value` of the one field a patch result echoes, for the terminal line.
fn echoed(result: &impl Serialize, key: &str) -> String {
    serde_json::to_value(result)
        .ok()
        .and_then(|v| v.get(key).cloned())
        .map(cell)
        .unwrap_or_else(|| "-".into())
}

/// A value as table text: strings bare, whole numbers without the `.0` the schema's f64 adds.
fn cell(v: Value) -> String {
    match v {
        Value::String(s) => s,
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

pub async fn settings(ctx: &mut Ctx<'_>, cmd: Option<SettingsCmd>) -> Result<()> {
    match cmd {
        None => settings_show(ctx).await,
        Some(SettingsCmd::Set { key, value }) => settings_set(ctx, &key, &value).await,
    }
}

async fn settings_show(ctx: &mut Ctx<'_>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let payload = match ctx.client.get_settings().send().await {
        Ok(p) => p.into_inner(),
        Err(e) => return Err(api_error(e, SETTINGS).await),
    };
    print_payload(ctx, &payload)?;
    check.finish(ctx.io).await;
    Ok(())
}

async fn settings_set(ctx: &mut Ctx<'_>, key: &str, value: &str) -> Result<()> {
    let body = if key == SECRET_KEY {
        secret_body(ctx, value)?
    } else {
        let value = ctx.io.text_arg(value)?;
        parse_patch::<SettingsPatch>(key, value.trim_end_matches(['\r', '\n']))?
    };
    let check = VersionCheck::start(&ctx.client);
    let result: SettingsPatchResult = send_patch(
        &ctx.client,
        reqwest::Method::PATCH,
        "/api/settings",
        &[],
        &body,
        SETTINGS_SET,
    )
    .await?;
    let text = if key == SECRET_KEY {
        // Worded from the server's answer, never from what was sent.
        match result.has_api_key {
            Some(true) => format!("set {key} (stored)"),
            _ => format!("cleared {key}"),
        }
    } else {
        format!("set {key} = {}", echoed(&result, key))
    };
    print_done(ctx, &result, &text)?;
    check.finish(ctx.io).await;
    Ok(())
}

/// The API key's patch body. The key itself only arrives on stdin (`-`), and must be non-blank:
/// the server reads a blank key as "clear", so an empty pipe would silently delete it. Clearing
/// is its own explicit literal, `null`.
fn secret_body(ctx: &mut Ctx<'_>, value: &str) -> Result<Value> {
    let key = match value {
        "null" => return parse_patch::<SettingsPatch>(SECRET_KEY, "null"),
        "-" => ctx.io.text_arg(value)?.trim().to_string(),
        _ => {
            return Err(usage(format!(
                "`{SECRET_KEY}` is only read from stdin, to keep it out of shell history: \
                 pass `-` and pipe the key in (or `null` to clear it)"
            )));
        }
    };
    if key.is_empty() {
        return Err(usage(format!(
            "stdin was empty: no `{SECRET_KEY}` to store (pass `null` to clear it)"
        )));
    }
    // Always text: never let the secret be read as a JSON literal.
    parse_patch::<SettingsPatch>(SECRET_KEY, &Value::String(key).to_string())
}

pub async fn repo_config(
    ctx: &mut Ctx<'_>,
    repo: Option<String>,
    cmd: Option<RepoConfigCmd>,
) -> Result<()> {
    let repo = repo_path(ctx, repo)?;
    match cmd {
        None => repo_config_show(ctx, repo).await,
        Some(RepoConfigCmd::Set { key, value }) => repo_config_set(ctx, repo, &key, &value).await,
    }
}

async fn repo_config_show(ctx: &mut Ctx<'_>, repo: String) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    let cfg = match ctx.client.get_repo_config().repo(repo).send().await {
        Ok(c) => c.into_inner(),
        Err(e) => return Err(api_error(e, REPO_CONFIG).await),
    };
    print_payload(ctx, &cfg)?;
    check.finish(ctx.io).await;
    Ok(())
}

async fn repo_config_set(ctx: &mut Ctx<'_>, repo: String, key: &str, value: &str) -> Result<()> {
    let body = parse_patch::<RepoConfigPatch>(key, value)?;
    let check = VersionCheck::start(&ctx.client);
    let query = [("repo", repo.as_str())];
    let cfg: RepoConfig = send_patch(
        &ctx.client,
        reqwest::Method::PUT,
        "/api/repo-config",
        &query,
        &body,
        REPO_CONFIG_SET,
    )
    .await?;
    let text = format!("set {key} = {} for {repo}", echoed(&cfg, key));
    print_done(ctx, &cfg, &text)?;
    check.finish(ctx.io).await;
    Ok(())
}

pub async fn diagnose(ctx: &mut Ctx<'_>, refresh: bool, cmd: Option<DiagnoseCmd>) -> Result<()> {
    let check = VersionCheck::start(&ctx.client);
    match cmd {
        None => {
            let mut req = ctx.client.get_diagnostics();
            if refresh {
                req = req.refresh("1");
            }
            let snapshot = match req.send().await {
                Ok(s) => s.into_inner(),
                Err(e) => return Err(api_error(e, DIAGNOSE).await),
            };
            print_snapshot(ctx, &snapshot, None)?;
        }
        Some(DiagnoseCmd::Fix { check: id }) => {
            let result = ctx
                .client
                .fix_diagnostics()
                .body_map(|b| b.check_id(id.clone()))
                .send()
                .await;
            let snapshot = match result {
                Ok(s) => s.into_inner(),
                Err(e) => return Err(api_error(e, DIAGNOSE_FIX).await),
            };
            print_snapshot(ctx, &snapshot, Some(&id))?;
        }
    }
    check.finish(ctx.io).await;
    Ok(())
}

/// The snapshot as JSON, or a table (only `only`'s row after a fix) and the overall state.
fn print_snapshot(
    ctx: &mut Ctx<'_>,
    snapshot: &DiagnosticsSnapshot,
    only: Option<&str>,
) -> Result<()> {
    if ctx.mode == Mode::Json {
        return output::json(&mut ctx.io.stdout, snapshot);
    }
    let mut t = output::table(&["ID", "STATE", "HINT", "FIX"]);
    for c in snapshot
        .checks
        .iter()
        .filter(|c| only.is_none_or(|id| c.id == id))
    {
        t.add_row(vec![
            c.id.clone(),
            c.state.to_string(),
            c.hint_key.clone(),
            or_dash(c.remediation.as_ref().or(c.fix_action_key.as_ref())),
        ]);
    }
    output::print_table(&mut ctx.io.stdout, &t)?;
    output::line(
        &mut ctx.io.stdout,
        &format!("overall: {}", snapshot.overall),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_literals_then_text() {
        let p = |k: &str, v: &str| parse_patch::<SettingsPatch>(k, v).unwrap();
        assert_eq!(p("usageHoldPct", "80"), json!({"usageHoldPct": 80}));
        assert_eq!(p("tuiFullscreen", "true"), json!({"tuiFullscreen": true}));
        assert_eq!(p("defaultModel", "opus"), json!({"defaultModel": "opus"}));
        // A text key given something JSON-shaped still reads as text.
        assert_eq!(p("defaultModel", "123"), json!({"defaultModel": "123"}));
        let r = |k: &str, v: &str| parse_patch::<RepoConfigPatch>(k, v).unwrap();
        assert_eq!(
            r("egressExtraHosts", r#"["a.com"]"#),
            json!({"egressExtraHosts": ["a.com"]})
        );
        // What the typed struct would drop on re-serialization survives: the server clears on it.
        assert_eq!(r("egressExtraHosts", "[]"), json!({"egressExtraHosts": []}));
        assert_eq!(
            r("previewStartCommand", "null"),
            json!({"previewStartCommand": null})
        );
    }

    #[test]
    fn cells_drop_the_float_suffix() {
        assert_eq!(cell(serde_json::json!(3.0)), "3");
        assert_eq!(cell(serde_json::json!(2.5)), "2.5");
        assert_eq!(cell(serde_json::json!("x")), "x");
        assert_eq!(cell(serde_json::json!(["a"])), r#"["a"]"#);
    }

    #[test]
    fn refuses_unknown_keys_and_bad_values() {
        let e = parse_patch::<SettingsPatch>("nope", "1").unwrap_err();
        assert_eq!(e.exit, Exit::Usage);
        assert_eq!(e.message, "unknown key `nope`");
        let e = parse_patch::<SettingsPatch>("usageHoldPct", "lots").unwrap_err();
        assert!(
            e.message.starts_with("invalid value for `usageHoldPct`"),
            "{}",
            e.message
        );
        let e = parse_patch::<RepoConfigPatch>("egressExtraHosts", "").unwrap_err();
        assert!(
            e.message
                .starts_with("invalid value for `egressExtraHosts`"),
            "{}",
            e.message
        );
    }
}
