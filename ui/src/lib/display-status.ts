import type { Session, SessionStatus } from "./types";

/** Display-side session status — the single source of truth for everything that
 *  RENDERS a status. A session herdr reports "blocked" but the server flagged as
 *  working-while-blocked (herdr's status latch after an answered dialog, surfaced
 *  via `session:working-blocked` / GET /api/working-blocked) renders with the
 *  FULL working treatment, so it upgrades blocked → running here. The flag only
 *  ever upgrades blocked — a stale entry on a non-blocked session is inert.
 *  Display-only: behavioral consumers (API actions, halt/resume gating, drain
 *  banners, autopilot) must keep reading the raw `session.status`. */
export function displayStatus(
  s: Pick<Session, "id" | "status">,
  workingBlocked: Record<string, boolean>,
): SessionStatus {
  return s.status === "blocked" && workingBlocked[s.id] ? "running" : s.status;
}
