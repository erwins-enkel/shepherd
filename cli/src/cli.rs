//! Argument grammar. Every command is non-interactive: nothing here ever prompts.

use clap::{Args, Parser, Subcommand};

use crate::api::types::{AgentProvider, Effort, MergeMethod};

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
    /// Every repo under the server's repo root, with open issue and PR counts
    Backlog,
    /// Open issues of a repo
    Issues(RepoArg),
    /// Auto-drain: status, queue, start, stop
    #[command(subcommand)]
    Drain(DrainCmd),
    /// The ranked Up Next queue, and starting items from it
    #[command(subcommand)]
    UpNext(UpNextCmd),
    /// Tasks the usage hold queued instead of spawning
    #[command(subcommand)]
    Held(HeldCmd),
    /// Run the AI critic on a session's pull request now
    ReviewPr {
        /// Session id or designation (TASK-07)
        session: String,
    },
    /// Run the plan review on a session in its plan gate
    ReviewPlan {
        /// Session id or designation (TASK-07)
        session: String,
    },
    /// Release an approved plan gate and start execution
    Go {
        /// Session id or designation (TASK-07)
        session: String,
    },
    /// Interrupt every live working agent (needs --yes)
    Halt {
        /// Confirm: halt interrupts every live working agent
        #[arg(long)]
        yes: bool,
    },
    /// Resume halted sessions (default: every session the usage limit halted)
    Retry {
        /// Sessions to retry, by id or designation (TASK-07)
        #[arg(value_name = "SESSION")]
        sessions: Vec<String>,
        /// Text to steer each session with (default: the usage-limit continue prompt)
        #[arg(long, value_name = "TEXT")]
        text: Option<String>,
    },
    /// Merge a session's pull request
    Merge(MergeArgs),
    /// Merge a repo's pull request by number (a backlog PR, with or without a session)
    MergePr(MergePrArgs),
    /// The full-auto merge train: status, start, stop, per-session override
    #[command(subcommand)]
    Train(TrainCmd),
    /// Operator settings: show them, or set one
    Settings {
        #[command(subcommand)]
        cmd: Option<SettingsCmd>,
    },
    /// A repo's config: show it, or set one key
    RepoConfig {
        /// Repository path on the server (default: this directory's git toplevel)
        #[arg(long, global = true, value_name = "PATH")]
        repo: Option<String>,
        #[command(subcommand)]
        cmd: Option<RepoConfigCmd>,
    },
    /// Environment-readiness checks, and running a check's fix
    Diagnose {
        /// Probe again instead of answering from the cached snapshot
        #[arg(long)]
        refresh: bool,
        #[command(subcommand)]
        cmd: Option<DiagnoseCmd>,
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

/// `--repo`, defaulting to this directory's git toplevel.
#[derive(Debug, Args)]
pub struct RepoArg {
    /// Repository path on the server (default: this directory's git toplevel)
    #[arg(long, value_name = "PATH")]
    pub repo: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum DrainCmd {
    /// A status per drain-enabled repo
    Status,
    /// The backlog issues waiting behind a repo's drain
    Queue(RepoArg),
    /// Turn auto-drain on for a repo
    Start(RepoArg),
    /// Turn auto-drain off for a repo
    Stop(RepoArg),
}

#[derive(Debug, Subcommand)]
pub enum SettingsCmd {
    /// Set one setting (value is a JSON literal like `true`, `80`, or plain text)
    Set {
        /// Setting name as `shepherd settings` prints it, e.g. usageHoldPct
        key: String,
        /// New value; `-` reads it from stdin (the only way to pass anthropicApiKey; `null` clears it)
        value: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum RepoConfigCmd {
    /// Set one key (value is a JSON literal like `true`, `3`, `["a.com"]`, or plain text)
    Set {
        /// Key as `shepherd repo-config` prints it, e.g. maxAuto
        key: String,
        /// New value; `""` clears a text field
        value: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum DiagnoseCmd {
    /// Run a check's fix, then print the re-probed check
    Fix {
        /// Check id as `shepherd diagnose` prints it
        check: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum UpNextCmd {
    /// Recompute and print the queue
    List,
    /// Start items from the queue (spawns agents)
    Start(UpNextStartArgs),
}

#[derive(Debug, Args)]
pub struct UpNextStartArgs {
    /// Items to start: `<repo>#<n>` (repo slug or label), or a bare `<n>` when it is unique
    #[arg(required = true, value_name = "ITEM")]
    pub items: Vec<String>,
    /// Coding agent (required with --model or --effort)
    #[arg(long, value_parser = parse_provider)]
    pub provider: Option<AgentProvider>,
    /// Model
    #[arg(long)]
    pub model: Option<String>,
    /// Reasoning effort
    #[arg(long, value_parser = parse_effort)]
    pub effort: Option<Effort>,
}

#[derive(Debug, Subcommand)]
pub enum HeldCmd {
    /// Held tasks, oldest first
    List,
    /// Spawn a held task now
    Spawn {
        /// Held task id
        id: String,
        /// Coding agent to spawn it with
        #[arg(long, value_parser = parse_provider)]
        provider: Option<AgentProvider>,
    },
    /// Drop a held task
    Discard {
        /// Held task id
        id: String,
    },
}

#[derive(Debug, Args)]
pub struct MergeArgs {
    /// Session id or designation (TASK-07)
    pub session: String,
    /// Merge method (forge default when omitted)
    #[arg(long, value_parser = parse_method)]
    pub method: Option<MergeMethod>,
    /// Keep the head branch after merging
    #[arg(long)]
    pub keep_branch: bool,
    /// Take the merge over from whoever is responsible for it (echoes the PR state to confirm)
    #[arg(long)]
    pub takeover: bool,
}

#[derive(Debug, Args)]
pub struct MergePrArgs {
    /// Pull-request number
    #[arg(value_parser = clap::value_parser!(i64).range(1..))]
    pub number: i64,
    /// Repository path on the server (default: this directory's git toplevel)
    #[arg(long, value_name = "PATH")]
    pub repo: Option<String>,
    /// Merge method (forge default when omitted)
    #[arg(long, value_parser = parse_method)]
    pub method: Option<MergeMethod>,
    /// Keep the head branch after merging
    #[arg(long)]
    pub keep_branch: bool,
    /// Take the merge over from whoever is responsible for it (echoes the PR state to confirm)
    #[arg(long)]
    pub takeover: bool,
}

#[derive(Debug, Args)]
pub struct TrainLaunchArgs {
    /// PR numbers to run the train over (default: every ready-to-merge PR)
    #[arg(value_name = "NUMBER", value_parser = clap::value_parser!(i64).range(1..))]
    pub numbers: Vec<i64>,
    /// Repository path on the server (default: this directory's git toplevel with numbers,
    /// else the repo with the most ready PRs)
    #[arg(long, value_name = "PATH")]
    pub repo: Option<String>,
    /// Base branch
    #[arg(long, value_name = "BRANCH", default_value = "main")]
    pub base: String,
}

#[derive(Debug, Subcommand)]
pub enum TrainCmd {
    /// A status per auto-merge-enabled repo
    Status,
    /// Turn full-auto merge on for a repo
    Start(RepoArg),
    /// Turn full-auto merge off for a repo
    Stop(RepoArg),
    /// Override full-auto merge for one session
    Set {
        /// Session id or designation (TASK-07)
        session: String,
        /// `on`, `off`, or `default` (follow the repo setting)
        #[arg(value_parser = parse_override)]
        value: Override,
    },
    /// Spawn an agent that works a merge train over ready (or the given) PRs
    Launch(TrainLaunchArgs),
}

/// A per-session automation override: `None` follows the repo setting.
#[derive(Clone, Copy, Debug)]
pub struct Override(pub Option<bool>);

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

fn parse_method(s: &str) -> Result<MergeMethod, String> {
    s.parse()
        .map_err(|_| "expected one of: merge, squash, rebase".to_string())
}

fn parse_override(s: &str) -> Result<Override, String> {
    match s {
        "on" => Ok(Override(Some(true))),
        "off" => Ok(Override(Some(false))),
        "default" => Ok(Override(None)),
        _ => Err("expected one of: on, off, default".to_string()),
    }
}

fn parse_provider(s: &str) -> Result<AgentProvider, String> {
    s.parse()
        .map_err(|_| "expected one of: claude, codex".to_string())
}
