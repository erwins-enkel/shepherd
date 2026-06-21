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

export async function buildUsageBreakdown(opts: {
  store: SessionStore;
  range: UsageRange;
  now: number;
}): Promise<UsageBreakdown> {
  const { store, range, now } = opts;

  // 1. Compute cutoff
  let cutoff: number;
  if (range === "24h") cutoff = now - 86_400_000;
  else if (range === "7d") cutoff = now - 7 * 86_400_000;
  else if (range === "30d") cutoff = now - 30 * 86_400_000;
  else cutoff = 0;

  // 2. Task accumulator map keyed by sessionId
  const taskMap = new Map<string, TaskAccum>();

  // 3. Persisted tasks
  const snapshots = store.listSessionUsage();
  for (const snap of snapshots) {
    if (snap.snapshotAt < cutoff) continue;
    taskMap.set(snap.sessionId, {
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
    });
  }

  // 4. Live tasks — read concurrently
  const activeSessions = store.list({ activeOnly: true });
  await Promise.all(
    activeSessions.map(async (s) => {
      if (!s.claudeSessionId) return;
      if (isOperationalArchetype(s)) return;
      if (taskMap.has(s.id)) return; // persisted wins

      const path = jsonlPathFor(s.worktreePath, s.claudeSessionId);
      const file = Bun.file(path);
      if (!(await file.exists())) return;

      const text = await file.text();
      const sc = sessionCost(text.split("\n"), cutoff);
      if (sc.usage.messageCount === 0) return;

      taskMap.set(s.id, {
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
      });
    }),
  );

  // 5. Satellite spawns
  const spawns = store.listReviewerSpawns();
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

  // 6. Group by repo
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
    // Sort tasks by total desc
    tasks.sort(
      (a, b) => b.authoringUnits + b.satelliteUnits - (a.authoringUnits + a.satelliteUnits),
    );

    const repoAuthoring = tasks.reduce((s, t) => s + t.authoringUnits, 0);
    const repoSatellite = tasks.reduce((s, t) => s + t.satelliteUnits, 0);

    const repoName = basename(repoPath) || repoPath;

    // Emit public UsageTaskBreakdown objects (drop private cacheRead accumulators)
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
      tasks: publicTasks,
    });
  }

  // Sort repos by total desc
  repos.sort((a, b) => b.authoringUnits + b.satelliteUnits - (a.authoringUnits + a.satelliteUnits));

  // 7. Top-level aggregates
  const authoringUnits = repos.reduce((s, r) => s + r.authoringUnits, 0);
  const satelliteUnits = repos.reduce((s, r) => s + r.satelliteUnits, 0);
  const totalUnits = authoringUnits + satelliteUnits;

  let cacheReadUnits = 0;
  for (const task of taskMap.values()) {
    cacheReadUnits += task.authoringCacheReadUnits + task.satelliteCacheReadUnits;
  }
  const generationUnits = Math.max(0, totalUnits - cacheReadUnits);

  // 8. Return
  return {
    range,
    generatedAt: now,
    totalUnits,
    authoringUnits,
    satelliteUnits,
    cacheReadUnits,
    generationUnits,
    repos,
  };
}
