/**
 * CI runs that fail before creating any job (#3831). GitHub can end a workflow run as `failure`
 * (or `startup_failure`) without a single job, e.g. on an internal error while starting it. No
 * check run exists then, so the head's `statusCheckRollup` stays empty and the PR reads as
 * `checks: "none"`, indistinguishable from CI that hasn't registered yet. The merge train then
 * waits forever (`checks_absent`), autopilot never steers a CI fix, and nothing tells anyone.
 *
 * For an open PR in a repo with PR CI that sits on an empty rollup past a grace, this module
 * reads the head's workflow runs. A run that failed without jobs is re-run once by Shepherd
 * (first attempt only — GitHub's `run_attempt` keeps that true across restarts) and reads as CI
 * in flight meanwhile. If it fails again, or the forge refuses the re-run, it reads as red CI:
 * one synthetic job per run, flagged `startupFailure`, linking the run. Every red-CI path (merge
 * train, autopilot, CI steer, attention, UI) then treats it like any other failure.
 *
 * Applied as an overlay on the raw forge read, at the same chokepoints that stamp `noCi`
 * (PrPoller.refresh and the on-demand `/git` read), so both agree.
 */
import { runIdFromJobUrl } from "./ci-restart-hold";
import type { ForgeRun, GitForge, GitState, WorkflowJob } from "./forge/types";

/** How long a PR head sits on an empty rollup before its runs are read: checks register within
 *  seconds, a start failure within a minute, so this keeps the pre-CI race free of reads. */
export const STARTUP_GRACE_MS = 2 * 60_000;
/** How long one head's run list is reused. */
export const RUNS_CACHE_TTL_MS = 60_000;
/** How long after Shepherd's re-run a first-attempt failure still reads as GitHub lagging. */
export const RERUN_SETTLE_MS = 5 * 60_000;
/** Re-run marks are dropped after this; the run's own `attempt` guards a re-run after that. */
const RERUN_MARK_TTL_MS = 60 * 60_000;

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "startup_failure"]);

/** Shepherd's re-run of one run: when it was issued, and whether the forge refused it. */
export interface RerunMark {
  at: number;
  refused?: boolean;
}

/** `rerun` = re-run it now; `rerunning` = Shepherd's re-run is under way; `failed` = red CI. */
export type StartupRunState = "rerun" | "rerunning" | "failed";

/** What one head run means for a PR whose rollup is empty, or null when it means nothing (green,
 *  cancelled, skipped, or still in flight without a re-run of ours). Pure. */
export function classifyStartupRun(
  run: ForgeRun,
  mark: RerunMark | undefined,
  now: number,
): StartupRunState | null {
  if (run.status !== "completed") return mark && !mark.refused ? "rerunning" : null;
  if (!run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) return null;
  if (run.attempt > 1 || mark?.refused) return "failed";
  if (!mark) return "rerun";
  return now - mark.at < RERUN_SETTLE_MS ? "rerunning" : "failed";
}

function startupJob(run: ForgeRun, state: StartupRunState): WorkflowJob {
  return {
    name: run.workflowName || run.workflowFile || "CI",
    state: state === "failed" ? "failure" : "pending",
    ...(run.url ? { url: run.url } : {}),
    startupFailure: true,
  };
}

/** `git` with its empty rollup replaced by the classified runs: worst-of like the rollup (one
 *  failed run beats one being re-run). No entries ⇒ `git` itself. Pure. */
export function startupFailureOverlay(
  git: GitState,
  entries: { run: ForgeRun; state: StartupRunState }[],
): GitState {
  if (entries.length === 0) return git;
  const jobs = entries.map((e) => startupJob(e.run, e.state));
  const failed = jobs.some((j) => j.state === "failure");
  const out: GitState = { ...git, checks: failed ? "failure" : "pending", jobs };
  delete out.runningChecks;
  if (!failed) out.runningChecks = jobs.map((j) => j.name);
  return out;
}

/** Agent-facing steer for red CI that is a start failure, or null when it is not one. NOT UI
 *  chrome — typed into the PTY, never i18n'd. Without it the agent gets "read the failing
 *  checks' logs" for a run that has neither checks nor logs, and may edit a workflow that is
 *  fine. */
export function ciStartupSteer(git: GitState): string | null {
  const job = git.jobs?.find((j) => j.startupFailure && j.state === "failure");
  if (!job) return null;
  const id = runIdFromJobUrl(job.url) ?? "<run-id>";
  const head = `PR #${git.number ?? "?"} (head ${(git.headSha ?? "").slice(0, 7)})`;
  return [
    `Shepherd: CI on ${head} failed before starting any job: run ${job.url ?? id} ended without`,
    "creating a single job (GitHub reported an error while starting it), so there are no job",
    "logs, and a re-run did not get it going. Read the error once with",
    `\`gh run view ${id}\`. Change a workflow only if this branch changed it or the error names it.`,
    `Otherwise change no code and push nothing: re-run it once with \`gh run rerun ${id}\`, and if`,
    "it fails the same way again, stop and say CI is failing on GitHub's side. Don't watch the",
    "run — Shepherd tells you when CI finishes.",
  ].join(" "); // one line: the CI-finished steer (src/ci-steer.ts) sends single-line text
}

/** The forge reads this needs; GitHub implements both, other forges neither. */
export type StartupFailureForge = Pick<GitForge, "headWorkflowRuns" | "rerunWorkflowRun">;

/** Newest run per workflow file: an older failed run superseded by a newer one is history. */
function latestPerWorkflow(runs: ForgeRun[]): ForgeRun[] {
  const latest = new Map<string, ForgeRun>();
  for (const r of runs) {
    const key = r.workflowFile || r.workflowName;
    const seen = latest.get(key);
    if (!seen || r.createdAt > seen.createdAt || (r.createdAt === seen.createdAt && r.id > seen.id))
      latest.set(key, r);
  }
  return [...latest.values()];
}

function eligible(git: GitState, forge: StartupFailureForge): boolean {
  return (
    !!forge.headWorkflowRuns &&
    !!forge.rerunWorkflowRun &&
    git.state === "open" &&
    git.checks === "none" &&
    (git.jobs?.length ?? 0) === 0 &&
    !git.noCi &&
    !!git.headSha
  );
}

/** The stateful half: grace per session head, the run-list cache, and Shepherd's re-run marks.
 *  One instance is shared by every read path so a PR is re-run at most once. In-memory. */
export class CiStartupFailureService {
  private readonly now: () => number;
  private noneSince = new Map<string, { head: string; since: number }>();
  private runs = new Map<string, { at: number; read: Promise<ForgeRun[]> }>();
  private marks = new Map<number, RerunMark>();

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  /** `git` with a start failure on its head made visible (see the module doc), else `git`. */
  async stamp(sessionId: string, git: GitState, forge: StartupFailureForge): Promise<GitState> {
    if (!eligible(git, forge)) {
      this.noneSince.delete(sessionId);
      return git;
    }
    const head = git.headSha!;
    const now = this.now();
    this.prune(now);
    let seen = this.noneSince.get(sessionId);
    if (seen?.head !== head) {
      seen = { head, since: now };
      this.noneSince.set(sessionId, seen);
    }
    if (now - seen.since < STARTUP_GRACE_MS) return git;
    let runs: ForgeRun[];
    try {
      runs = await this.headRuns(sessionId, head, forge);
    } catch (err) {
      console.warn(`[ci-startup] runs read for ${head.slice(0, 7)} failed; leaving it:`, err);
      return git;
    }
    const entries: { run: ForgeRun; state: StartupRunState }[] = [];
    for (const run of latestPerWorkflow(runs.filter((r) => r.headSha === head))) {
      let state = classifyStartupRun(run, this.marks.get(run.id), now);
      if (state === "rerun") state = await this.rerun(sessionId, head, run, forge);
      if (state) entries.push({ run, state });
    }
    return startupFailureOverlay(git, entries);
  }

  private headRuns(
    sessionId: string,
    head: string,
    forge: StartupFailureForge,
  ): Promise<ForgeRun[]> {
    const key = `${sessionId}\0${head}`;
    const hit = this.runs.get(key);
    if (hit && this.now() - hit.at < RUNS_CACHE_TTL_MS) return hit.read;
    const read = forge.headWorkflowRuns!(head);
    this.runs.set(key, { at: this.now(), read });
    read.catch(() => this.runs.delete(key)); // a failed read is retried on the next poll
    return read;
  }

  /** Re-run once. The mark is claimed BEFORE the await, so an overlapping read of the same PR
   *  sees `rerunning` instead of issuing a second re-run. */
  private async rerun(
    sessionId: string,
    head: string,
    run: ForgeRun,
    forge: StartupFailureForge,
  ): Promise<StartupRunState> {
    const mark: RerunMark = { at: this.now() };
    this.marks.set(run.id, mark);
    try {
      await forge.rerunWorkflowRun!(run.id, { failedOnly: false });
      this.runs.delete(`${sessionId}\0${head}`);
      console.warn(`[ci-startup] run ${run.id} on ${head.slice(0, 7)} had no jobs; re-ran it once`);
      return "rerunning";
    } catch (err) {
      mark.refused = true;
      console.warn(`[ci-startup] re-run of run ${run.id} refused; reading it as red CI:`, err);
      return "failed";
    }
  }

  private prune(now: number): void {
    for (const [key, hit] of this.runs)
      if (now - hit.at >= RUNS_CACHE_TTL_MS) this.runs.delete(key);
    for (const [id, mark] of this.marks)
      if (now - mark.at >= RERUN_MARK_TTL_MS) this.marks.delete(id);
  }
}
