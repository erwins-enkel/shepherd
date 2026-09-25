//! `~/.config/shepherd/config.toml`: named profiles of server URL + access token.
//!
//! The path is XDG-style on every OS (not `~/Library/…` on macOS) so docs and scripts can name one
//! location. The file holds a bearer token, so it is written 0600 inside a 0700 directory.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CliError, Exit, Result};

pub const DEFAULT_URL: &str = "http://127.0.0.1:7330";
pub const DEFAULT_PROFILE: &str = "default";

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ConfigFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// `$XDG_CONFIG_HOME/shepherd/config.toml`, else `$HOME/.config/shepherd/config.toml`.
pub fn config_path(env: &HashMap<String, String>) -> Option<PathBuf> {
    let base = match env.get("XDG_CONFIG_HOME") {
        Some(x) if Path::new(x).is_absolute() => PathBuf::from(x),
        _ => PathBuf::from(env.get("HOME").filter(|h| !h.is_empty())?).join(".config"),
    };
    Some(base.join("shepherd").join("config.toml"))
}

pub fn load(path: &Path) -> Result<ConfigFile> {
    match fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| {
            CliError::new(
                Exit::Failure,
                format!("invalid config {}: {e}", path.display()),
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConfigFile::default()),
        Err(e) => Err(CliError::new(
            Exit::Failure,
            format!("cannot read config {}: {e}", path.display()),
        )),
    }
}

pub fn save(path: &Path, cfg: &ConfigFile) -> Result<()> {
    let fail = |e: std::io::Error| {
        CliError::new(
            Exit::Failure,
            format!("cannot write config {}: {e}", path.display()),
        )
    };
    let text = toml::to_string_pretty(cfg)
        .map_err(|e| CliError::new(Exit::Failure, format!("cannot encode config: {e}")))?;
    if let Some(dir) = path.parent() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(dir).map_err(fail)?;
    }
    // Write a private temp file and rename it over the config, so a failed write never leaves a
    // truncated config behind and the token is never readable at a looser mode.
    let tmp = path.with_extension("toml.tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut file = opts.open(&tmp).map_err(fail)?;
    // `mode` only applies on create: tighten a leftover temp file before the token goes into it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(fail)?;
    }
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(fail)?;
    fs::rename(&tmp, path).map_err(fail)
}

/// Where a request goes and what it carries.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub url: String,
    pub token: Option<String>,
    pub profile: String,
    /// Set when the profile's token was withheld because `--url` / `SHEPHERD_URL` pointed elsewhere.
    pub withheld_token: bool,
}

fn normalize(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

pub fn validate_url(url: &str) -> Result<String> {
    let url = normalize(url);
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url)
    } else {
        Err(CliError::new(
            Exit::Usage,
            format!("invalid server URL {url:?}: must start with http:// or https://"),
        ))
    }
}

pub fn profile_name(cfg: &ConfigFile, flag: Option<&str>) -> String {
    flag.map(str::to_string)
        .or_else(|| cfg.default_profile.clone())
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string())
}

/// URL: `--url` > `SHEPHERD_URL` > profile > default. Token: `SHEPHERD_TOKEN` > profile.
///
/// A profile's token is only sent to that profile's own URL: overriding the URL with `--url` or
/// `SHEPHERD_URL` must not leak the stored credential to a different server.
pub fn resolve(
    cfg: &ConfigFile,
    env: &HashMap<String, String>,
    url_flag: Option<&str>,
    profile_flag: Option<&str>,
) -> Result<Target> {
    let profile = profile_name(cfg, profile_flag);
    let stored = cfg.profiles.get(&profile).cloned().unwrap_or_default();
    if profile_flag.is_some() && !cfg.profiles.contains_key(&profile) {
        return Err(CliError::new(
            Exit::Usage,
            format!("unknown profile {profile:?}"),
        ));
    }
    let profile_url = validate_url(stored.url.as_deref().unwrap_or(DEFAULT_URL))?;
    let override_url = url_flag
        .map(str::to_string)
        .or_else(|| env.get("SHEPHERD_URL").filter(|u| !u.is_empty()).cloned());
    let url = match override_url {
        Some(u) => validate_url(&u)?,
        None => profile_url.clone(),
    };
    let env_token = env.get("SHEPHERD_TOKEN").filter(|t| !t.is_empty()).cloned();
    let same_server = url == profile_url;
    let withheld_token = env_token.is_none() && !same_server && stored.token.is_some();
    let token = env_token.or(if same_server { stored.token } else { None });
    Ok(Target {
        url,
        token,
        profile,
        withheld_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn cfg_with(url: Option<&str>, token: Option<&str>) -> ConfigFile {
        let mut cfg = ConfigFile::default();
        cfg.profiles.insert(
            "default".into(),
            Profile {
                url: url.map(Into::into),
                token: token.map(Into::into),
            },
        );
        cfg
    }

    #[test]
    fn path_prefers_xdg() {
        let p = config_path(&env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/h")])).unwrap();
        assert_eq!(p, PathBuf::from("/x/shepherd/config.toml"));
        let p = config_path(&env(&[("XDG_CONFIG_HOME", "rel"), ("HOME", "/h")])).unwrap();
        assert_eq!(p, PathBuf::from("/h/.config/shepherd/config.toml"));
        assert!(config_path(&env(&[])).is_none());
    }

    #[test]
    fn defaults() {
        let t = resolve(&ConfigFile::default(), &env(&[]), None, None).unwrap();
        assert_eq!(t.url, DEFAULT_URL);
        assert_eq!(t.token, None);
        assert_eq!(t.profile, "default");
    }

    #[test]
    fn precedence() {
        let cfg = cfg_with(Some("https://box.ts.net/"), Some("shp_profile"));
        let t = resolve(&cfg, &env(&[]), None, None).unwrap();
        assert_eq!(t.url, "https://box.ts.net");
        assert_eq!(t.token.as_deref(), Some("shp_profile"));

        let t = resolve(&cfg, &env(&[("SHEPHERD_TOKEN", "shp_env")]), None, None).unwrap();
        assert_eq!(t.token.as_deref(), Some("shp_env"));

        let e = env(&[("SHEPHERD_URL", "http://other:1")]);
        let t = resolve(&cfg, &e, Some("http://flag:2"), None).unwrap();
        assert_eq!(t.url, "http://flag:2");
    }

    #[test]
    fn profile_token_not_sent_elsewhere() {
        let cfg = cfg_with(None, Some("shp_profile"));
        let t = resolve(&cfg, &env(&[]), Some("http://evil:1"), None).unwrap();
        assert_eq!(t.token, None);
        assert!(t.withheld_token);
        // Same server spelled with a trailing slash still gets it.
        let t = resolve(&cfg, &env(&[]), Some("http://127.0.0.1:7330/"), None).unwrap();
        assert_eq!(t.token.as_deref(), Some("shp_profile"));
    }

    #[test]
    fn bad_url_and_unknown_profile_are_usage_errors() {
        let e = resolve(&ConfigFile::default(), &env(&[]), Some("ftp://x"), None).unwrap_err();
        assert_eq!(e.exit, Exit::Usage);
        let e = resolve(&ConfigFile::default(), &env(&[]), None, Some("nope")).unwrap_err();
        assert_eq!(e.exit, Exit::Usage);
    }

    #[test]
    fn save_is_private_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shepherd").join("config.toml");
        let cfg = cfg_with(Some("http://a:1"), Some("shp_x"));
        save(&path, &cfg).unwrap();
        assert_eq!(load(&path).unwrap(), cfg);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            save(&path, &cfg).unwrap();
            assert_eq!(mode(&path), 0o600);
        }
    }

    #[test]
    fn missing_file_is_empty_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load(&dir.path().join("none.toml")).unwrap(),
            ConfigFile::default()
        );
    }
}
