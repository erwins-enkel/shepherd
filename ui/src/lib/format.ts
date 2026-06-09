import { m } from "$lib/paraglide/messages";
import type { Session, SessionStatus } from "./types";

/**
 * Whether to offer a Resume control for a session. True for any idle/done session
 * with a pinned claude id — deliberately ALL of them, not just husks.
 *
 * We'd love to show it only when claude has actually exited to a bare shell, but
 * herdr ≥0.6 `agent list` exposes no per-agent command/liveness field (just
 * agent_status/name/cwd), so a husk shell and an idle-at-prompt claude are
 * indistinguishable from the API, and scraping the TUI is fragile (stale
 * scrollback fools it). So the control is a user-initiated escape hatch shown
 * whenever it *could* be needed; a user looking at a live claude pane has no
 * reason to click it. Running (working) / blocked (awaiting input) are
 * unambiguously live, so they're excluded.
 */
export function canResume(s: Session): boolean {
  return !!s.claudeSessionId && (s.status === "idle" || s.status === "done");
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

/** Reset timestamp → short local label, e.g. "21:30" (today) or "Jun 6". */
export function formatReset(ts: number, nowMs: number): string {
  const d = new Date(ts);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  return sameDay
    ? d.toTimeString().slice(0, 5)
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: "var(--status-running)",
  idle: "var(--status-idle)",
  blocked: "var(--status-blocked)",
  done: "var(--status-done)",
  archived: "var(--status-idle)",
};

/**
 * While a review is in flight, the WAITING/IDLE status badge is redundant noise
 * next to REVIEWING… — both just say "nothing actionable yet". Hide it then.
 * WORKING/BLOCKED stay visible: those are genuinely different signals.
 */
export function hideStatusBadge(s: SessionStatus, reviewing: boolean): boolean {
  return reviewing && (s === "done" || s === "idle");
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

/** Compact age like "5m", "2h", "3d", or "now" under a minute. Units are
 *  abbreviations, intentionally untranslated — same precedent as `elapsed`.
 *  Shares the m/h/d tail with `formatAgo`; only the sub-minute label differs
 *  ("now" here vs. second-granularity there, which the heartbeat needs). */
export function relativeAge(fromMs: number, nowMs: number): string {
  const delta = nowMs - fromMs;
  return delta < 60_000 ? "now" : formatAgo(delta);
}
