//! The `shepherd` CLI as a library: `run` drives one invocation with all I/O injected, so tests
//! exercise the real command path in-process and a future TUI/daemon can reuse the pieces.

pub mod api;
pub mod cli;
pub mod commands;
pub mod config;
pub mod error;
pub mod output;
pub mod resolve;
#[doc(hidden)]
pub mod test_support;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

use crate::cli::{Cli, Command, EventsCmd, SessionsCmd};
use crate::config::Target;
use crate::error::{CliError, Exit, Result};
use crate::output::Mode;

pub const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Everything a command touches outside the process.
pub struct Io {
    pub stdout: Box<dyn Write + Send>,
    pub stderr: Box<dyn Write + Send>,
    pub stdin: Box<dyn Read + Send>,
    pub stdout_is_tty: bool,
    pub env: HashMap<String, String>,
    pub cwd: PathBuf,
}

impl Io {
    pub fn system() -> Self {
        Io {
            stdout: Box::new(std::io::stdout()),
            stderr: Box::new(std::io::stderr()),
            stdin: Box::new(std::io::stdin()),
            stdout_is_tty: std::io::stdout().is_terminal(),
            env: std::env::vars().collect(),
            cwd: std::env::current_dir().unwrap_or_default(),
        }
    }

    /// Best-effort stderr line; a closed stderr must not change the exit code.
    pub fn warn(&mut self, text: &str) {
        let _ = writeln!(self.stderr, "{text}");
    }

    /// Reads `value`, or all of stdin when it is `-`.
    pub fn text_arg(&mut self, value: &str) -> Result<String> {
        if value != "-" {
            return Ok(value.to_string());
        }
        let mut text = String::new();
        self.stdin
            .read_to_string(&mut text)
            .map_err(|e| CliError::new(Exit::Failure, format!("cannot read stdin: {e}")))?;
        Ok(text)
    }
}

/// One invocation's resolved context.
pub struct Ctx<'a> {
    pub io: &'a mut Io,
    pub mode: Mode,
    pub target: Target,
    pub client: api::Client,
}

pub fn http_client(target: &Target) -> Result<api::Client> {
    let mut headers = HeaderMap::new();
    if let Some(token) = &target.token {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
            CliError::new(Exit::Usage, "the access token contains invalid characters")
        })?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    let http = reqwest::Client::builder()
        .default_headers(headers)
        .user_agent(concat!("shepherd-cli/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| CliError::new(Exit::Failure, format!("cannot build HTTP client: {e}")))?;
    Ok(api::Client::new_with_client(&target.url, http))
}

/// Runs one invocation and returns its exit code.
pub async fn run<I, T>(args: I, io: &mut Io) -> i32
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) => {
            let text = e.render().to_string();
            let sink: &mut dyn Write = if e.use_stderr() {
                &mut io.stderr
            } else {
                &mut io.stdout
            };
            let _ = write!(sink, "{text}");
            return e.exit_code();
        }
    };
    match dispatch(cli, io).await {
        Ok(()) => Exit::Ok.code(),
        Err(e) => {
            io.warn(&format!("error: {e}"));
            e.exit.code()
        }
    }
}

async fn dispatch(cli: Cli, io: &mut Io) -> Result<()> {
    let mode = Mode::pick(cli.json, io.stdout_is_tty);
    if let Command::Login { token } = &cli.command {
        let token = io.text_arg(token)?;
        return commands::login::run(io, mode, cli.url.as_deref(), cli.profile.as_deref(), &token)
            .await;
    }
    let path = config::config_path(&io.env);
    let cfg = match &path {
        Some(p) => config::load(p)?,
        None => config::ConfigFile::default(),
    };
    let target = config::resolve(&cfg, &io.env, cli.url.as_deref(), cli.profile.as_deref())?;
    if target.withheld_token {
        io.warn(&format!(
            "warning: not sending profile '{}' token to {} (a different server); \
             set SHEPHERD_TOKEN to authenticate there",
            target.profile, target.url
        ));
    }
    let client = http_client(&target)?;
    let has_token = target.token.is_some();
    let url = target.url.clone();
    let mut ctx = Ctx {
        io,
        mode,
        target,
        client,
    };
    let result = match cli.command {
        Command::Sessions(SessionsCmd::List) => commands::read::sessions_list(&mut ctx).await,
        Command::Sessions(SessionsCmd::Show { session }) => {
            commands::read::sessions_show(&mut ctx, &session).await
        }
        Command::Status => commands::read::status(&mut ctx).await,
        Command::Holds => commands::read::holds(&mut ctx).await,
        Command::Git => commands::read::git(&mut ctx).await,
        Command::Reviews => commands::read::reviews(&mut ctx).await,
        Command::Events(EventsCmd::Tail(args)) => commands::events::tail(&mut ctx, args).await,
        Command::New(args) => commands::control::new(&mut ctx, args).await,
        Command::Steer { session, text } => {
            commands::control::steer(&mut ctx, &session, &text).await
        }
        Command::Interrupt { session } => commands::control::interrupt(&mut ctx, &session).await,
        Command::Archive { session } => commands::control::archive(&mut ctx, &session).await,
        Command::Resume { session, force } => {
            commands::control::resume(&mut ctx, &session, force).await
        }
        Command::Backlog => commands::intake::backlog(&mut ctx).await,
        Command::Issues(args) => commands::intake::issues(&mut ctx, args).await,
        Command::Drain(cmd) => commands::intake::drain(&mut ctx, cmd).await,
        Command::UpNext(cmd) => commands::upnext::run(&mut ctx, cmd).await,
        Command::Held(cmd) => commands::intake::held(&mut ctx, cmd).await,
        Command::ReviewPr { session } => commands::merge::review_pr(&mut ctx, &session).await,
        Command::ReviewPlan { session } => commands::merge::review_plan(&mut ctx, &session).await,
        Command::Merge(args) => commands::merge::merge(&mut ctx, args).await,
        Command::Train(cmd) => commands::merge::train(&mut ctx, cmd).await,
        Command::Login { .. } => unreachable!("handled above"),
    };
    result.map_err(|e| {
        if e.exit == Exit::Unauthenticated && !has_token {
            CliError::new(
                Exit::Unauthenticated,
                format!(
                    "no access token configured for {url}. Run `shepherd login --token <shp_…>` \
                     or set SHEPHERD_TOKEN."
                ),
            )
        } else {
            e
        }
    })
}
