import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { buildUsageTimeline } from "../src/usage-timeline";
import { SessionUsageRollup, floorHour } from "../src/usage";
import { weightedUnits } from "../src/pricing";
import type { SessionUsageBucket, SessionUsageSnapshot } from "../src/types";

const NOW = 1_750_000_000_000; // fixed epoch ms
const HOUR = 3_600_000;
const H24 = 86_400_000;
const MODEL = "claude-opus-4-8";

function wu(input: number, output: number): number {
  return weightedUnits({ input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, MODEL);
}

/** Upsert a parent session_usage row (FK target) + its hourly bucket rows. */
function seedBuckets(
  store: SessionStore,
  sessionId: string,
  repoPath: string,
  buckets: Omit<SessionUsageBucket, "sessionId">[],
): void {
  const snap: SessionUsageSnapshot = {
    sessionId,
    desig: `T-${sessionId}`,
    name: sessionId,
    repoPath,
    model: MODEL,
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    total: 2,
    weightedUnits: 0,
    cacheReadUnits: 0,
    messageCount: 1,
    byModel: { [MODEL]: 0 },
    rawByModel: { [MODEL]: 2 },
    createdAt: NOW - H24,
    archivedAt: NOW - 500,
    snapshotAt: NOW - 500,
  };
  store.upsertSessionUsage(snap);
  store.replaceSessionUsageBuckets(
    sessionId,
    buckets.map((b) => ({ ...b, sessionId })),
  );
}

function bucket(bucketStart: number, units: number): Omit<SessionUsageBucket, "sessionId"> {
  return {
    bucketStart,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    weightedUnits: units,
    cacheReadUnits: 0,
    byModel: { [MODEL]: units },
    rawByModel: { [MODEL]: 0 },
  };
}

class TestRollup extends SessionUsageRollup {
  constructor(private dir: string) {
    super();
  }
  protected override pathFor(_worktreePath: string, claudeSessionId: string): string {
    return join(this.dir, `${claudeSessionId}.jsonl`);
  }
}

function asstLine(ts: number, input: number, output: number, requestId: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    requestId,
    message: {
      model: MODEL,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

// ── persisted buckets: cross-session aggregation, cutoff, timeless exclusion ────

test("persisted buckets aggregate per hour across sessions; bucketStart=0 excluded", async () => {
  const store = new SessionStore(":memory:");
  const sharedHour = floorHour(NOW - HOUR); // both sessions active this hour
  const otherHour = floorHour(NOW - 2 * HOUR);

  seedBuckets(store, "s1", "/repos/a", [
    bucket(sharedHour, wu(100, 50)),
    bucket(otherHour, wu(40, 10)),
    bucket(0, wu(999, 999)), // timeless — must be excluded from the timeline
  ]);
  seedBuckets(store, "s2", "/repos/b", [bucket(sharedHour, wu(200, 60))]);

  const tl = await buildUsageTimeline({ store, range: "all", now: NOW });

  // Two distinct hours (timeless dropped), ASC.
  expect(tl.hours.map((h) => h.hourStart)).toEqual([otherHour, sharedHour]);

  // sharedHour sums s1 + s2.
  const shared = tl.hours.find((h) => h.hourStart === sharedHour)!;
  expect(shared.units).toBeCloseTo(wu(100, 50) + wu(200, 60), 9);

  // totals span the (non-timeless) hours; peak is the bigger hour.
  expect(tl.totalUnits).toBeCloseTo(wu(40, 10) + wu(100, 50) + wu(200, 60), 9);
  expect(tl.peakHourUnits).toBeCloseTo(wu(100, 50) + wu(200, 60), 9);
});

test("range cutoff drops hours older than the window", async () => {
  const store = new SessionStore(":memory:");
  const recentHour = floorHour(NOW - HOUR); // inside 24h
  const oldHour = floorHour(NOW - 2 * H24); // outside 24h, inside 30d

  seedBuckets(store, "s1", "/repos/a", [
    bucket(recentHour, wu(100, 50)),
    bucket(oldHour, wu(80, 20)),
  ]);

  const tl24 = await buildUsageTimeline({ store, range: "24h", now: NOW });
  expect(tl24.hours.map((h) => h.hourStart)).toEqual([recentHour]);

  const tl30 = await buildUsageTimeline({ store, range: "30d", now: NOW });
  expect(tl30.hours.map((h) => h.hourStart)).toEqual([oldHour, recentHour]);
});

// ── satellite spawns fold in by completion hour ────────────────────────────────

test("finalized reviewer spawns add units at floorHour(completedAt); unfinalized excluded", async () => {
  const store = new SessionStore(":memory:");
  const spawnHour = floorHour(NOW - HOUR);

  store.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-a",
    kind: "review",
    worktreePath: "/wt",
    model: MODEL,
    spawnedAt: NOW - HOUR - 1000,
  });
  store.completeReviewerSpawn(
    "rev-1",
    {
      input: 300,
      output: 150,
      cacheRead: 0,
      cacheWrite: 0,
      total: 450,
      messageCount: 1,
      lastActivity: NOW - HOUR,
      byModel: { [MODEL]: 450 },
      rawByModel: { [MODEL]: 0 },
      fullRecaches: 0,
      sidechainCount: 0,
    },
    NOW - HOUR, // completedAt → lands in spawnHour
  );

  // Unfinalized spawn (never completed) must be ignored.
  store.recordReviewerSpawn({
    reviewerSessionId: "rev-2",
    taskSessionId: "task-b",
    kind: "plan_gate",
    worktreePath: "/wt",
    model: MODEL,
    spawnedAt: NOW - HOUR - 2000,
  });

  const tl = await buildUsageTimeline({ store, range: "all", now: NOW });
  expect(tl.hours).toHaveLength(1);
  expect(tl.hours[0]!.hourStart).toBe(spawnHour);
  expect(tl.hours[0]!.units).toBeCloseTo(wu(300, 150), 9);
});

// ── live rollup: refresh + fold; persisted wins (no double count) ──────────────

test("live rollup contributes hours for an active, non-bucketed session (refreshed in builder)", async () => {
  const dir = join(tmpdir(), `usage-timeline-rollup-${NOW}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const store = new SessionStore(":memory:");
    const csid = "live-csid";
    const sess = store.create({
      name: "TASK-LIVE",
      prompt: "x",
      repoPath: "/repos/live",
      baseBranch: "main",
      branch: "shepherd/live",
      worktreePath: "/wt/live",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "a1",
      sandboxApplied: null,
      sandboxDegraded: false,
      egressApplied: false,
      egressDegraded: false,
      research: false,
      epicAuthoring: false,
    });
    // @ts-expect-error internal db access for test setup
    store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [csid, sess.id]);

    const liveTs = NOW - HOUR; // inside 24h
    await Bun.write(join(dir, `${csid}.jsonl`), asstLine(liveTs, 200, 80, "live-r1") + "\n");

    const rollup = new TestRollup(dir);
    // Builder must refresh the rollup itself (nothing else does before this runs).
    const tl = await buildUsageTimeline({ store, range: "24h", now: NOW, usageRollup: rollup });

    expect(tl.hours).toHaveLength(1);
    expect(tl.hours[0]!.hourStart).toBe(floorHour(liveTs));
    expect(tl.hours[0]!.units).toBeCloseTo(wu(200, 80), 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── empty ──────────────────────────────────────────────────────────────────────

test("no data → empty hours, zero totals", async () => {
  const store = new SessionStore(":memory:");
  const tl = await buildUsageTimeline({ store, range: "7d", now: NOW });
  expect(tl.hours).toEqual([]);
  expect(tl.totalUnits).toBe(0);
  expect(tl.peakHourUnits).toBe(0);
  expect(tl.range).toBe("7d");
  expect(tl.generatedAt).toBe(NOW);
});
