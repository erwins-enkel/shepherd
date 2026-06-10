export type BlockShape = "menu" | "yes-no" | "awaiting-input" | "stall";

export interface BlockOption {
  label: string;
  /** Literal text typed into the PTY. The server appends the Enter (`\r`). */
  send: string;
}

export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  /** Last non-empty terminal lines for context; most recent last. */
  tail: string[];
}

const TAIL_LINES = 15;
// Matches "1. Yes", "❯ 2. No", "│  3) Foo" — captures the digit and the label.
const OPTION_RE = /^[\s│|]*[❯>*]?\s*(\d+)[.)]\s+(.*\S)\s*$/;
const YES_NO_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Strip ANSI + trailing whitespace, drop blank lines, keep the last `n` lines. */
export function tailLines(text: string, n = TAIL_LINES): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(ANSI_RE, "").replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

// Active-turn spinner line, anchored: the line must START with a spinner/tool
// glyph (·✢✳✶✻✽*⎿), then carry an ellipsis directly followed by "(" + either an
// elapsed-time counter or the legacy "esc to interrupt" hint, e.g.
// "✶ Bunning… (1m 13s · ↑ 1.3k tokens)" / "⎿  Running… (4s)" /
// "✻ Imagining… (esc to interrupt)". The glyph anchor rejects prose quoting a
// time mid-text ("the build finished… (3m 12s)"), queued-input lines
// ("❯ retry… (2m 30s)"), and a bare "esc to interrupt" on a non-spinner line;
// the `…(` adjacency rejects "… +5 lines (ctrl+o to expand)" and "(1M context)"
// (no elapsed time). `+` is excluded: zero occurrences as a spinner frame in
// 889 production-captured tails, and a common markdown/diff line leader. `*`
// IS a genuine production spinner frame and stays — its residual
// markdown-bullet risk is covered by the poller's freshness gate (continued
// suppression requires the buffer to advance between classify reads).
const SPINNER_RE = /^\s*[·✢✳✶✻✽*⎿].*?…\s*\((?:(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b|esc to interrupt)/i;

/**
 * True when the terminal tail shows an actively-working Claude Code turn — a
 * glyph-anchored spinner line with an elapsed-time counter or the legacy
 * "esc to interrupt" hint. Scans the same last-15-non-empty-lines window as
 * `classifyBlocked` (the spinner always sits just above the input box; this
 * avoids matching stale scrollback).
 *
 * Why this exists: herdr can latch `agent_status=blocked` after the user
 * answers a permission/elicitation dialog, reporting "blocked" for the rest
 * of the working turn. A "blocked" agent whose TUI shows a live turn spinner
 * is actually working, not waiting on the user — this is a defensive guard
 * against that upstream herdr bug.
 */
export function hasActiveSpinner(text: string): boolean {
  return tailLines(text).some((l) => SPINNER_RE.test(l));
}

/** Classify a blocked agent's terminal tail into an actionable shape. Never throws. */
export function classifyBlocked(text: string): BlockReason {
  const tail = tailLines(text);

  // Capture the last contiguous 1..n run of numbered options.
  let run: BlockOption[] = [];
  for (const line of tail) {
    const m = OPTION_RE.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === run.length + 1) run.push({ label: m[2]!, send: m[1]! });
    else if (n === 1) run = [{ label: m[2]!, send: m[1]! }];
  }
  if (run.length >= 2) return { shape: "menu", options: run, tail };

  if (tail.some((l) => YES_NO_RE.test(l))) {
    return {
      shape: "yes-no",
      options: [
        { label: "Yes", send: "y" },
        { label: "No", send: "n" },
      ],
      tail,
    };
  }

  return { shape: "awaiting-input", options: [], tail };
}
