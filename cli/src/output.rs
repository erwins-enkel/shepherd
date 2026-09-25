//! Human tables on a TTY, JSON everywhere else.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use comfy_table::{ContentArrangement, Table, presets};
use serde::Serialize;

use crate::error::{CliError, Exit, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Human,
    Json,
}

impl Mode {
    /// `--json`, or stdout not being a terminal, selects JSON.
    pub fn pick(json_flag: bool, stdout_is_tty: bool) -> Self {
        if json_flag || !stdout_is_tty {
            Mode::Json
        } else {
            Mode::Human
        }
    }
}

fn write_failed(e: std::io::Error) -> CliError {
    CliError::new(Exit::Failure, format!("cannot write output: {e}"))
}

pub fn line(out: &mut dyn Write, text: &str) -> Result<()> {
    writeln!(out, "{text}").map_err(write_failed)
}

pub fn json(out: &mut dyn Write, value: &impl Serialize) -> Result<()> {
    let text = serde_json::to_string(value)
        .map_err(|e| CliError::new(Exit::Failure, format!("cannot encode JSON: {e}")))?;
    line(out, &text)
}

/// Below this width wrapping makes a table unreadable (and a pty with no size reports 0).
const MIN_WRAP_WIDTH: u16 = 40;

pub fn table(header: &[&str]) -> Table {
    let mut t = Table::new();
    t.load_style(presets::NOTHING).set_header(header.to_vec());
    let arrangement = match t.width() {
        Some(w) if w >= MIN_WRAP_WIDTH => ContentArrangement::Dynamic,
        _ => ContentArrangement::Disabled,
    };
    t.set_content_arrangement(arrangement);
    t
}

pub fn print_table(out: &mut dyn Write, table: &Table) -> Result<()> {
    line(out, table.to_string().trim_end())
}

/// `3m ago` style age of a millisecond epoch timestamp.
pub fn ago(epoch_ms: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    ago_at(now, epoch_ms)
}

pub fn ago_at(now_ms: i64, epoch_ms: i64) -> String {
    let secs = (now_ms - epoch_ms).max(0) / 1000;
    match secs {
        0..60 => format!("{secs}s ago"),
        60..3600 => format!("{}m ago", secs / 60),
        3600..86400 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86400),
    }
}

pub fn or_dash(v: Option<impl ToString>) -> String {
    v.map(|s| s.to_string()).unwrap_or_else(|| "-".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_pick() {
        assert_eq!(Mode::pick(false, true), Mode::Human);
        assert_eq!(Mode::pick(true, true), Mode::Json);
        assert_eq!(Mode::pick(false, false), Mode::Json);
    }

    #[test]
    fn ages() {
        assert_eq!(ago_at(10_000, 5_000), "5s ago");
        assert_eq!(ago_at(600_000, 0), "10m ago");
        assert_eq!(ago_at(7_200_000, 0), "2h ago");
        assert_eq!(ago_at(172_800_000, 0), "2d ago");
        assert_eq!(ago_at(0, 5_000), "0s ago");
    }
}
