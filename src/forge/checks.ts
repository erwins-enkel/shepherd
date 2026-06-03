import type { CheckRun, ChecksState } from "./types";

const FAILURE = new Set([
  "failure",
  "error",
  "cancelled",
  "canceled",
  "timed_out",
  "action_required",
]);

/** Map one check run's lifecycle status + conclusion to a single state.
 *  status != completed → pending; success → success; a FAILURE conclusion →
 *  failure; "" / neutral / skipped → none. */
export function mapCheckState(status?: string | null, conclusion?: string | null): ChecksState {
  const s = (status ?? "").toLowerCase();
  const c = (conclusion ?? "").toLowerCase();
  if (s && s !== "completed") return "pending"; // queued / in_progress / pending / running / waiting
  if (c === "success") return "success";
  if (FAILURE.has(c)) return "failure";
  return "none";
}

/** Roll a list of forge-reported check runs into a single worst-of state
 *  (failure > pending > success > none). */
export function rollupChecks(runs: ReadonlyArray<CheckRun>): ChecksState {
  let sawPending = false;
  let sawSuccess = false;
  for (const r of runs) {
    const st = mapCheckState(r.status, r.conclusion);
    if (st === "failure") return "failure";
    if (st === "pending") sawPending = true;
    else if (st === "success") sawSuccess = true;
    // "none" → ignored
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "success";
  return "none";
}
