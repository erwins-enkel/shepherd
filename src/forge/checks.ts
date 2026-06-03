import type { CheckRun, ChecksState, RollupEntry, WorkflowJob } from "./types";

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

/** Map a coarse status-state string (GitHub StatusContext / Gitea combined +
 *  per-context status) to a single state: success → success; pending / expected
 *  / running → pending; failure / error → failure; anything else → none. */
export function mapStatusState(state?: string | null): ChecksState {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "pending":
    case "expected":
    case "running":
      return "pending";
    case "failure":
    case "error":
      return "failure";
    default:
      return "none";
  }
}

/** A legacy StatusContext carries a context label + flat state (no lifecycle). */
function isStatusContext(e: RollupEntry): boolean {
  return e.__typename === "StatusContext" || (e.name == null && e.context != null);
}

/** Map one rollup entry to a job, or null when it has no usable label. */
function rollupEntryToJob(e: RollupEntry): WorkflowJob | null {
  if (isStatusContext(e)) {
    const name = e.context ?? "";
    return name ? { name, state: mapStatusState(e.state), url: e.targetUrl || undefined } : null;
  }
  const base = e.name ?? "";
  if (!base) return null;
  // A flat PR check list spans workflows, so qualify the job with its workflow
  // ("CI / lint") the way GitHub's own checks UI does.
  const name = e.workflowName ? `${e.workflowName} / ${base}` : base;
  return { name, state: mapCheckState(e.status, e.conclusion), url: e.detailsUrl || undefined };
}

/** Expand GitHub's `statusCheckRollup` into one {@link WorkflowJob} per check.
 *  CheckRuns (Actions jobs) carry a workflow + job name and a status/conclusion;
 *  legacy StatusContexts carry a context label and a flat state. Entries without
 *  a usable label are dropped. */
export function jobsFromRollup(entries: ReadonlyArray<RollupEntry>): WorkflowJob[] {
  return entries.map(rollupEntryToJob).filter((j): j is WorkflowJob => j != null);
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
