import { basename } from "node:path";
import type { SessionStore } from "./store";
import type {
  DeliveryBucket,
  DeliveryFact,
  DeliveryIncidentRow,
  DeliveryMetrics,
  DeliveryRepoRow,
  DeliverySample,
  DeliveryStats,
  DeliveryTaskRow,
  ReviewerSpawnRow,
  UsageRange,
} from "./types";

/** Store surface this builder reads. Narrowed so tests can seed a real SessionStore (or a stub)
 *  without standing up the rest of the server. */
export type DeliveryMetricsStore = Pick<
  SessionStore,
  "listMergedDeliveryFacts" | "listReviewerSpawns" | "earliestDeliveryFactAt" | "countSignalsByKind"
>;

/** Newest merged tasks returned as evidence rows. The aggregates cover the whole window; this list
 *  is only what the lens shows underneath them, so it stays a fixed, small payload. */
const MAX_TASK_ROWS = 50;

/** Per-task counters distilled from the reviewer-spawn log. */
interface TaskRounds {
  /** Review rounds that reached a verdict (`clean` + `changes_requested`). */
  reviewRounds: number;
  /** Of those, how many demanded rework. */
  changesRequested: number;
  /** Review spawns that ended in `error` — a critic run that produced no verdict. Counted apart so
   *  a crashed run never reads as a rework cycle. */
  errors: number;
  /** Plan-gate rounds that reached a verdict (`approved` + `rework`). */
  planRounds: number;
  /** Earliest review spawn, whatever its outcome — the review DID start. */
  firstReviewAt: number | null;
}

const EMPTY_ROUNDS: TaskRounds = {
  reviewRounds: 0,
  changesRequested: 0,
  errors: 0,
  planRounds: 0,
  firstReviewAt: null,
};

/** Window start for a range; 0 for `all` so the caller filters on `>= 0` rather than on a
 *  special-cased branch. */
function rangeCutoff(range: UsageRange, now: number): number {
  if (range === "24h") return now - 86_400_000;
  if (range === "7d") return now - 7 * 86_400_000;
  if (range === "30d") return now - 30 * 86_400_000;
  return 0;
}

/** A metric plus its sample size. `n` is the number of tasks that qualified, NOT the number of
 *  tasks in the window — a median over two tasks must be visibly a median over two tasks. */
function sample(values: number[], reduce: (v: number[]) => number): DeliverySample {
  if (values.length === 0) return { value: null, n: 0 };
  return { value: reduce(values), n: values.length };
}

/** Caller guarantees a non-empty array (every call site is behind a length check). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid]!;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + hi) / 2 : hi;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Share of `hits` within `total`, or a null sample when nothing qualified. */
function rate(hits: number, total: number): DeliverySample {
  return total === 0 ? { value: null, n: 0 } : { value: hits / total, n: total };
}

/** Group the reviewer-spawn log by task session, keeping only the two kinds a delivery indicator
 *  reads. A NULL `outcome` is a legacy row or a spawn that never finalized: it is UNKNOWN, so it
 *  is excluded from every round count — counting it would inflate rework with crashed runs. */
function applyReviewSpawn(t: TaskRounds, sp: ReviewerSpawnRow): void {
  // The review STARTED regardless of how it ended, so every spawn moves the first-review mark.
  if (t.firstReviewAt == null || sp.spawnedAt < t.firstReviewAt) t.firstReviewAt = sp.spawnedAt;
  if (sp.outcome === "error") t.errors += 1;
  else if (sp.outcome === "clean" || sp.outcome === "changes_requested") {
    t.reviewRounds += 1;
    if (sp.outcome === "changes_requested") t.changesRequested += 1;
  }
}

function roundsByTask(spawns: ReviewerSpawnRow[], wanted: Set<string>): Map<string, TaskRounds> {
  const out = new Map<string, TaskRounds>();
  for (const sp of spawns) {
    if (!wanted.has(sp.taskSessionId)) continue;
    if (sp.kind !== "review" && sp.kind !== "plan_gate") continue;
    const t = out.get(sp.taskSessionId) ?? { ...EMPTY_ROUNDS };
    if (sp.kind === "review") applyReviewSpawn(t, sp);
    else if (sp.outcome === "approved" || sp.outcome === "rework") t.planRounds += 1;
    out.set(sp.taskSessionId, t);
  }
  return out;
}

/** A non-negative duration, or null when either end is missing or the pair is inverted. An
 *  inverted pair means bad data (clock skew, a late-observed PR-open); it is DROPPED rather than
 *  clamped to 0, which would silently flatter the metric. */
function duration(from: number | null, to: number | null): number | null {
  if (from == null || to == null) return null;
  const ms = to - from;
  return ms >= 0 ? ms : null;
}

/** One merged task joined with its rounds — the row every aggregate is folded from. */
interface TaskView {
  fact: DeliveryFact;
  rounds: TaskRounds;
  firstPass: boolean | null;
  timeToFirstReviewMs: number | null;
  leadTimeMs: number | null;
}

function toTaskView(fact: DeliveryFact, rounds: TaskRounds): TaskView {
  return {
    fact,
    rounds,
    // null = never reviewed, which is NOT a first-pass success. Kept out of the rate's denominator
    // and reported separately as `unreviewed`.
    firstPass:
      rounds.reviewRounds === 0 ? null : rounds.reviewRounds === 1 && rounds.changesRequested === 0,
    timeToFirstReviewMs: duration(fact.prOpenedAt, rounds.firstReviewAt),
    leadTimeMs: duration(fact.createdAt, fact.mergedAt),
  };
}

/** Fold a set of merged tasks into the indicator block. Used for both the per-repo rows and the
 *  global totals, so the two can never drift apart. */
function statsFor(tasks: TaskView[]): DeliveryStats {
  const reviewed = tasks.filter((t) => t.firstPass !== null);
  const gated = tasks.filter((t) => t.rounds.planRounds > 0);
  const reworkCycles = reviewed.map((t) => t.rounds.reviewRounds);
  const planRounds = gated.map((t) => t.rounds.planRounds);
  const ttfr = tasks.map((t) => t.timeToFirstReviewMs).filter((v): v is number => v != null);
  const lead = tasks.map((t) => t.leadTimeMs).filter((v): v is number => v != null);
  return {
    mergedTasks: tasks.length,
    firstPassRate: rate(reviewed.filter((t) => t.firstPass).length, reviewed.length),
    unreviewed: tasks.length - reviewed.length,
    reworkCyclesMedian: sample(reworkCycles, median),
    reworkCyclesMean: sample(reworkCycles, mean),
    criticErrors: tasks.reduce((n, t) => n + t.rounds.errors, 0),
    planRoundsMedian: sample(planRounds, median),
    planReworkRate: rate(gated.filter((t) => t.rounds.planRounds > 1).length, gated.length),
    timeToFirstReviewMs: sample(ttfr, median),
    leadTimeMs: sample(lead, median),
  };
}

function repoRows(tasks: TaskView[]): DeliveryRepoRow[] {
  const byRepo = new Map<string, TaskView[]>();
  for (const t of tasks) {
    const list = byRepo.get(t.fact.repoPath);
    if (list) list.push(t);
    else byRepo.set(t.fact.repoPath, [t]);
  }
  return [...byRepo.entries()]
    .map(([repoPath, list]) => ({
      repoPath,
      repo: basename(repoPath),
      ...statsFor(list),
    }))
    .sort((a, b) => b.mergedTasks - a.mergedTasks || a.repo.localeCompare(b.repo));
}

/** UTC day key (`YYYY-MM-DD`) — the trend is read comparatively across days, so a single fixed
 *  zone beats a host-local one that would shift the buckets on a DST boundary. */
function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function trendBuckets(tasks: TaskView[]): DeliveryBucket[] {
  const byDay = new Map<string, TaskView[]>();
  for (const t of tasks) {
    const key = dayKey(t.fact.mergedAt as number);
    const list = byDay.get(key);
    if (list) list.push(t);
    else byDay.set(key, [t]);
  }
  return [...byDay.entries()]
    .map(([key, list]) => {
      const reviewed = list.filter((t) => t.firstPass !== null);
      const lead = list.map((t) => t.leadTimeMs).filter((v): v is number => v != null);
      return {
        dayKey: key,
        mergedTasks: list.length,
        firstPassRate:
          reviewed.length === 0
            ? null
            : reviewed.filter((t) => t.firstPass).length / reviewed.length,
        leadTimeMedianMs: lead.length === 0 ? null : median(lead),
      };
    })
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

function taskRows(tasks: TaskView[]): DeliveryTaskRow[] {
  return tasks.slice(0, MAX_TASK_ROWS).map((t) => ({
    sessionId: t.fact.sessionId,
    desig: t.fact.desig,
    repo: basename(t.fact.repoPath),
    issueNumber: t.fact.issueNumber,
    prNumber: t.fact.prNumber,
    reviewRounds: t.rounds.reviewRounds,
    planRounds: t.rounds.planRounds,
    firstPass: t.firstPass,
    timeToFirstReviewMs: t.timeToFirstReviewMs,
    leadTimeMs: t.leadTimeMs,
    mergedAt: t.fact.mergedAt as number,
  }));
}

function incidents(
  rows: { kind: DeliveryIncidentRow["kind"]; occurrences: number; sessions: number }[],
): DeliveryIncidentRow[] {
  return rows.map((r) => ({ kind: r.kind, occurrences: r.occurrences, sessions: r.sessions }));
}

/**
 * Delivery indicators for a window (#2151 R1) — first-pass rate, rework cycles, plan rework,
 * time-to-first-review, lead time and repeat incidents.
 *
 * Pure over its injected store + `now`, like `buildUsageBreakdown`: no clock, no filesystem, no
 * forge. Every metric is keyed off a task whose merge SETTLED inside the window; a task with no
 * qualifying sample yields `null`, never `0`.
 *
 * Instrumentation is forward-only, so `measuringSince` reports the earliest instrumented session —
 * an empty window means young instrumentation, not a delivery drought.
 */
export function buildDeliveryMetrics(opts: {
  store: DeliveryMetricsStore;
  range: UsageRange;
  now: number;
}): DeliveryMetrics {
  const { store, range, now } = opts;
  const since = rangeCutoff(range, now);
  // Rows are filtered on the EXACT cutoff, not a floored day boundary — a bucket boundary would
  // silently widen "24h" to include yesterday's early merges.
  const facts = store.listMergedDeliveryFacts(since);
  const wanted = new Set(facts.map((f) => f.sessionId));
  const rounds = roundsByTask(store.listReviewerSpawns(), wanted);
  const tasks = facts.map((f) => toTaskView(f, rounds.get(f.sessionId) ?? { ...EMPTY_ROUNDS }));
  return {
    range,
    generatedAt: now,
    since,
    measuringSince: store.earliestDeliveryFactAt(),
    totals: statsFor(tasks),
    repos: repoRows(tasks),
    incidents: incidents(store.countSignalsByKind(since)),
    trend: trendBuckets(tasks),
    tasks: taskRows(tasks),
  };
}
