// DRIFT: keep in sync with src/ready-stage.ts (displayStatus — same two flags, same rules).
import type { Session, SessionStatus } from "./types";

/** Display-side session status — the single source of truth for everything that
 *  RENDERS a status. Two ephemeral server flags upgrade a session to the FULL working
 *  treatment ("running"):
 *  - workingBlocked (`session:working-blocked` / GET /api/working-blocked): herdr reports
 *    "blocked" but the agent resumed mid-turn (herdr's status latch after an answered
 *    dialog) — upgrades blocked only.
 *  - backgroundBusy (`session:background-busy` / GET /api/background-busy): the session
 *    rests (idle/done) while its claude still runs a non-server background shell (e.g. a
 *    `git push` running pre-push gates) — upgrades idle/done only.
 *  Each flag is inert on any other status, so a stale entry never mis-renders.
 *  Display-only: behavioral consumers (API actions, halt/resume gating, drain
 *  banners, autopilot) must keep reading the raw `session.status`. */
export function displayStatus(
  s: Pick<Session, "id" | "status">,
  workingBlocked: Record<string, boolean>,
  backgroundBusy: Record<string, boolean> = {},
): SessionStatus {
  if (s.status === "blocked" && workingBlocked[s.id]) return "running";
  const resting = s.status === "idle" || s.status === "done";
  return resting && backgroundBusy[s.id] ? "running" : s.status;
}
