import { m } from "$lib/paraglide/messages";
import type { Session, SessionStatus, GitState } from "./types";
import { isMerging } from "./components/merge-train";

/**
 * Whether to offer a Resume control for a session: idle/done with a provider-
 * specific resume target, and the claude process verifiably gone.
 *
 * herdr ≥0.6 `agent list` exposes no per-agent command/liveness field, so a husk
 * shell and an idle-at-prompt claude are indistinguishable from its API. The
 * server fills that gap with a /proc scan (is a `claude` process still rooted in
 * the session's worktree?) pushed as `session:claude-alive` and passed in here as
 * `claudeAlive`. Only a confirmed-alive claude (`true`) hides the control;
 * `undefined` (not swept yet / older server) keeps the old offer-always behavior
 * so a husk is never left without an affordance. Running (working) / blocked
 * (awaiting input) are unambiguously live, so they're excluded regardless.
 */
export function canResume(s: Session, claudeAlive?: boolean): boolean {
  const provider = s.agentProvider ?? "claude";
  return (
    (provider === "codex" || !!s.claudeSessionId) &&
    (s.status === "idle" || s.status === "done") &&
    claudeAlive !== true
  );
}

/**
 * Whether to offer Relaunch for a session. Relaunch redoes a task from scratch with
 * corrected spawn-immutable settings and then decommissions the original — so it only
 * makes sense for a task still in flight. A *concluded* task must NOT offer it, because
 * relaunching there would spawn a duplicate and tear down the finished record:
 *   - operator-parked as done (`readyToMerge`),
 *   - autopilot judged it complete (`autopilotComplete`),
 *   - its PR has already landed (`git.state === "merged"`),
 *   - or it's mid-merge-train (`isMerging`).
 * Note an open/closed-unmerged PR or a plain idle/done status is still "in flight" — the
 * operator may legitimately redo it. The server independently 409s an already-archived
 * original; this gate is the UI affordance.
 */
export function canRelaunch(s: Session, git?: GitState, now: number = Date.now()): boolean {
  if (s.readyToMerge || s.autopilotComplete) return false;
  if (git?.state === "merged") return false;
  if (isMerging(s, now)) return false;
  return true;
}

/**
 * Whether to offer Continue with... for an in-place provider/model replacement.
 * Replacement preserves the Shepherd session/worktree/branch/issue/PR mapping, so it is valid
 * for in-flight work, including open-PR rework. It is still hidden for concluded or actively
 * merging work where starting a new agent would imply duplicating finished work.
 */
export function canReplaceAgent(s: Session, git?: GitState, now: number = Date.now()): boolean {
  if (s.status === "archived") return false;
  if (s.readyToMerge || s.autopilotComplete) return false;
  if (git?.state === "merged") return false;
  if (isMerging(s, now)) return false;
  return true;
}

/**
 * Live elapsed label for the session list, scaled so multi-day runs stay
 * readable instead of overflowing to `2880:34`:
 *   - `<1h` → `MM:SS`  (live ticking timer, seconds shown)
 *   - `<1d` → `Hh MMm` (seconds dropped once into hours)
 *   - `≥1d` → `Dd HHh`
 * Unit letters d/h/m and the `:` separator are tech notation, NOT translated
 * (same precedent as `formatAgo`). Negative/0 → "00:00".
 */
export function elapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const min = Math.floor(s / 60);
  if (min < 60) {
    return `${String(min).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `${h}h ${String(min % 60).padStart(2, "0")}m`;
  }
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

/**
 * Compact elapsed for the row heartbeat: `<60s → "{n}s"`, `<60m → "{n}m"`,
 * `<24h → "{n}h"`, else `"{n}d"`. Each unit floored; negative/0 → "0s".
 * Unit letters s/m/h/d are tech notation, NOT translated (same as `elapsed`).
 */
export function formatAgo(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Cosmetic freshness tier for the heartbeat dot: `live` (<10s), `recent` (<60s),
 * else `stale`. Drives a brightness class only — the real stall alarm lives
 * elsewhere (8min), so this never blocks or warns.
 */
export function heartbeatTone(deltaMs: number): "live" | "recent" | "stale" {
  if (deltaMs < 10_000) return "live";
  if (deltaMs < 60_000) return "recent";
  return "stale";
}

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

const compactTokenNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokenLabel(tokens: number): string {
  return m.viewport_tokens_label({ tokens: compactTokenNumber.format(Math.max(0, tokens)) });
}

/** Reset timestamp → short local label, e.g. "21:30" (today) or "Jun 6". */
export function formatReset(ts: number, nowMs: number, opts: { withTime?: boolean } = {}): string {
  const d = new Date(ts);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  if (sameDay) return d.toTimeString().slice(0, 5);
  if (opts.withTime) {
    return `${d.getDate()}.${d.getMonth() + 1}. ${d.toTimeString().slice(0, 5)}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Coarse relative countdown to a future reset timestamp, e.g. "2h", "5d".
 * Delegates to `formatAgo(ts - nowMs)`, which floors each unit and clamps
 * negative deltas to 0 — so a stale past-reset snapshot yields "0s" rather
 * than throwing. Pairs with `formatReset` (absolute) for combined display:
 * `resets in {formatResetIn(ts, nowMs)} ({formatReset(ts, nowMs)})`.
 */
export function formatResetIn(ts: number, nowMs: number): string {
  return formatAgo(ts - nowMs);
}

export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: "var(--status-running)",
  idle: "var(--status-idle)",
  blocked: "var(--status-blocked)",
  done: "var(--status-done)",
  archived: "var(--status-idle)",
};

/**
 * The WAITING/IDLE status badge is redundant noise when a review is in flight
 * (REVIEWING… already says "nothing actionable yet") OR when the autopilot badge
 * (NEEDS YOU / DELIVERED) is shown — both cases make it superfluous.
 * WORKING/BLOCKED stay visible: those are genuinely different signals.
 */
export function hideStatusBadge(
  s: SessionStatus,
  reviewing: boolean,
  autopilotShown = false,
): boolean {
  return (reviewing || autopilotShown) && (s === "done" || s === "idle");
}

/**
 * Whether the autopilot badge (NEEDS YOU / DELIVERED) is currently shown for a
 * session. Mirrors the render condition in `AutopilotBadge.svelte`
 * (`{#if session.autopilotPaused}{:else if session.autopilotComplete}`) — the
 * single source card parents consume to suppress the redundant status badge.
 *
 * IMPORTANT: if a new autopilot state is added, it MUST be reflected in BOTH
 * this helper AND `AutopilotBadge.svelte`'s render condition, or status-badge
 * suppression silently desyncs.
 *
 * Takes the repo's autopilot default so the codex-non-isolated "unavailable" state
 * can resolve the inherited-default case (autopilotEnabled === null) — see
 * codexAutopilotUnavailable.
 */
export function autopilotBadgeShown(s: Session, repoAutopilotDefault: boolean): boolean {
  return (
    s.autopilotPaused || s.autopilotComplete || codexAutopilotUnavailable(s, repoAutopilotDefault)
  );
}

/**
 * Codex autopilot stands down on non-isolated sessions (server-side `eligible()` gate:
 * an exited pane's `codex resume --last` could steer a sibling session in a shared cwd).
 * The badge surfaces that as an explicit "unavailable" state so an opted-in toggle is
 * never silently inert. Needs the repo default to catch the inherited-default-ON case
 * where the per-session override is null — mirrors `effectiveAutopilot` (override ?? default).
 *
 * Excludes research tasks: a research session's autopilot directive is suppressed at spawn
 * regardless of provider/isolation (it delivers a report-PR/issue, never code-PR-steered),
 * so "unavailable" would be misleading noise rather than a real stood-down toggle.
 */
export function codexAutopilotUnavailable(s: Session, repoAutopilotDefault: boolean): boolean {
  const on = s.autopilotEnabled ?? repoAutopilotDefault;
  return on && (s.agentProvider ?? "claude") === "codex" && !s.isolated && !s.research;
}

export function statusLabel(s: SessionStatus): string {
  switch (s) {
    case "running":
      return m.status_working();
    case "idle":
      return m.status_idle();
    case "blocked":
      return m.status_blocked();
    case "done":
      return m.status_done();
    case "archived":
      return m.status_archived();
  }
}

/**
 * Escalation tier for the TimePopover's "waiting on {who}" line — purely
 * cosmetic gamification, drives which playful message (and emoji) renders:
 * `<4h` fresh ⏳, `<1d` dozing 😴, `<3d` burning 🔥, else skeleton 💀.
 */
export function waitTier(deltaMs: number): "fresh" | "dozing" | "burning" | "skeleton" {
  if (deltaMs < 4 * 3_600_000) return "fresh";
  if (deltaMs < 24 * 3_600_000) return "dozing";
  if (deltaMs < 3 * 24 * 3_600_000) return "burning";
  return "skeleton";
}

/** Compact age like "5m", "2h", "3d", or "now" under a minute. Units are
 *  abbreviations, intentionally untranslated — same precedent as `elapsed`.
 *  Shares the m/h/d tail with `formatAgo`; only the sub-minute label differs
 *  ("now" here vs. second-granularity there, which the heartbeat needs). */
export function relativeAge(fromMs: number, nowMs: number): string {
  const delta = nowMs - fromMs;
  return delta < 60_000 ? "now" : formatAgo(delta);
}
