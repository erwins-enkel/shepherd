/**
 * "Is this session getting anywhere?" — one verdict per session, derived from data the UI already
 * holds (session status, PR + per-job CI timings, build queue, steer log). Pure and text-free: the
 * card's now-line and the status panel localize it. Order of precedence: the operator is needed >
 * Shepherd keeps re-steering the same CI fix > CI is red > CI runs unusually long > CI runs >
 * the agent works. Anything else (idle, handed off, done) has no pulse.
 */
import type {
  BuildQueue,
  ChecksState,
  GitState,
  Session,
  SteerKind,
  SteerLogEntry,
  WorkflowJob,
} from "./types";

export type PulseState =
  "needs_you" | "looping" | "ci_failed" | "ci_overdue" | "waiting_ci" | "working";

/** A running job counts as overdue past this multiple of its usual duration. */
export const OVERDUE_FACTOR = 1.5;
/** This many CI-fix steers in a row, with CI still not green, reads as going in circles. */
export const LOOP_RUN = 3;

export interface PulseJob {
  name: string;
  /** `name` without its "Workflow / " qualifier, for the one-line card. */
  short: string;
  state: ChecksState;
  elapsedMs?: number;
  typicalMs?: number;
}

export interface Pulse {
  state: PulseState;
  /** The job the verdict is about: the one finishing last (CI running), the most overdue one, or
   *  the first red one. Absent when the PR reports no per-job breakdown. */
  job?: PulseJob;
  /** Expected finish of `job`, from its usual duration. */
  etaMs?: number;
  green: number;
  total: number;
  /** CI-fix steers at the end of the steer log with nothing else in between. */
  ciFixRun: number;
  /** The build-queue step being worked (1-based). */
  step?: { index: number; total: number; title: string };
}

export interface PulseInput {
  session: Session;
  git?: GitState;
  queue?: BuildQueue;
  steers?: readonly SteerLogEntry[];
  nowMs: number;
}

function shortName(name: string): string {
  const at = name.lastIndexOf(" / ");
  return at < 0 ? name : name.slice(at + 3);
}

function pulseJob(j: WorkflowJob, nowMs: number): PulseJob {
  return {
    name: j.name,
    short: shortName(j.name),
    state: j.state,
    ...(j.state === "pending" && j.startedAt != null ? { elapsedMs: nowMs - j.startedAt } : {}),
    ...(j.typicalMs != null ? { typicalMs: j.typicalMs } : {}),
  };
}

function trailingCiFixes(steers: readonly SteerLogEntry[] | undefined): number {
  let run = 0;
  for (let i = (steers?.length ?? 0) - 1; i >= 0 && steers![i]!.kind === "ci_fix"; i--) run++;
  return run;
}

function activeStep(queue: BuildQueue | undefined): Pulse["step"] {
  const steps = queue?.steps ?? [];
  const active = steps.find((s) => s.status === "active");
  if (!active) return undefined;
  const ordered = steps.toSorted((a, b) => a.position - b.position);
  return { index: ordered.indexOf(active) + 1, total: steps.length, title: active.title };
}

/** Running jobs: the most overdue one if any is past OVERDUE_FACTOR, else the one expected to
 *  finish last (no usual time known → the one running longest). */
function runningFocus(
  jobs: WorkflowJob[],
  nowMs: number,
): { job: WorkflowJob; overdue: boolean } | null {
  const running = jobs.filter((j) => j.state === "pending" && j.startedAt != null);
  if (running.length === 0) return null;
  const overrun = (j: WorkflowJob) =>
    j.typicalMs ? (nowMs - j.startedAt!) / j.typicalMs : Number.NEGATIVE_INFINITY;
  const worst = running.reduce((a, b) => (overrun(b) > overrun(a) ? b : a));
  if (overrun(worst) > OVERDUE_FACTOR) return { job: worst, overdue: true };
  const eta = (j: WorkflowJob) => (j.typicalMs ? j.startedAt! + j.typicalMs : -j.startedAt!);
  const timed = running.filter((j) => j.typicalMs);
  const last = (timed.length ? timed : running).reduce((a, b) => (eta(b) > eta(a) ? b : a));
  return { job: last, overdue: false };
}

export function sessionPulse({ session, git, queue, steers, nowMs }: PulseInput): Pulse | null {
  const jobs = git?.state === "open" ? (git.jobs ?? []) : [];
  const base = {
    green: jobs.filter((j) => j.state === "success").length,
    total: jobs.length,
    ciFixRun: trailingCiFixes(steers),
  };
  const prOpen = git?.state === "open";
  const notGreen = prOpen && git.checks !== "success";
  if (session.status === "blocked") return { state: "needs_you", ...base };
  if (notGreen && base.ciFixRun >= LOOP_RUN) {
    const red = jobs.find((j) => j.state === "failure");
    return { state: "looping", ...base, ...(red ? { job: pulseJob(red, nowMs) } : {}) };
  }
  if (prOpen && git.checks === "failure") {
    const red = jobs.find((j) => j.state === "failure");
    return { state: "ci_failed", ...base, ...(red ? { job: pulseJob(red, nowMs) } : {}) };
  }
  if (prOpen && git.checks === "pending") {
    const focus = runningFocus(jobs, nowMs);
    if (!focus) return { state: "waiting_ci", ...base };
    const { job, overdue } = focus;
    return {
      state: overdue ? "ci_overdue" : "waiting_ci",
      ...base,
      job: pulseJob(job, nowMs),
      ...(job.typicalMs ? { etaMs: job.startedAt! + job.typicalMs } : {}),
    };
  }
  if (session.status === "running") {
    const step = activeStep(queue);
    return { state: "working", ...base, ...(step ? { step } : {}) };
  }
  return null;
}

export interface CiRow {
  name: string;
  state: ChecksState;
  /** Finished jobs: how long they took. */
  durationMs?: number;
  /** Running jobs: how long so far, and the usual duration when known. */
  elapsedMs?: number;
  typicalMs?: number;
}

const ROW_ORDER: Record<ChecksState, number> = { failure: 0, pending: 1, success: 2, none: 3 };

/** The PR's checks for the panel: red first, then running, then the rest. */
export function ciRows(jobs: readonly WorkflowJob[] | undefined, nowMs: number): CiRow[] {
  return (jobs ?? [])
    .map((j): CiRow => {
      const row: CiRow = { name: j.name, state: j.state };
      if (j.state === "pending") {
        if (j.startedAt != null) row.elapsedMs = nowMs - j.startedAt;
        if (j.typicalMs != null) row.typicalMs = j.typicalMs;
      } else if (j.startedAt != null && j.completedAt != null) {
        row.durationMs = j.completedAt - j.startedAt;
      }
      return row;
    })
    .toSorted((a, b) => ROW_ORDER[a.state] - ROW_ORDER[b.state]);
}

export type TimelineKind = "start" | "pr" | SteerKind;

/** Session start, PR opening and every steer, oldest first. */
export function timeline(
  session: Session,
  git: GitState | undefined,
  steers: readonly SteerLogEntry[] | undefined,
): { ts: number; kind: TimelineKind }[] {
  const events: { ts: number; kind: TimelineKind }[] = [{ ts: session.createdAt, kind: "start" }];
  if (git?.state !== "none" && git?.createdAt) events.push({ ts: git.createdAt, kind: "pr" });
  for (const s of steers ?? []) events.push({ ts: s.ts, kind: s.kind });
  return events.toSorted((a, b) => a.ts - b.ts);
}

/** How often Shepherd steered vs the operator, and the CI-fix share. */
export function steerTally(steers: readonly SteerLogEntry[] | undefined): {
  shepherd: number;
  operator: number;
  ciFix: number;
  ciFixRun: number;
} {
  const list = steers ?? [];
  const operator = list.filter((s) => s.kind === "operator").length;
  return {
    shepherd: list.length - operator,
    operator,
    ciFix: list.filter((s) => s.kind === "ci_fix").length,
    ciFixRun: trailingCiFixes(list),
  };
}
