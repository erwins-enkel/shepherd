//! `shepherd login --token`: validate an access token, then store it in the config file.
//!
//! The CLI cannot mint tokens — the server only mints for an interactive operator session
//! (cookie), so the operator mints one in Settings → Access and hands it over here.

use serde_json::json;

use super::list_sessions;
use crate::config::{self, Target};
use crate::error::{CliError, Exit, Op, Result, Scope};
use crate::output::{self, Mode};
use crate::{Io, http_client};

/// Every scope reaches `GET /api/sessions`, so it validates any token.
const LOGIN: Op = Op::new("login", Scope::Read);

pub async fn run(
    io: &mut Io,
    mode: Mode,
    url_flag: Option<&str>,
    profile_flag: Option<&str>,
    token: &str,
) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(CliError::new(Exit::Usage, "the token is empty"));
    }
    let path = config::config_path(&io.env).ok_or_else(|| {
        CliError::new(
            Exit::Failure,
            "cannot locate the config directory: HOME is not set",
        )
    })?;
    let mut cfg = config::load(&path)?;
    let profile = config::profile_name(&cfg, profile_flag);
    // Same precedence as every other command (`config::resolve`): `--url` > `SHEPHERD_URL` >
    // profile > default. An override is stored in the profile, so the saved token stays bound to
    // the server it was validated against.
    let override_url = config::override_url(&io.env, url_flag);
    let stored_url = cfg.profiles.get(&profile).and_then(|p| p.url.clone());
    let url = config::validate_url(
        override_url
            .as_deref()
            .or(stored_url.as_deref())
            .unwrap_or(config::DEFAULT_URL),
    )?;
    let target = Target {
        url: url.clone(),
        token: Some(token.to_string()),
        profile: profile.clone(),
        withheld_token: false,
    };
    let client = http_client(&target)?;
    list_sessions(&client, LOGIN).await?;

    let entry = cfg.profiles.entry(profile.clone()).or_default();
    entry.token = Some(token.to_string());
    if override_url.is_some() {
        entry.url = Some(url.clone());
    }
    config::save(&path, &cfg)?;

    if io.env.get("SHEPHERD_TOKEN").is_some_and(|t| !t.is_empty()) {
        io.warn("warning: SHEPHERD_TOKEN is set and overrides the stored token");
    }
    if mode == Mode::Json {
        output::json(
            &mut io.stdout,
            &json!({ "profile": profile, "url": url, "config": path }),
        )
    } else {
        output::line(
            &mut io.stdout,
            &format!(
                "logged in to {url} (profile '{profile}'); token saved to {}",
                path.display()
            ),
        )
    }
}
