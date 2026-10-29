//! Argument grammar. Every command is non-interactive: nothing here ever prompts.

use std::num::NonZeroU64;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::api::types::{AgentProvider, Effort, EpicRunPatchMode, MergeMethod};

#[derive(Debug, Parser)]
#[command(
    name = "shepherd",
    version,
    about = "Command-line client for a Shepherd server",
    after_help = "Output is a table on a terminal and JSON otherwise (or with --json). \
                  Exit codes: 0 ok, 1 failure, 2 usage, 3 unauthenticated, 4 insufficient scope, \
                  5 not found, 6 refused, 7 unreachable, 8 server error; `wait` adds 9 timed out, \
                  10 needs-input, 11 plan-ready, 12 pr, 13 done, 14 halted."
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
pub enum SlotCmd {
    /// Run a command once the slot is free; exits 75 without running it when it must wait, else
    /// with the command's own exit code
    Run {
        /// The command, after `--`: one shell string or its words
        #[arg(last = true, required = true, value_name = "COMMAND")]
        command: Vec<String>,
    },
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
    /// Every session's cached pull-request state; with a session, also its live worktree state
    /// (base, behind/ahead, unpushed commits, dirty; needs a `full` token)
    Git {
        /// Session id or designation (TASK-07)
        session: Option<String>,
    },
    /// The session's worktree against its fork point from the base, uncommitted edits included
    /// (needs a `full` token)
    Diff {
        /// Session id or designation (TASK-07)
        session: String,
        /// Per-file added/deleted line counts instead of the patch
        #[arg(long)]
        stat: bool,
        /// Only these files or directories, relative to the worktree root
        #[arg(last = true, value_name = "PATH")]
        paths: Vec<String>,
    },
    /// Print one file from the session's worktree (needs a `full` token)
    Cat {
        /// Session id or designation (TASK-07)
        session: String,
        /// File relative to the worktree root
        path: String,
    },
    /// Critic reviews running right now
    Reviews,
    /// An agent's last messages, and whether it waits on a question (needs a `full` token)
    Messages {
        /// Session id or designation (TASK-07)
        session: String,
        /// How many of the newest messages to show (0-100)
        #[arg(short = 'n', long, default_value_t = 5, value_parser = clap::value_parser!(i64).range(0..=100))]
        limit: i64,
        /// Also show the user's and the operator's steering messages
        #[arg(long)]
        include_user: bool,
    },
    /// Stream server events
    #[command(subcommand)]
    Events(EventsCmd),
    /// Block until a session needs input, has a plan ready, has a PR, is done, or halted
    Wait(WaitArgs),
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
    /// Epics of a repo: list, inspect, and control their runs
    Epics {
        /// Repository path on the server (default: this directory's main git checkout)
        #[arg(long, global = true, value_name = "PATH")]
        repo: Option<String>,
        #[command(subcommand)]
        cmd: EpicsCmd,
    },
    /// The host-wide heavy-check slot: run tests, type checks and builds through it
    #[command(subcommand)]
    Slot(SlotCmd),
    /// Operator settings: show them, or set one
    Settings {
        #[command(subcommand)]
        cmd: Option<SettingsCmd>,
    },
    /// A repo's config: show it, or set one key
    RepoConfig {
        /// Repository path on the server (default: this directory's main git checkout)
        #[arg(long, global = true, value_name = "PATH")]
        repo: Option<String>,
        #[command(subcommand)]
        cmd: Option<RepoConfigCmd>,
    },
    /// Operator schedules: list them, add one, run one now
    #[command(subcommand)]
    Schedule(ScheduleCmd),
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
    List {
        /// Archived sessions too, after the active ones (needs a `full` token)
        #[arg(long)]
        all: bool,
    },
    /// One session
    Show {
        /// Session id or designation (TASK-07)
        session: String,
    },
}

/// `--repo`, defaulting to this directory's main git checkout.
#[derive(Debug, Args)]
pub struct RepoArg {
    /// Repository path on the server (default: this directory's main git checkout)
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
pub enum EpicsCmd {
    /// The repo's epics, with progress and run status
    List,
    /// One epic: its run and children
    Show {
        /// Parent issue number
        parent: NonZeroU64,
    },
    /// Start (or resume) an epic's run
    Start(EpicStartArgs),
    /// Pause an epic's run
    Pause {
        /// Parent issue number
        parent: NonZeroU64,
    },
    /// Stop an epic's run (back to idle)
    Stop {
        /// Parent issue number
        parent: NonZeroU64,
    },
    /// Approve the next child of an attended epic run
    ApproveNext {
        /// Parent issue number
        parent: NonZeroU64,
    },
}

#[derive(Debug, Args)]
pub struct EpicStartArgs {
    /// Parent issue number
    pub parent: NonZeroU64,
    /// `auto` drains children unattended; `attended` waits for approve-next
    #[arg(long, value_parser = parse_epic_mode)]
    pub mode: Option<EpicRunPatchMode>,
    /// Coding agent
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
pub enum ScheduleCmd {
    /// Schedules with their cadence, next firing and last run
    #[command(visible_alias = "ls")]
    List {
        /// Only this repository's schedules (path on the server; default: every repo)
        #[arg(long, value_name = "PATH")]
        repo: Option<String>,
    },
    /// Add a schedule that runs a prompt or /skill on weekdays × server-local times
    Add(ScheduleAddArgs),
    /// Fire a schedule now (even when disabled), unless its previous run is still open
    Run {
        /// Schedule id, or its exact name
        schedule: String,
        /// Look the name up in this repository only (path on the server)
        #[arg(long, value_name = "PATH")]
        repo: Option<String>,
    },
}

#[derive(Debug, Args)]
pub struct ScheduleAddArgs {
    /// Prompt or /skill to run; `-` reads it from stdin
    pub prompt: String,
    /// Schedule name (1-80 chars)
    #[arg(long)]
    pub name: String,
    /// Repository path on the server (default: this directory's main git checkout)
    #[arg(long, value_name = "PATH")]
    pub repo: Option<String>,
    /// Server-local time to fire at (repeatable, up to 12)
    #[arg(long = "at", required = true, value_name = "HH:MM", value_parser = parse_hhmm)]
    pub times: Vec<String>,
    /// Weekdays: `mon,wed,fri`, `weekdays`, `weekends` or `daily`
    #[arg(long, value_name = "DAYS", value_parser = parse_days, default_value = "daily")]
    pub days: i64,
    /// Create it disabled
    #[arg(long)]
    pub disabled: bool,
    /// Coding agent (server default when omitted)
    #[arg(long, value_parser = parse_provider)]
    pub provider: Option<AgentProvider>,
    /// Model (provider default when omitted)
    #[arg(long)]
    pub model: Option<String>,
    /// Reasoning effort
    #[arg(long, value_parser = parse_effort)]
    pub effort: Option<Effort>,
    /// Run each firing on autopilot (default: attended)
    #[arg(long)]
    pub autopilot: bool,
    /// Run the plan gate (default: the repo's setting)
    #[arg(long)]
    pub plan_gate: bool,
    /// Base branch (default: the repo's default branch when it fires)
    #[arg(long, value_name = "BRANCH")]
    pub base: Option<String>,
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
    /// Repository path on the server (default: this directory's main git checkout)
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
    /// Repository path on the server (default: this directory's main git checkout with numbers,
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
pub struct WaitArgs {
    /// Session id or designation (TASK-07)
    pub session: String,
    /// States to wait for, comma-separated (default: all of them)
    #[arg(long, value_enum, value_delimiter = ',', value_name = "STATE")]
    pub until: Vec<WaitState>,
    /// Give up after this long, e.g. 90s, 30m, 2h (exits 9). Default: wait indefinitely
    #[arg(long, value_parser = parse_timeout, value_name = "DURATION")]
    pub timeout: Option<Duration>,
}

/// A state `shepherd wait` can block on. The names and their exit codes are a public contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum WaitState {
    /// The agent or its plan gate waits on an answer
    NeedsInput,
    /// The plan gate approved the plan; `shepherd go` releases it
    PlanReady,
    /// The session has a pull request (open or merged)
    Pr,
    /// Finished: archived, its PR merged, or autopilot judged the task complete
    Done,
    /// Halted: usage limit, operator, or error
    Halted,
}

#[derive(Debug, Args)]
pub struct NewArgs {
    /// Task prompt; `-` reads it from stdin
    pub prompt: String,
    /// Repository path on the server (default: this directory's main git checkout)
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
    /// Hold the task until this task's PR has landed (id or designation, e.g. TASK-07)
    #[arg(long, value_name = "TASK")]
    pub after: Option<String>,
    /// Run it on this machine, by name or instance id (default: the server's automatic choice)
    #[arg(long, value_name = "MACHINE")]
    pub on: Option<String>,
    /// Only a machine with this capability may run it, e.g. xcode, sdk:ios, platform:macos
    /// (repeatable or comma-separated)
    #[arg(long, value_name = "CAPABILITY", value_delimiter = ',', value_parser = parse_capability)]
    pub require: Vec<String>,
}

fn parse_capability(s: &str) -> Result<String, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("expected a capability, e.g. xcode or sdk:ios".to_string());
    }
    Ok(s.to_string())
}

fn parse_effort(s: &str) -> Result<Effort, String> {
    s.parse()
        .map_err(|_| "expected one of: low, medium, high, xhigh, max, ultra".to_string())
}

fn parse_epic_mode(s: &str) -> Result<EpicRunPatchMode, String> {
    s.parse()
        .map_err(|_| "expected one of: auto, attended".to_string())
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

/// Weekday bits, bit 0 = Monday … bit 6 = Sunday, as the server stores them.
pub const WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/// `mon,wed,fri`, `weekdays`, `weekends`, `daily` (combinable) → the server's weekday bitmask.
fn parse_days(s: &str) -> Result<i64, String> {
    let invalid = || "expected comma-separated mon..sun, weekdays, weekends or daily".to_string();
    let mut mask = 0;
    for token in s.split(',') {
        let token = token.trim().to_ascii_lowercase();
        mask |= match token.as_str() {
            "weekdays" => 0b0011111,
            "weekends" => 0b1100000,
            "daily" => 0b1111111,
            day => {
                1 << WEEKDAYS
                    .iter()
                    .position(|d| *d == day)
                    .ok_or_else(invalid)?
            }
        };
    }
    Ok(mask)
}

/// `HH:MM`, 00:00-23:59, zero-padded like the server requires.
fn parse_hhmm(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let ok = b.len() == 5
        && b[2] == b':'
        && digits(0..2)
        && digits(3..5)
        && s[..2] < *"24"
        && s[3..] < *"60";
    ok.then(|| s.to_string())
        .ok_or_else(|| "expected HH:MM (00:00-23:59)".to_string())
}

/// `90`, `90s`, `30m`, `2h`, `1d`: a whole number with an optional unit (seconds when omitted).
fn parse_timeout(s: &str) -> Result<Duration, String> {
    let invalid = || "expected a whole number with an optional unit: 90s, 30m, 2h, 1d".to_string();
    let digits = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (number, unit) = s.split_at(digits);
    let n: u64 = number.parse().map_err(|_| invalid())?;
    let scale = match unit {
        "" | "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return Err(invalid()),
    };
    n.checked_mul(scale)
        .map(Duration::from_secs)
        .ok_or_else(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeouts() {
        assert_eq!(parse_timeout("90"), Ok(Duration::from_secs(90)));
        assert_eq!(parse_timeout("90s"), Ok(Duration::from_secs(90)));
        assert_eq!(parse_timeout("30m"), Ok(Duration::from_secs(1800)));
        assert_eq!(parse_timeout("2h"), Ok(Duration::from_secs(7200)));
        assert_eq!(parse_timeout("1d"), Ok(Duration::from_secs(86_400)));
        assert_eq!(parse_timeout("0"), Ok(Duration::ZERO));
        for bad in [
            "",
            "m",
            "1.5h",
            "-1",
            "10x",
            "1h30m",
            "99999999999999999999d",
        ] {
            assert!(parse_timeout(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn days() {
        assert_eq!(parse_days("daily"), Ok(127));
        assert_eq!(parse_days("weekdays"), Ok(31));
        assert_eq!(parse_days("weekends"), Ok(96));
        assert_eq!(parse_days("mon,wed,fri"), Ok(21));
        assert_eq!(parse_days("Sun, mon"), Ok(65));
        assert_eq!(parse_days("weekdays,sat"), Ok(63));
        for bad in ["", "mon,", "monday", "x"] {
            assert!(parse_days(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn hhmm() {
        for good in ["00:00", "09:30", "23:59"] {
            assert_eq!(parse_hhmm(good), Ok(good.to_string()));
        }
        for bad in ["24:00", "9:30", "09:60", "0930", "09:3a", "", "09:30 "] {
            assert!(parse_hhmm(bad).is_err(), "{bad}");
        }
    }
}
