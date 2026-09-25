//! Argument grammar. Every command is non-interactive: nothing here ever prompts.

use clap::{Args, Parser, Subcommand};

use crate::api::types::{AgentProvider, Effort};

#[derive(Debug, Parser)]
#[command(
    name = "shepherd",
    version,
    about = "Command-line client for a Shepherd server",
    after_help = "Output is a table on a terminal and JSON otherwise (or with --json). \
                  Exit codes: 0 ok, 1 failure, 2 usage, 3 unauthenticated, 4 insufficient scope, \
                  5 not found, 6 refused, 7 unreachable, 8 server error."
)]
pub struct Cli {
    /// Server URL (overrides SHEPHERD_URL and the profile). Default http://127.0.0.1:7330
    #[arg(long, global = true, value_name = "URL")]
    pub url: Option<String>,

    /// Config profile to use (from ~/.config/shepherd/config.toml)
    #[arg(long, global = true, value_name = "NAME")]
    pub profile: Option<String>,

    /// Print JSON (the default when stdout is not a terminal)
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// List or inspect sessions
    #[command(subcommand)]
    Sessions(SessionsCmd),
    /// Server version and a summary of the herd
    Status,
    /// Sessions parked by a hold, and why
    Holds,
    /// Every session's cached pull-request state
    Git,
    /// Critic reviews running right now
    Reviews,
    /// Stream server events
    #[command(subcommand)]
    Events(EventsCmd),
    /// Create a session (spawns an agent)
    New(NewArgs),
    /// Send text to a running session's agent (needs a `full` token)
    Steer {
        /// Session id or designation (TASK-07)
        session: String,
        /// Text to send; `-` reads it from stdin
        text: String,
    },
    /// Interrupt a session's agent
    Interrupt {
        /// Session id or designation (TASK-07)
        session: String,
    },
    /// Archive a session (stops the agent, keeps the record)
    Archive {
        /// Session id or designation (TASK-07)
        session: String,
    },
    /// Resume a finished session
    Resume {
        /// Session id or designation (TASK-07)
        session: String,
        /// Tear down a stale pane and respawn instead of adopting it
        #[arg(long)]
        force: bool,
    },
    /// Store an access token (minted in Settings → Access) in the config file
    Login {
        /// The access token (shp_…); `-` reads it from stdin, keeping it out of shell history
        #[arg(long, value_name = "TOKEN")]
        token: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum SessionsCmd {
    /// Active (non-archived) sessions
    List,
    /// One session
    Show {
        /// Session id or designation (TASK-07)
        session: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum EventsCmd {
    /// Print a snapshot, then every /events frame, as NDJSON
    Tail(TailArgs),
}

#[derive(Debug, Args)]
pub struct TailArgs {
    /// Only frames about this session (id or designation)
    #[arg(long, value_name = "SESSION")]
    pub session: Option<String>,
    /// Only events whose name starts with this prefix (repeatable), e.g. session:status
    #[arg(long = "event", value_name = "PREFIX")]
    pub events: Vec<String>,
    /// Skip the initial snapshot line
    #[arg(long)]
    pub no_snapshot: bool,
}

#[derive(Debug, Args)]
pub struct NewArgs {
    /// Task prompt; `-` reads it from stdin
    pub prompt: String,
    /// Repository path on the server (default: this directory's git toplevel)
    #[arg(long, value_name = "PATH")]
    pub repo: Option<String>,
    /// Base branch
    #[arg(long, value_name = "BRANCH", default_value = "main")]
    pub base: String,
    /// Model (provider default when omitted)
    #[arg(long)]
    pub model: Option<String>,
    /// Reasoning effort
    #[arg(long, value_parser = parse_effort)]
    pub effort: Option<Effort>,
    /// Coding agent
    #[arg(long, value_parser = parse_provider)]
    pub provider: Option<AgentProvider>,
    /// Run the pre-execution plan gate
    #[arg(long)]
    pub plan_gate: bool,
    /// Run on autopilot
    #[arg(long)]
    pub autopilot: bool,
    /// Bypass the usage hold and spawn now
    #[arg(long)]
    pub force: bool,
}

fn parse_effort(s: &str) -> Result<Effort, String> {
    s.parse()
        .map_err(|_| "expected one of: low, medium, high, xhigh, max, ultra".to_string())
}

fn parse_provider(s: &str) -> Result<AgentProvider, String> {
    s.parse()
        .map_err(|_| "expected one of: claude, codex".to_string())
}
