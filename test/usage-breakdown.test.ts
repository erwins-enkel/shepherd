import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { buildUsageBreakdown } from "../src/usage-breakdown";
import { jsonlPathFor } from "../src/usage";
import { weightedUnits } from "../src/pricing";

const NOW = 1_750_000_000_000; // fixed epoch ms for tests
const H24 = 86_400_000;

// Build a minimal assistant JSONL line matching the shape parseLine expects.
function asst(opts: {
  model?: string;
  requestId?: string;
  ts?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  w5m?: number;
  w1h?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(opts.ts ?? NOW).toISOString(),
    requestId: opts.requestId ?? "r1",
    message: {
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: opts.w5m ?? 0,
          ephemeral_1h_input_tokens: opts.w1h ?? 0,
        },
      },
    },
  });
}

function writeJsonl(worktreePath: string, claudeSessionId: string, lines: string[]): void {
  const p = jsonlPathFor(worktreePath, claudeSessionId);
  mkdirSync(join(p, ".."), { recursive: true });
  Bun.write(p, lines.join("\n"));
}

let tmpDir: string;
let origProjectsDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `usage-breakdown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  origProjectsDir = config.claudeProjectsDir;
  config.claudeProjectsDir = tmpDir;
});

afterEach(() => {
  config.claudeProjectsDir = origProjectsDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers to build snapshots ────────────────────────────────────────────────

function makeSnap(over: {
  sessionId: string;
  desig: string;
  repoPath: string;
  model?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  weightedUnits: number;
  cacheReadUnits: number;
  byModel?: Record<string, number>;
  snapshotAt: number;
}) {
  const model = over.model ?? "claude-opus-4-8";
  const input = over.input;
  const output = over.output;
  const cacheRead = over.cacheRead ?? 0;
  const cacheWrite = over.cacheWrite ?? 0;
  return {
    sessionId: over.sessionId,
    desig: over.desig,
    repoPath: over.repoPath,
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    weightedUnits: over.weightedUnits,
    cacheReadUnits: over.cacheReadUnits,
    messageCount: 1,
    byModel: over.byModel ?? { [model]: input + output + cacheRead + cacheWrite },
    createdAt: over.snapshotAt - 1000,
    archivedAt: over.snapshotAt,
    snapshotAt: over.snapshotAt,
  };
}

// ── actual test suite ─────────────────────────────────────────────────────────

test("repo→task grouping, sorting, field mapping", async () => {
  const store = new SessionStore(":memory:");

  // Repo A: two tasks
  const snapA1Wu = weightedUnits(
    { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-4-8",
  );
  const snapA2Wu = weightedUnits(
    { input: 2000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-4-8",
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "s1",
      desig: "TASK-01",
      repoPath: "/repos/alpha",
      input: 1000,
      output: 500,
      weightedUnits: snapA1Wu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "s2",
      desig: "TASK-02",
      repoPath: "/repos/alpha",
      input: 2000,
      output: 1000,
      weightedUnits: snapA2Wu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );

  // Repo B: one task
  const snapBWu = weightedUnits(
    { input: 500, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-4-8",
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "s3",
      desig: "TASK-03",
      repoPath: "/repos/beta",
      input: 500,
      output: 200,
      weightedUnits: snapBWu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW });

  // Repos sorted by total desc: alpha (snapA1Wu+snapA2Wu) > beta (snapBWu)
  expect(bd.repos).toHaveLength(2);
  expect(bd.repos[0]!.repoPath).toBe("/repos/alpha");
  expect(bd.repos[1]!.repoPath).toBe("/repos/beta");

  // repoName = basename
  expect(bd.repos[0]!.repoName).toBe("alpha");
  expect(bd.repos[1]!.repoName).toBe("beta");

  // Within alpha: TASK-02 (bigger) before TASK-01
  const alphaTasks = bd.repos[0]!.tasks;
  expect(alphaTasks).toHaveLength(2);
  expect(alphaTasks[0]!.desig).toBe("TASK-02");
  expect(alphaTasks[1]!.desig).toBe("TASK-01");

  // Task field mapping
  const t1 = alphaTasks[1]!; // TASK-01
  expect(t1.sessionId).toBe("s1");
  expect(t1.authoringUnits).toBeCloseTo(snapA1Wu, 10);
  expect(t1.satelliteUnits).toBe(0);
  expect(t1.tokens.input).toBe(1000);
  expect(t1.tokens.output).toBe(500);
});

test("persisted range filter: stale snapshot absent at 24h, present at all/30d", async () => {
  const store = new SessionStore(":memory:");

  const recentAt = NOW - H24 / 2; // within 24h
  const staleAt = NOW - 2 * H24; // older than 24h but within 30d

  const recentWu = weightedUnits(
    { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-4-8",
  );
  const staleWu = weightedUnits(
    { input: 200, output: 80, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-4-8",
  );

  store.upsertSessionUsage(
    makeSnap({
      sessionId: "recent",
      desig: "TASK-01",
      repoPath: "/repos/foo",
      input: 100,
      output: 50,
      weightedUnits: recentWu,
      cacheReadUnits: 0,
      snapshotAt: recentAt,
    }),
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "stale",
      desig: "TASK-02",
      repoPath: "/repos/foo",
      input: 200,
      output: 80,
      weightedUnits: staleWu,
      cacheReadUnits: 0,
      snapshotAt: staleAt,
    }),
  );

  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW });
  const taskIds24h = bd24h.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(taskIds24h).toContain("recent");
  expect(taskIds24h).not.toContain("stale");

  const bdAll = await buildUsageBreakdown({ store, range: "all", now: NOW });
  const taskIdsAll = bdAll.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(taskIdsAll).toContain("recent");
  expect(taskIdsAll).toContain("stale");

  const bd30d = await buildUsageBreakdown({ store, range: "30d", now: NOW });
  const taskIds30d = bd30d.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(taskIds30d).toContain("recent");
  expect(taskIds30d).toContain("stale");
});

test("satellite: targeted task accumulates spawn cost; out-of-scope spawn ignored", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  const snapWu = weightedUnits(
    { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "task-a",
      desig: "TASK-01",
      repoPath: "/repos/foo",
      input: 1000,
      output: 500,
      weightedUnits: snapWu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );

  // Spawn targeting task-a
  const spawnInputTokens = 300;
  const spawnOutputTokens = 150;
  const spawnCacheRead = 50;
  store.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-a",
    kind: "review",
    worktreePath: "/wt",
    model,
    spawnedAt: NOW - 1000,
  });
  store.completeReviewerSpawn(
    "rev-1",
    {
      input: spawnInputTokens,
      output: spawnOutputTokens,
      cacheRead: spawnCacheRead,
      cacheWrite: 0,
      total: spawnInputTokens + spawnOutputTokens + spawnCacheRead,
      messageCount: 1,
      lastActivity: NOW - 500,
      byModel: { [model]: spawnInputTokens + spawnOutputTokens + spawnCacheRead },
      fullRecaches: 0,
      sidechainCount: 0,
    },
    NOW - 500,
  );

  // Out-of-scope spawn (task-b is not in the map)
  store.recordReviewerSpawn({
    reviewerSessionId: "rev-2",
    taskSessionId: "task-b-not-in-map",
    kind: "review",
    worktreePath: "/wt",
    model,
    spawnedAt: NOW - 2000,
  });
  store.completeReviewerSpawn(
    "rev-2",
    {
      input: 999,
      output: 999,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1998,
      messageCount: 1,
      lastActivity: NOW - 1500,
      byModel: { [model]: 1998 },
      fullRecaches: 0,
      sidechainCount: 0,
    },
    NOW - 1500,
  );

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW });

  const task = bd.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === "task-a");
  expect(task).toBeDefined();

  const expectedSatWu = weightedUnits(
    {
      input: spawnInputTokens,
      output: spawnOutputTokens,
      cacheRead: spawnCacheRead,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
    model,
  );
  expect(task!.satelliteUnits).toBeCloseTo(expectedSatWu, 10);
  expect(task!.authoringUnits).toBeCloseTo(snapWu, 10);
});

test("live per-record windowing: 24h reflects only recent record; all reflects both", async () => {
  const store = new SessionStore(":memory:");

  const worktreePath = "/wt/live-session";
  const claudeSessionId = "live-csid-1";
  const liveSessionId = store.create({
    name: "feat-live",
    prompt: "do something",
    repoPath: "/repos/live",
    baseBranch: "main",
    branch: "shepherd/feat-live",
    worktreePath,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
  }).id;

  // Patch claudeSessionId into the session via update... we need a workaround.
  // The store.create doesn't accept claudeSessionId in the new-session input,
  // so we use the store's pinSessionId if it exists, or update via db directly.
  // Actually: store.create accepts claudeSessionId as part of NewSession via the Omit type.
  // Let's check which fields are omitted — claudeSessionId IS omitted from NewSession
  // (it's set as "" at create time). We'll write the JSONL for the session with
  // the session id as the claudeSessionId workaround: use store.setClaudeSessionId or
  // look for another update path.

  // Since we can't easily set claudeSessionId via public API after create,
  // let's use the DB directly via internal access.
  // Actually let's just use a session that was created with claudeSessionId set.
  // Looking at test/drain.test.ts: store.create doesn't set claudeSessionId.
  // We need to use store's internal DB. Let's access it:
  // @ts-expect-error accessing internal db for test setup
  store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [
    claudeSessionId,
    liveSessionId,
  ]);

  const oldTs = NOW - 2 * H24; // 2 days ago (outside 24h but inside 30d and all)
  const recentTs = NOW - H24 / 2; // 12h ago (inside 24h)

  const oldRecord = asst({
    requestId: "r-old",
    ts: oldTs,
    model: "claude-opus-4-8",
    input: 500,
    output: 200,
  });
  const recentRecord = asst({
    requestId: "r-recent",
    ts: recentTs,
    model: "claude-opus-4-8",
    input: 300,
    output: 100,
  });

  writeJsonl(worktreePath, claudeSessionId, [oldRecord, recentRecord]);

  // 24h: only recent record
  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW });
  const task24h = bd24h.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === liveSessionId);
  expect(task24h).toBeDefined();
  expect(task24h!.tokens.input).toBe(300);
  expect(task24h!.tokens.output).toBe(100);

  // all: both records
  const bdAll = await buildUsageBreakdown({ store, range: "all", now: NOW });
  const taskAll = bdAll.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === liveSessionId);
  expect(taskAll).toBeDefined();
  expect(taskAll!.tokens.input).toBe(800);
  expect(taskAll!.tokens.output).toBe(300);
});

test("dedupe: live session also having a snapshot appears once (persisted wins)", async () => {
  const store = new SessionStore(":memory:");

  const worktreePath = "/wt/dedup-session";
  const claudeSessionId = "dedup-csid-1";

  // Create a live active session
  const liveSession = store.create({
    name: "feat-dedup",
    prompt: "dedup test",
    repoPath: "/repos/dedup",
    baseBranch: "main",
    branch: "shepherd/feat-dedup",
    worktreePath,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t2",
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
  });

  // @ts-expect-error accessing internal db for test setup
  store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [
    claudeSessionId,
    liveSession.id,
  ]);

  // Write a JSONL for the live session (different tokens from persisted)
  writeJsonl(worktreePath, claudeSessionId, [
    asst({ requestId: "r-live", ts: NOW, model: "claude-opus-4-8", input: 9999, output: 9999 }),
  ]);

  // Persist a snapshot for the SAME sessionId
  const snapWu = weightedUnits(
    { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-4-8",
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: liveSession.id,
      desig: "TASK-01",
      repoPath: "/repos/dedup",
      input: 100,
      output: 50,
      weightedUnits: snapWu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW });
  const tasks = bd.repos.flatMap((r) => r.tasks).filter((t) => t.sessionId === liveSession.id);

  // Only appears once (persisted wins — tokens from snapshot, not live)
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.tokens.input).toBe(100);
  expect(tasks[0]!.tokens.output).toBe(50);
});

test("operational-archetype live session excluded", async () => {
  const store = new SessionStore(":memory:");

  const worktreePath = "/wt/merge-train-session";
  const claudeSessionId = "mt-csid-1";

  // Create merge-train session (operational archetype)
  const mtSession = store.create({
    name: "merge-train",
    prompt: "merge train prompt",
    repoPath: "/repos/foo",
    baseBranch: "main",
    branch: "shepherd/merge-train",
    worktreePath,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t3",
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
  });

  // @ts-expect-error accessing internal db for test setup
  store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [
    claudeSessionId,
    mtSession.id,
  ]);

  writeJsonl(worktreePath, claudeSessionId, [
    asst({ requestId: "r1", ts: NOW, model: "claude-opus-4-8", input: 1000, output: 500 }),
  ]);

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW });
  const tasks = bd.repos.flatMap((r) => r.tasks);
  const found = tasks.find((t) => t.sessionId === mtSession.id);
  expect(found).toBeUndefined();
});

test("top-level invariants: cacheReadUnits + generationUnits === totalUnits, totalUnits === authoring + satellite", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  const cacheRead = 200;
  const snapWu = weightedUnits(
    { input: 1000, output: 500, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const cru = weightedUnits(
    { input: 0, output: 0, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );

  store.upsertSessionUsage(
    makeSnap({
      sessionId: "t1",
      desig: "TASK-01",
      repoPath: "/repos/x",
      input: 1000,
      output: 500,
      cacheRead,
      weightedUnits: snapWu,
      cacheReadUnits: cru,
      snapshotAt: NOW,
    }),
  );

  // Add a satellite spawn
  const spawnInput = 100;
  const spawnCacheRead = 30;
  store.recordReviewerSpawn({
    reviewerSessionId: "rev-inv",
    taskSessionId: "t1",
    kind: "review",
    worktreePath: "/wt",
    model,
    spawnedAt: NOW - 1000,
  });
  store.completeReviewerSpawn(
    "rev-inv",
    {
      input: spawnInput,
      output: 0,
      cacheRead: spawnCacheRead,
      cacheWrite: 0,
      total: spawnInput + spawnCacheRead,
      messageCount: 1,
      lastActivity: NOW - 500,
      byModel: { [model]: spawnInput + spawnCacheRead },
      fullRecaches: 0,
      sidechainCount: 0,
    },
    NOW - 500,
  );

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW });

  expect(bd.totalUnits).toBeCloseTo(bd.authoringUnits + bd.satelliteUnits, 10);
  expect(bd.totalUnits).toBeCloseTo(bd.cacheReadUnits + bd.generationUnits, 10);
  expect(bd.generationUnits).toBeGreaterThanOrEqual(0);
});

test("empty store returns zero-valued breakdown", async () => {
  const store = new SessionStore(":memory:");
  const bd = await buildUsageBreakdown({ store, range: "24h", now: NOW });

  expect(bd.range).toBe("24h");
  expect(bd.generatedAt).toBe(NOW);
  expect(bd.totalUnits).toBe(0);
  expect(bd.authoringUnits).toBe(0);
  expect(bd.satelliteUnits).toBe(0);
  expect(bd.cacheReadUnits).toBe(0);
  expect(bd.generationUnits).toBe(0);
  expect(bd.repos).toHaveLength(0);
});
