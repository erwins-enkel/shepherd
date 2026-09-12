import { addressStallStatus } from "./review-status";
import type { Session, ReviewVerdict, PlanGate } from "./types";

export type BlockShape = "menu" | "yes-no" | "awaiting-input" | "stall" | "quota";

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
  /** Discriminator for quota blocks: which sub-kind of quota exhaustion triggered this. */
  quotaKind?: "rework" | "review" | "error" | "plan";
  /** Full OAuth authorization URL an awaiting-input block is waiting on the operator to
   *  open (MCP auth flows, e.g. Notion/Vercel). Absent unless the transcript held a
   *  pending authorize URL. Sourced from the JSONL, not the word-wrapped PTY tail. */
  authUrl?: string;
}

const TAIL_LINES = 15;
// Matches "1. Yes", "❯ 2. No", "│  3) Foo", AND the fullscreen renderer's zero-space packing
// of the long option ("2.Yes, allow all edits…"). Group 2 captures the delimiter spacing
// (undefined when packed with no space); group 3 is the label. The zero-space form is gated
// in captureOptionRun (see below) so a decimal ("2.5 GB") or a bare-token run ("1.tsx"/"2.x")
// can't forge a menu.
const OPTION_RE = /^[\s│|]*[❯>*]?\s*(\d+)[.)](\s+)?(\S.*?)\s*$/;
const YES_NO_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]/i;
// ── Dialog chrome: the two marks a RENDERED menu carries and PRINTED prose does not (#2281) ──
// A numbered run alone is not evidence of a dialog — an agent writing a recap as "1. … 2. …"
// produces the same shape, so a menu must additionally carry one of these.
//
// Measured over the live corpus (4226 captured block tails, 2791 of them classified `menu` before
// this gate): 2708 carry the caret, 2554 the footer, 2776 at least one — so both halves are
// load-bearing (222 caret-only, 68 footer-only). Of the 15 chrome-less rows, 13 are prose
// forgeries and 2 are real dialogs caught mid-paint. NO row carries chrome AND a live spinner,
// which is why a genuine dialog still surfaces spinner or not.
//
// Selected-option caret. `*` is deliberately NOT in the caret set even though OPTION_RE accepts
// it as an option marker: it is also the markdown bullet leader (same reasoning that keeps `+`
// out of SPINNER_RE), and a bulleted numbered list is exactly the prose this guards against.
const CARET_OPTION_RE = /^[\s│|]*[❯>]\s*\d+[.)]/;
// Key-hint footer, as a substring of the (·-separated, often word-wrapped) hint line. Matched on
// the stable fragments rather than a whole wording: the live corpus carries at least a dozen
// variants, most of them truncated mid-line by the pane width ("Enter to select · ↑/↓ to
// navigate · n to add notes · Tab to").
const DIALOG_FOOTER_RE =
  /enter to (?:select|confirm)|esc to cancel|(?:↑\/↓|arrow keys) to navigate/i;
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

// The at-rest input box's queued-input hint. Claude Code 2.1.266 ships three
// wordings — "Press up to edit queued messages", "Press up to select a queued
// message" and "…select a queued message to edit" — so the match is anchored on
// the stable "press up to <verb> … queued message" spine rather than one string.
const QUEUED_INPUT_RE = /press up to \w+\s+(?:a\s+)?queued message/i;

/**
 * True when the terminal tail shows the agent's at-rest input box carrying
 * QUEUED operator input. A session holding input it has not consumed yet cannot
 * be waiting for more, so an `awaiting-input` fallback over such a buffer is a
 * false "needs you" (issue #2272). Scans the same last-15-non-empty-lines window
 * as `classifyBlocked` (the hint sits just above the footer), so the phrase
 * appearing in older scrollback cannot forge it.
 *
 * Why this exists: herdr latches `agent_status=blocked` after an answered dialog
 * — the same upstream bug `hasActiveSpinner` guards against — but the spinner is
 * not on screen yet, so the latch falls through to the no-evidence
 * `awaiting-input` fallback. Measured on a live install: of 1432 captured
 * `awaiting-input` block rows NONE carried a spinner, while every full-screen
 * capture of the false positive carried this hint.
 */
export function hasQueuedInput(text: string): boolean {
  return tailLines(text).some((l) => QUEUED_INPUT_RE.test(l));
}

/** The last contiguous 1..n run of numbered options in `tail` (empty when there is none). */
function captureOptionRun(tail: string[]): BlockOption[] {
  let run: BlockOption[] = [];
  for (const line of tail) {
    const m = OPTION_RE.exec(line);
    if (!m) continue;
    const [, num, spaced, label] = m;
    // Fullscreen drops the delimiter space ONLY on the long, wrapping option
    // ("2.Yes, allow all edits…"); short options keep theirs. Accept a zero-space option
    // ONLY when its label is a non-digit-leading multi-token phrase, so a decimal
    // ("2.5 GB" → "5 GB") or a bare-token run ("1.tsx"/"2.x"/"1.txt") can't forge a menu.
    if (!spaced && (/^\d/.test(label!) || !/\s/.test(label!))) continue;
    const n = Number(num);
    if (n === run.length + 1) run.push({ label: label!, send: num! });
    else if (n === 1) run = [{ label: label!, send: num! }];
  }
  return run;
}

/** True when `tail` carries a mark only a RENDERED dialog has: a caret on one of its numbered
 *  options, or the key-hint footer. Scans the same window as the option run it qualifies. */
function hasDialogChrome(tail: string[]): boolean {
  return tail.some((l) => CARET_OPTION_RE.test(l) || DIALOG_FOOTER_RE.test(l));
}

/**
 * True when `tail` is the shape `classifyBlocked` DEMOTED: a numbered option run with no dialog
 * chrome, classified `awaiting-input` rather than `menu` (#2281).
 *
 * Consumed by `AutopilotService.onBlock` (src/autopilot.ts), whose `STEERABLE_SHAPES` includes
 * `awaiting-input`: steering types text + Enter into the pane, and if the buffer is a real dialog
 * caught mid-paint that Enter answers its highlighted option. Autopilot therefore stands these
 * down and lets them surface, exactly as it does a `menu`.
 *
 * Re-derived over the same `tail` array the block carries (`BlockReason.tail`, i.e. what
 * `classifyBlocked` classified), so it agrees with the demotion by construction.
 */
export function looksLikeDemotedMenu(tail: string[]): boolean {
  return captureOptionRun(tail).length >= 2 && !hasDialogChrome(tail);
}

/**
 * Classify a blocked agent's terminal tail into an actionable shape. Never throws.
 *
 * A `menu` needs BOTH a contiguous 1..n option run AND dialog chrome (#2281). The run alone is
 * prose an agent printed as often as a dialog the CLI rendered, and a forged menu is worse than a
 * stale card: its options are clickable and type `1`/`2` into a PTY that may be mid-turn. A
 * chrome-less run degrades to `awaiting-input`, where the poller's spinner / queued-input
 * suppression (src/poller.ts → `suppressAwaitingInput`) applies.
 *
 * The cost is bounded and self-correcting: a real dialog read MID-PAINT, before its caret or
 * footer has landed, shows as `awaiting-input` for one `reclassifyMs` cadence and upgrades to a
 * `menu` with its options on the next read.
 */
export function classifyBlocked(text: string): BlockReason {
  const tail = tailLines(text);

  const run = captureOptionRun(tail);
  if (run.length >= 2 && hasDialogChrome(tail)) return { shape: "menu", options: run, tail };

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

/**
 * Pure detector: decides whether an idle session is quota-exhausted and which kind.
 * Returns a `BlockReason` of `shape: "quota"` with the matching `quotaKind` and
 * `tail` set to the relevant findings array, or `null` when not exhausted.
 */
export function quotaBlockReason(
  session: Session,
  review: ReviewVerdict | null,
  gate: PlanGate | null,
  now: number,
): BlockReason | null {
  // Guard: running session is still working — never fire prematurely.
  if (session.status === "running") return null;

  // Plan gate (pre-execution domain): check first. The plan-gate quota is a pre-execution
  // concern; outside the plan phase the retained gate is inert.
  if (
    gate !== null &&
    session.planPhase === "planning" &&
    gate.decision === "changes_requested" &&
    gate.round >= gate.cap
  ) {
    return { shape: "quota", quotaKind: "plan", options: [], tail: gate.findings };
  }

  // Critic cases (only when no plan match), in precedence order.
  if (review !== null) {
    // Error ceiling: critic can't produce a real verdict.
    if (review.errorRound >= review.addressCap) {
      return { shape: "quota", quotaKind: "error", options: [], tail: review.findings };
    }
    // Review ceiling: reviewed 2*cap times without ever going clean.
    if (review.streakReviews >= 2 * review.addressCap) {
      return { shape: "quota", quotaKind: "review", options: [], tail: review.findings };
    }
    // Rework stall: auto-address held at cap.
    if (addressStallStatus(review, now) === "stalled") {
      return { shape: "quota", quotaKind: "rework", options: [], tail: review.findings };
    }
  }

  return null;
}
