import type { CheckRun, ChecksState } from "./types";

const FAILURE = new Set([
  "failure",
  "error",
  "cancelled",
  "canceled",
  "timed_out",
  "action_required",
]);

/** Roll a list of forge-reported check runs into a single worst-of state. */
export function rollupChecks(runs: ReadonlyArray<CheckRun>): ChecksState {
  let sawPending = false;
  let sawSuccess = false;
  for (const r of runs) {
    const status = (r.status ?? "").toLowerCase();
    const conclusion = (r.conclusion ?? "").toLowerCase();
    if (status && status !== "completed") {
      sawPending = true; // queued / in_progress / pending / running / waiting
      continue;
    }
    if (conclusion === "success") sawSuccess = true;
    else if (FAILURE.has(conclusion)) return "failure";
    // "" / neutral / skipped → ignored
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "success";
  return "none";
}
