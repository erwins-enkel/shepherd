import type { SessionStore } from "./store";
import type { UsageRange, UsageTimeline, UsageTimelineHour } from "./types";
import { isOperationalArchetype } from "./usage-archetype";
import { floorHour, type SessionUsageRollup } from "./usage";
import { weightedUnits } from "./pricing";

/** Compute the ms-epoch cutoff for the given range (0 ⇒ all-time). Mirrors usage-breakdown. */
function rangeCutoff(range: UsageRange, now: number): number {
  if (range === "24h") return now - 86_400_000;
  if (range === "7d") return now - 7 * 86_400_000;
  if (range === "30d") return now - 30 * 86_400_000;
  return 0;
}

/** Add `units` into `map` at hour key `h` (no-op for non-positive units). */
function addHour(map: Map<number, number>, h: number, units: number): void {
  if (units <= 0) return;
  map.set(h, (map.get(h) ?? 0) + units);
}

/** Live rollup contribution: refresh, then fold each active, non-bucketed session's hours. */
async function foldLiveSessions(
  hourMap: Map<number, number>,
  usageRollup: SessionUsageRollup,
  eligible: ReturnType<SessionStore["list"]>,
  bucketed: Set<string>,
  cutoff: number,
  now: number,
): Promise<void> {
  // Refresh here — nothing else does before this runs, so the Timeline tab would otherwise
  // show stale/empty live data when opened before Spend/Overhead.
  await usageRollup.refresh(
    eligible.map((s) => ({
      id: s.id,
      worktreePath: s.worktreePath,
      claudeSessionId: s.claudeSessionId,
    })),
    now,
  );
  for (const s of eligible) {
    if (bucketed.has(s.id)) continue; // persisted wins — avoid double-counting
    for (const [h, units] of usageRollup.hourlyUnits(s.id, cutoff)) addHour(hourMap, h, units);
  }
}

/** Reviewer-spawn (satellite) contribution: fold finalized spawns by their completion hour. */
function foldSpawns(hourMap: Map<number, number>, store: SessionStore, cutoff: number): void {
  for (const sp of store.listReviewerSpawns()) {
    if (sp.totalTokens == null) continue; // not finalized
    const t = sp.completedAt ?? sp.spawnedAt;
    if (t === 0 || t < cutoff) continue; // timeless or out of window
    const wu = weightedUnits(
      {
        input: sp.inputTokens ?? 0,
        output: sp.outputTokens ?? 0,
        cacheRead: sp.cacheReadTokens ?? 0,
        cacheWrite5m: sp.cacheWriteTokens ?? 0,
        cacheWrite1h: 0,
      },
      sp.model ?? "unknown",
    );
    addHour(hourMap, floorHour(t), wu);
  }
}

/** Collapse the hour→units map into the public timeline shape (ASC hours, totals, peak). */
function summarize(hourMap: Map<number, number>): {
  hours: UsageTimelineHour[];
  totalUnits: number;
  peakHourUnits: number;
} {
  const hours: UsageTimelineHour[] = [...hourMap.entries()]
    .map(([hourStart, units]) => ({ hourStart, units }))
    .sort((a, b) => a.hourStart - b.hourStart);
  let totalUnits = 0;
  let peakHourUnits = 0;
  for (const h of hours) {
    totalUnits += h.units;
    if (h.units > peakHourUnits) peakHourUnits = h.units;
  }
  return { hours, totalUnits, peakHourUnits };
}

/**
 * Per-hour weighted-unit timeline for the Timeline lens's day×hour heatmap.
 *
 * Sources, deduped the same way as buildUsageBreakdown ("persisted wins"):
 *  - persisted hourly buckets across all archived/snapshotted sessions (store),
 *  - live SessionUsageRollup hours for active eligible sessions NOT yet bucketed,
 *  - finalized reviewer spawns, bucketed by their own completedAt ?? spawnedAt.
 *
 * The rollup is refreshed here because nothing else does it before this runs — without it the
 * Timeline tab would show stale/empty live data when opened before Spend/Overhead.
 *
 * Timeless data (bucketStart/ts/spawn-time === 0) is excluded — it has no placeable hour.
 */
export async function buildUsageTimeline(opts: {
  store: SessionStore;
  range: UsageRange;
  now: number;
  usageRollup?: SessionUsageRollup;
}): Promise<UsageTimeline> {
  const { store, range, now } = opts;
  const cutoff = rangeCutoff(range, now);

  // 1. Persisted hourly buckets (archived/snapshotted sessions).
  const hourMap = store.sumUsageUnitsByHourSince(cutoff);

  // 2. Live rollup — active sessions not yet bucketed (refreshed inside the helper).
  const bucketed = store.bucketedSessionIds();
  const eligible = store
    .list({ activeOnly: true })
    .filter((s) => s.claudeSessionId && !isOperationalArchetype(s));
  if (opts.usageRollup) {
    await foldLiveSessions(hourMap, opts.usageRollup, eligible, bucketed, cutoff, now);
  }

  // 3. Reviewer spawns (satellite passes) — by their own completion time, the same timestamp
  //    axis satelliteUnitsByKind uses, so the timeline total tracks the Spend tab.
  foldSpawns(hourMap, store, cutoff);

  // 4. Emit ASC, non-empty hours only; totals span the full range.
  return { range, generatedAt: now, ...summarize(hourMap) };
}
