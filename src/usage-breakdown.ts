import { basename } from "node:path";
import type { SessionStore } from "./store";
import { MODELS } from "./types";
import type {
  UsageByRole,
  UsageRange,
  UsageBreakdown,
  UsageKindUnits,
  UsageRepoBreakdown,
  UsageTaskBreakdown,
  UsageTokens,
  WindowedBucketSum,
} from "./types";
import { isOperationalArchetype } from "./usage-archetype";
import { jsonlPathFor, sessionCost, dominantModel, SessionUsageRollup } from "./usage";
import { weightedUnits } from "./pricing";

const CLAUDE_MODEL_ALIASES = new Set<string>(MODELS);
const CLAUDE_FULL_MODEL_ID = /^claude-(?:opus|sonnet|haiku)(?:-\d+)+$/i;

/** Internal accumulator — public fields + private cacheRead accumulators. */
interface TaskAccum {
  sessionId: string;
  desig: string;
  name: string;
  model: string;
  repoPath: string;
  authoringUnits: number;
  satelliteUnits: number;
  tokens: UsageTokens;
  byModel: Record<string, number>;
  rawByModel: Record<string, number>;
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
    name: snap.name,
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
    rawByModel: snap.rawByModel,
    authoringCacheReadUnits: snap.cacheReadUnits,
    satelliteCacheReadUnits: 0,
  };
}

/** Build a TaskAccum from a persisted snapshot + windowed bucket sums. */
function windowedSnapshotToAccum(
  snap: ReturnType<SessionStore["listSessionUsage"]>[number],
  w: WindowedBucketSum,
): TaskAccum {
  return {
    sessionId: snap.sessionId,
    desig: snap.desig,
    name: snap.name,
    model: snap.model,
    repoPath: snap.repoPath,
    authoringUnits: w.weightedUnits,
    satelliteUnits: 0,
    tokens: {
      input: w.input,
      output: w.output,
      cacheRead: w.cacheRead,
      cacheWrite: w.cacheWrite,
    },
    byModel: w.byModel,
    rawByModel: w.rawByModel,
    authoringCacheReadUnits: w.cacheReadUnits,
    satelliteCacheReadUnits: 0,
  };
}

/** Build a zero-authoring TaskAccum for a spawn-parent session with no in-window activity. */
function zeroAuthoringAccum(snap: ReturnType<SessionStore["listSessionUsage"]>[number]): TaskAccum {
  return {
    sessionId: snap.sessionId,
    desig: snap.desig,
    name: snap.name,
    model: snap.model,
    repoPath: snap.repoPath,
    authoringUnits: 0,
    satelliteUnits: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: {},
    rawByModel: {},
    authoringCacheReadUnits: 0,
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

  const path = jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const text = await file.text();
  const sc = sessionCost(text.split("\n"), cutoff);
  if (sc.usage.messageCount === 0) return null;

  return {
    sessionId: s.id,
    desig: s.desig,
    name: s.name,
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
    rawByModel: sc.usage.byModel,
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

/**
 * Global per-kind satellite tally, filtered by the spawn's OWN timestamp
 * (`completedAt ?? spawnedAt >= cutoff`; `cutoff === 0` ⇒ all-time).
 *
 * Deliberately independent of `attributeSatellites`: that path only counts a spawn when its
 * parent task is in the in-range task map, which silently drops the three unattributed
 * shapes — `rundown` (taskSessionId ""), `doc_agent` (repo path), and the standalone PR
 * critic ("pr:<repo>#<n>"). Here every completed spawn is counted by its kind, so those
 * surface. Because the filter axis differs (spawn time vs parent presence), the sum of this
 * tally is NOT comparable in any fixed direction to the per-task `satelliteUnits` total.
 */
function satelliteUnitsByKind(
  spawns: ReturnType<SessionStore["listReviewerSpawns"]>,
  cutoff: number,
): UsageKindUnits[] {
  const byKind = new Map<string, { units: number; count: number }>();
  for (const sp of spawns) {
    if (sp.totalTokens == null) continue; // not yet finalized
    if ((sp.completedAt ?? sp.spawnedAt) < cutoff) continue;

    const model = sp.model ?? "unknown";
    // Map ReviewerSpawnRow fields explicitly into weightedUnits' shape — a spread would not
    // match (row uses inputTokens/.../cacheWriteTokens; the fn wants input/.../cacheWrite5m).
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

    const bucket = byKind.get(sp.kind) ?? { units: 0, count: 0 };
    bucket.units += wu;
    bucket.count += 1;
    byKind.set(sp.kind, bucket);
  }

  return [...byKind.entries()]
    .map(([kind, b]) => ({ kind, units: b.units, count: b.count }))
    .sort((a, b) => b.units - a.units);
}

function usableModel(model: string | null): string | null {
  const normalized = model?.trim();
  if (!normalized || normalized === "<synthetic>") return null;
  return normalized;
}

function isLegacyClaudeModel(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.has(model) || CLAUDE_FULL_MODEL_ID.test(model);
}

function claudeUsageByRole(
  taskMap: Map<string, TaskAccum>,
  spawns: ReturnType<SessionStore["listReviewerSpawns"]>,
  cutoff: number,
): UsageByRole {
  const byRole: UsageByRole = {};
  const coding: Record<string, number> = {};

  for (const task of taskMap.values()) {
    for (const [rawModel, tokens] of Object.entries(task.rawByModel)) {
      const model = usableModel(rawModel);
      if (!model || tokens <= 0) continue;
      coding[model] = (coding[model] ?? 0) + tokens;
    }
  }
  if (Object.keys(coding).length > 0) byRole.coding = coding;

  for (const sp of spawns) {
    if (sp.totalTokens == null) continue;
    if ((sp.completedAt ?? sp.spawnedAt) < cutoff) continue;

    const model = usableModel(sp.model);
    if (!model) continue;
    const isClaude =
      sp.reviewerProvider === "claude" ||
      (sp.reviewerProvider == null && isLegacyClaudeModel(model));
    if (!isClaude) continue;

    const tokens =
      (sp.inputTokens ?? 0) +
      (sp.outputTokens ?? 0) +
      (sp.cacheReadTokens ?? 0) +
      (sp.cacheWriteTokens ?? 0);
    if (tokens <= 0) continue;

    const role = byRole[sp.kind] ?? {};
    role[model] = (role[model] ?? 0) + tokens;
    byRole[sp.kind] = role;
  }

  return byRole;
}

function foldModels(byRole: UsageByRole): Record<string, number> {
  const byModel: Record<string, number> = {};
  for (const models of Object.values(byRole)) {
    if (!models) continue;
    for (const [model, tokens] of Object.entries(models)) {
      byModel[model] = (byModel[model] ?? 0) + tokens;
    }
  }
  return byModel;
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
      name: t.name,
      model: t.model,
      authoringUnits: t.authoringUnits,
      satelliteUnits: t.satelliteUnits,
      // `$` = the task's accumulated list-price units (authoring + satellite), exactly as the
      // repo/total `$` does — NOT pricing.dollars() on aggregate tokens with the dominant model,
      // which would diverge from the units shown in the same row. Sums to repo.dollars.
      dollars: apiKey ? t.authoringUnits + t.satelliteUnits : null,
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

/** Populate taskMap with windowed persisted tasks (cutoff > 0 path). */
function addWindowedPersistedTasks(
  taskMap: Map<string, TaskAccum>,
  store: SessionStore,
  snapshots: ReturnType<SessionStore["listSessionUsage"]>,
  cutoff: number,
): void {
  const bucketed = store.bucketedSessionIds();
  const sums = store.sumSessionUsageBucketsSince(cutoff);
  const spawnParents = new Set(
    store
      .listReviewerSpawns()
      .filter((sp) => sp.totalTokens != null)
      .map((sp) => sp.taskSessionId),
  );

  for (const snap of snapshots) {
    if (!bucketed.has(snap.sessionId)) {
      // Legacy row (no bucket rows) — include whole iff snapshotAt >= cutoff
      if (snap.snapshotAt >= cutoff) taskMap.set(snap.sessionId, snapshotToAccum(snap));
      continue;
    }
    const w = sums.get(snap.sessionId);
    if (w) {
      // Has in-window bucket activity — use windowed sums
      taskMap.set(snap.sessionId, windowedSnapshotToAccum(snap, w));
    } else if (spawnParents.has(snap.sessionId)) {
      // No in-window authoring but has a completed spawn — retain so satellite attaches
      taskMap.set(snap.sessionId, zeroAuthoringAccum(snap));
    }
    // else: drop (no in-window activity, no spawn)
  }
}

/** Populate taskMap with live rollup tasks (usageRollup path). */
async function addLiveRollupTasks(
  taskMap: Map<string, TaskAccum>,
  rollup: SessionUsageRollup,
  eligible: ReturnType<SessionStore["list"]>,
  cutoff: number,
  now: number,
): Promise<void> {
  await rollup.refresh(
    eligible.map((s) => ({
      id: s.id,
      worktreePath: s.worktreePath,
      claudeSessionId: s.claudeSessionId,
      spawnAccountDir: s.spawnAccountDir,
    })),
    now,
  );
  for (const s of eligible) {
    if (taskMap.has(s.id)) continue; // persisted wins
    const w = rollup.windowedAccum(s.id, cutoff);
    if (!w) continue;
    taskMap.set(s.id, {
      sessionId: s.id,
      desig: s.desig,
      name: s.name,
      model: w.dominantModel ?? s.model ?? "unknown",
      repoPath: s.repoPath,
      authoringUnits: w.weightedUnits,
      satelliteUnits: 0,
      tokens: {
        input: w.input,
        output: w.output,
        cacheRead: w.cacheRead,
        cacheWrite: w.cacheWrite,
      },
      byModel: w.byModel,
      rawByModel: w.rawByModel,
      authoringCacheReadUnits: w.cacheReadUnits,
      satelliteCacheReadUnits: 0,
    });
  }
}

export async function buildUsageBreakdown(opts: {
  store: SessionStore;
  range: UsageRange;
  now: number;
  apiKey: boolean;
  usageRollup?: SessionUsageRollup;
  codexModelUsage?: (cutoff: number) => Record<string, number>;
}): Promise<UsageBreakdown> {
  const { store, range, now, apiKey } = opts;

  const cutoff = rangeCutoff(range, now);

  // Task accumulator map keyed by sessionId
  const taskMap = new Map<string, TaskAccum>();

  // Persisted tasks
  const snapshots = store.listSessionUsage();

  if (cutoff === 0) {
    // "all" range: unchanged — aggregate rows are exact all-time totals
    for (const snap of snapshots) {
      taskMap.set(snap.sessionId, snapshotToAccum(snap));
    }
  } else {
    addWindowedPersistedTasks(taskMap, store, snapshots, cutoff);
  }

  // Live tasks — rollup path if provided, else re-parse fallback
  const activeSessions = store.list({ activeOnly: true });
  const eligible = activeSessions.filter((s) => s.claudeSessionId && !isOperationalArchetype(s));

  if (opts.usageRollup) {
    await addLiveRollupTasks(taskMap, opts.usageRollup, eligible, cutoff, now);
  } else {
    // Back-compat: re-parse JSONL for each active session
    await Promise.all(
      activeSessions.map(async (s) => {
        if (taskMap.has(s.id)) return; // persisted wins
        const accum = await liveSessionToAccum(s, cutoff);
        if (accum) taskMap.set(s.id, accum);
      }),
    );
  }

  // Satellite spawns — runs AFTER both persisted and live loops
  const spawns = store.listReviewerSpawns();
  attributeSatellites(taskMap, spawns);

  // Group by repo, sort, produce public breakdowns
  const repos = buildRepoBreakdowns(taskMap, apiKey);

  // Top-level aggregates
  const totals = aggregateTotals(taskMap, repos);

  // Global per-kind satellite tally — spawn-timestamp-filtered, independent of attribution.
  const satelliteByKind = satelliteUnitsByKind(spawns, cutoff);

  const claudeByRole = claudeUsageByRole(taskMap, spawns, cutoff);
  const claudeByModel = foldModels(claudeByRole);
  const codexByModel = opts.codexModelUsage?.(cutoff) ?? {};
  const modelBreakdown = (byModel: Record<string, number>, byRole: UsageByRole = {}) => ({
    totalTokens: Object.values(byModel).reduce((sum, tokens) => sum + tokens, 0),
    byModel,
    byRole,
  });

  return {
    range,
    generatedAt: now,
    ...totals,
    satelliteByKind,
    dollars: apiKey ? totals.totalUnits : null,
    models: {
      claude: modelBreakdown(claudeByModel, claudeByRole),
      codex: modelBreakdown(codexByModel),
    },
    repos,
  };
}
