import { basename } from "node:path";
import type { SessionStore } from "./store";
import type {
  UsageRange,
  UsageBreakdown,
  UsageRepoBreakdown,
  UsageTaskBreakdown,
  UsageTokens,
} from "./types";
import { isOperationalArchetype } from "./usage-archetype";
import { jsonlPathFor, sessionCost, dominantModel } from "./usage";
import { weightedUnits } from "./pricing";

/** Internal accumulator — public fields + private cacheRead accumulators. */
interface TaskAccum {
  sessionId: string;
  desig: string;
  model: string;
  repoPath: string;
  authoringUnits: number;
  satelliteUnits: number;
  tokens: UsageTokens;
  byModel: Record<string, number>;
  authoringCacheReadUnits: number;
  satelliteCacheReadUnits: number;
}

/** Compute the ms-epoch cutoff for the given range. */
function rangeCutoff(range: UsageRange, now: number): number {
  if (range === "24h") return now - 86_400_000;
  if (range === "7d") return now - 7 * 86_400_000;
  if (range === "30d") return now - 30 * 86_400_000;
  return 0;
}

/** Build a TaskAccum from a persisted usage snapshot. */
function snapshotToAccum(snap: ReturnType<SessionStore["listSessionUsage"]>[number]): TaskAccum {
  return {
    sessionId: snap.sessionId,
    desig: snap.desig,
    model: snap.model,
    repoPath: snap.repoPath,
    authoringUnits: snap.weightedUnits,
    satelliteUnits: 0,
    tokens: {
      input: snap.input,
      output: snap.output,
      cacheRead: snap.cacheRead,
      cacheWrite: snap.cacheWrite,
    },
    byModel: snap.byModel,
    authoringCacheReadUnits: snap.cacheReadUnits,
    satelliteCacheReadUnits: 0,
  };
}

/** Read a live session's JSONL and return a TaskAccum, or null if empty/absent/operational. */
async function liveSessionToAccum(
  s: ReturnType<SessionStore["list"]>[number],
  cutoff: number,
): Promise<TaskAccum | null> {
  if (!s.claudeSessionId) return null;
  if (isOperationalArchetype(s)) return null;

  const path = jsonlPathFor(s.worktreePath, s.claudeSessionId);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const text = await file.text();
  const sc = sessionCost(text.split("\n"), cutoff);
  if (sc.usage.messageCount === 0) return null;

  return {
    sessionId: s.id,
    desig: s.desig,
    model: dominantModel(sc.usage) ?? s.model ?? "unknown",
    repoPath: s.repoPath,
    authoringUnits: sc.weightedUnits,
    satelliteUnits: 0,
    tokens: {
      input: sc.usage.input,
      output: sc.usage.output,
      cacheRead: sc.usage.cacheRead,
      cacheWrite: sc.usage.cacheWrite,
    },
    byModel: sc.weightedByModel,
    authoringCacheReadUnits: sc.cacheReadUnits,
    satelliteCacheReadUnits: 0,
  };
}

/** Attribute satellite (reviewer spawn) costs onto their parent task accumulators. */
function attributeSatellites(
  taskMap: Map<string, TaskAccum>,
  spawns: ReturnType<SessionStore["listReviewerSpawns"]>,
): void {
  for (const sp of spawns) {
    if (sp.totalTokens == null) continue;
    const task = taskMap.get(sp.taskSessionId);
    if (!task) continue;

    const model = sp.model ?? task.model ?? "unknown";
    const wu = weightedUnits(
      {
        input: sp.inputTokens ?? 0,
        output: sp.outputTokens ?? 0,
        cacheRead: sp.cacheReadTokens ?? 0,
        cacheWrite5m: sp.cacheWriteTokens ?? 0,
        cacheWrite1h: 0,
      },
      model,
    );
    const cru = weightedUnits(
      {
        input: 0,
        output: 0,
        cacheRead: sp.cacheReadTokens ?? 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      model,
    );

    task.satelliteUnits += wu;
    task.satelliteCacheReadUnits += cru;
  }
}

/** Group task accumulators by repo, sort within each repo, and produce public repo breakdowns. */
function buildRepoBreakdowns(
  taskMap: Map<string, TaskAccum>,
  apiKey: boolean,
): UsageRepoBreakdown[] {
  const repoMap = new Map<string, TaskAccum[]>();
  for (const task of taskMap.values()) {
    let bucket = repoMap.get(task.repoPath);
    if (!bucket) {
      bucket = [];
      repoMap.set(task.repoPath, bucket);
    }
    bucket.push(task);
  }

  const repos: UsageRepoBreakdown[] = [];
  for (const [repoPath, tasks] of repoMap) {
    tasks.sort(
      (a, b) => b.authoringUnits + b.satelliteUnits - (a.authoringUnits + a.satelliteUnits),
    );

    const repoAuthoring = tasks.reduce((s, t) => s + t.authoringUnits, 0);
    const repoSatellite = tasks.reduce((s, t) => s + t.satelliteUnits, 0);
    const repoName = basename(repoPath) || repoPath;

    const publicTasks: UsageTaskBreakdown[] = tasks.map((t) => ({
      sessionId: t.sessionId,
      desig: t.desig,
      model: t.model,
      authoringUnits: t.authoringUnits,
      satelliteUnits: t.satelliteUnits,
      tokens: t.tokens,
      byModel: t.byModel,
    }));

    repos.push({
      repoPath,
      repoName,
      authoringUnits: repoAuthoring,
      satelliteUnits: repoSatellite,
      // `$` = the accumulated list-price units themselves (NOT pricing.dollars() on aggregate
      // tokens — that would diverge from the units shown). See dollars()'s doc in pricing.ts.
      dollars: apiKey ? repoAuthoring + repoSatellite : null,
      tasks: publicTasks,
    });
  }

  repos.sort((a, b) => b.authoringUnits + b.satelliteUnits - (a.authoringUnits + a.satelliteUnits));
  return repos;
}

/** Compute top-level aggregate totals from the task map and repo list. */
function aggregateTotals(
  taskMap: Map<string, TaskAccum>,
  repos: UsageRepoBreakdown[],
): {
  totalUnits: number;
  authoringUnits: number;
  satelliteUnits: number;
  cacheReadUnits: number;
  generationUnits: number;
} {
  const authoringUnits = repos.reduce((s, r) => s + r.authoringUnits, 0);
  const satelliteUnits = repos.reduce((s, r) => s + r.satelliteUnits, 0);
  const totalUnits = authoringUnits + satelliteUnits;

  let cacheReadUnits = 0;
  for (const task of taskMap.values()) {
    cacheReadUnits += task.authoringCacheReadUnits + task.satelliteCacheReadUnits;
  }
  const generationUnits = Math.max(0, totalUnits - cacheReadUnits);

  return { totalUnits, authoringUnits, satelliteUnits, cacheReadUnits, generationUnits };
}

export async function buildUsageBreakdown(opts: {
  store: SessionStore;
  range: UsageRange;
  now: number;
  apiKey: boolean;
}): Promise<UsageBreakdown> {
  const { store, range, now, apiKey } = opts;

  const cutoff = rangeCutoff(range, now);

  // Task accumulator map keyed by sessionId
  const taskMap = new Map<string, TaskAccum>();

  // Persisted tasks
  const snapshots = store.listSessionUsage();
  for (const snap of snapshots) {
    if (snap.snapshotAt < cutoff) continue;
    taskMap.set(snap.sessionId, snapshotToAccum(snap));
  }

  // Live tasks — read concurrently; persisted wins on collision
  const activeSessions = store.list({ activeOnly: true });
  await Promise.all(
    activeSessions.map(async (s) => {
      if (taskMap.has(s.id)) return; // persisted wins
      const accum = await liveSessionToAccum(s, cutoff);
      if (accum) taskMap.set(s.id, accum);
    }),
  );

  // Satellite spawns
  attributeSatellites(taskMap, store.listReviewerSpawns());

  // Group by repo, sort, produce public breakdowns
  const repos = buildRepoBreakdowns(taskMap, apiKey);

  // Top-level aggregates
  const totals = aggregateTotals(taskMap, repos);

  return {
    range,
    generatedAt: now,
    ...totals,
    dollars: apiKey ? totals.totalUnits : null,
    repos,
  };
}
