// Cold-resume marker (#2042) — the one place that decides whether a session is expensive to
// resume, shared by the Herd row (where the operator CHOOSES a session) and the status bar (where
// they are already in one). Two surfaces reading two copies of this rule would eventually disagree
// about the same session, so both call `isColdResume`.
//
// The server does the pricing: `ui/` has no copy of the model weight table and the two trees don't
// share a build. What arrives is a cost in weighted units plus `coldResumeAt`, an ABSOLUTE instant.
// The client only compares that instant against a clock it already ticks, which is why the marker
// appears the moment the cache expires rather than on the next poll.

import type { Session } from "./types";

/**
 * Estimated resume cost below which the marker stays silent.
 *
 * A cost floor, not a token count, because the same context is worth very different money per
 * model: 150k tokens is 1.27 units on Opus but 0.25 on Haiku. A token threshold would nag about
 * the cheap one and stay quiet about a genuinely expensive smaller session.
 *
 * At 0.5 units the marker fires from roughly 73k context on Opus, 106k on Sonnet — about half of
 * parked sessions in the sampled corpus. Warnings that fire on everything stop being read.
 */
const COLD_RESUME_MIN_UNITS = 0.5;

/**
 * Is resuming this session expensive enough to warn about, as of `now`?
 *
 * Four conditions, all required:
 *  - a reading exists (the session parked with a priceable transcript — never true for Codex);
 *  - the cache has actually expired;
 *  - the resume costs more than the floor;
 *  - the session is PARKED. A running session is warm by definition, and its stored reading is
 *    cleared server-side on the resume edge — this is the backstop for a reading stranded by a
 *    crash between the park and resume edges, which would otherwise sit permanently in the past
 *    and pin the warning across active work.
 *
 * Archived sessions are excluded too: `DoneRecapPanel` renders the status bar retrospectively, and
 * a ⚠ there reads as a verdict on finished work rather than a forecast.
 */
export function isColdResume(session: Session, now: number): boolean {
  if (session.status === "running" || session.status === "archived") return false;
  const { coldResumeAt, resumeCostUnits } = session;
  if (coldResumeAt == null || resumeCostUnits == null) return false;
  return now > coldResumeAt && resumeCostUnits >= COLD_RESUME_MIN_UNITS;
}
