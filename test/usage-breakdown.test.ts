import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { buildUsageBreakdown } from "../src/usage-breakdown";
import { jsonlPathFor, SessionUsageRollup } from "../src/usage";
import { weightedUnits } from "../src/pricing";
import type { SessionUsageBucket, UsageRole } from "../src/types";

const NOW = 1_750_000_000_000; // fixed epoch ms for tests
const H24 = 86_400_000;
const CLASSIFIER_ROLE = "classifier" satisfies UsageRole;

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
  name?: string;
  repoPath: string;
  model?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  weightedUnits: number;
  cacheReadUnits: number;
  byModel?: Record<string, number>;
  rawByModel?: Record<string, number>;
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
    name: over.name ?? `name-${over.desig}`,
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
    rawByModel: over.rawByModel ?? { [model]: input + output + cacheRead + cacheWrite },
    createdAt: over.snapshotAt - 1000,
    archivedAt: over.snapshotAt,
    snapshotAt: over.snapshotAt,
  };
}

function seedRoleSpawn(
  store: SessionStore,
  r: {
    id: string;
    kind: "review" | "plan_gate" | "recap" | "rundown" | "doc_agent" | "classifier";
    provider: "claude" | "codex" | null;
    model: string | null;
    spawnedAt?: number;
    completedAt?: number | null;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    providerThreadId?: string | null;
    totalTokens?: number | null;
  },
): void {
  const input = r.input ?? 0;
  const output = r.output ?? 0;
  const cacheRead = r.cacheRead ?? 0;
  const cacheWrite = r.cacheWrite ?? 0;
  // @ts-expect-error accessing internal db for focused aggregate setup
  store.db.run(
    `INSERT INTO reviewer_spawns
       (reviewerSessionId, taskSessionId, kind, worktreePath, reviewerProvider, model,
        spawnedAt, completedAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
        totalTokens, providerThreadId)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      r.id,
      "task-a",
      r.kind,
      "/wt/" + r.id,
      r.provider,
      r.model,
      r.spawnedAt ?? NOW - 2_000,
      r.completedAt === undefined ? NOW - 1_000 : r.completedAt,
      input,
      output,
      cacheRead,
      cacheWrite,
      r.totalTokens === undefined ? input + output + cacheRead + cacheWrite : r.totalTokens,
      r.providerThreadId ?? null,
    ],
  );
}

// ── actual test suite ─────────────────────────────────────────────────────────

test("Claude model breakdown preserves role × model identity and exact token total", async () => {
  const store = new SessionStore(":memory:");
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "task-a",
      desig: "TASK-01",
      repoPath: "/repos/alpha",
      input: 100,
      output: 200,
      weightedUnits: 0,
      cacheReadUnits: 0,
      rawByModel: { "claude-opus-4-8": 100, "claude-sonnet-4-8": 200 },
      snapshotAt: NOW,
    }),
  );

  seedRoleSpawn(store, {
    id: "review",
    kind: "review",
    provider: "claude",
    model: "claude-opus-4-8",
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
  });
  seedRoleSpawn(store, {
    id: "plan",
    kind: "plan_gate",
    provider: "claude",
    model: "claude-sonnet-4-8",
    input: 50,
  });
  seedRoleSpawn(store, {
    id: "recap",
    kind: "recap",
    provider: null,
    model: "fable",
    input: 25,
  });
  seedRoleSpawn(store, {
    id: "rundown",
    kind: "rundown",
    provider: "claude",
    model: "claude-opus-4-8",
    output: 15,
  });
  seedRoleSpawn(store, {
    id: "doc",
    kind: "doc_agent",
    provider: "claude",
    model: "haiku",
    cacheRead: 10,
  });
  seedRoleSpawn(store, {
    id: "classifier",
    kind: CLASSIFIER_ROLE,
    provider: "claude",
    model: "haiku",
    input: 60,
  });

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });

  expect(bd.models.claude).toEqual({
    totalTokens: 560,
    byModel: {
      "claude-opus-4-8": 215,
      "claude-sonnet-4-8": 250,
      fable: 25,
      haiku: 70,
    },
    byRole: {
      coding: { "claude-opus-4-8": 100, "claude-sonnet-4-8": 200 },
      review: { "claude-opus-4-8": 100 },
      plan_gate: { "claude-sonnet-4-8": 50 },
      recap: { fable: 25 },
      rundown: { "claude-opus-4-8": 15 },
      doc_agent: { haiku: 10 },
      classifier: { haiku: 60 },
    },
  });
  expect(bd.models.codex.byRole).toEqual({});
  const roleTotal = Object.values(bd.models.claude.byRole).reduce(
    (total, models) => total + Object.values(models ?? {}).reduce((sum, tokens) => sum + tokens, 0),
    0,
  );
  expect(roleTotal).toBe(bd.models.claude.totalTokens);
});

test("legacy null-provider Claude classifier is anchored and range-filtered", async () => {
  const store = new SessionStore(":memory:");
  const accepted = [
    "fable",
    "opus",
    "opus[1m]",
    "sonnet",
    "sonnet[1m]",
    "haiku",
    "claude-opus-4-8",
    "claude-sonnet-4-20250514",
    "claude-haiku-3-5",
  ];
  accepted.forEach((model, index) => {
    seedRoleSpawn(store, {
      id: `accepted-${index}`,
      kind: "recap",
      provider: null,
      model,
      input: 1,
    });
  });
  for (const [index, model] of [
    "my-claude-opus-4-8",
    "claude-opus-latest",
    "gpt-5.5",
    "<synthetic>",
    " ",
  ].entries()) {
    seedRoleSpawn(store, {
      id: `rejected-${index}`,
      kind: "recap",
      provider: null,
      model,
      input: 100,
    });
  }
  seedRoleSpawn(store, {
    id: "explicit-codex-wins",
    kind: "review",
    provider: "codex",
    model: "claude-opus-4-8",
    input: 100,
  });
  seedRoleSpawn(store, {
    id: "stale",
    kind: "review",
    provider: "claude",
    model: "claude-opus-4-8",
    spawnedAt: NOW - 2 * H24,
    completedAt: null,
    input: 100,
  });

  const bd = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });

  expect(bd.models.claude.byRole).toEqual({
    recap: Object.fromEntries(accepted.map((model) => [model, 1])),
  });
  expect(bd.models.claude.totalTokens).toBe(accepted.length);
});

test("Codex roles reconcile to authoritative per-model totals with legacy usage in coding", async () => {
  const store = new SessionStore(":memory:");
  seedRoleSpawn(store, {
    id: "review",
    kind: "review",
    provider: "codex",
    model: "gpt-5.6",
    providerThreadId: "thread-review",
    totalTokens: 200,
  });
  seedRoleSpawn(store, {
    id: "plan",
    kind: "plan_gate",
    provider: "codex",
    model: "gpt-5.6",
    providerThreadId: "thread-plan",
    totalTokens: 100,
  });
  seedRoleSpawn(store, {
    id: "legacy",
    kind: "recap",
    provider: "codex",
    model: "gpt-5.6",
    totalTokens: 999,
  });
  seedRoleSpawn(store, {
    id: "old",
    kind: "review",
    provider: "codex",
    model: "gpt-5.6",
    providerThreadId: "thread-old",
    completedAt: NOW - 2 * H24,
    totalTokens: 500,
  });
  seedRoleSpawn(store, {
    id: "unfinished",
    kind: "review",
    provider: "codex",
    model: "gpt-5.6",
    providerThreadId: "thread-unfinished",
    completedAt: null,
    totalTokens: 500,
  });

  const bd = await buildUsageBreakdown({
    store,
    range: "24h",
    now: NOW,
    apiKey: false,
    codexModelUsage: () => ({ "gpt-5.6": 1_000, unknown: 300 }),
  });

  expect(bd.models.codex).toEqual({
    totalTokens: 1_300,
    byModel: { "gpt-5.6": 1_000, unknown: 300 },
    byRole: {
      review: { "gpt-5.6": 200 },
      plan_gate: { "gpt-5.6": 100 },
      coding: { "gpt-5.6": 700, unknown: 300 },
    },
  });
});

test("Codex role attribution is capped by each authoritative model budget", async () => {
  const store = new SessionStore(":memory:");
  seedRoleSpawn(store, {
    id: "review",
    kind: "review",
    provider: "codex",
    model: "gpt-5.6",
    providerThreadId: "thread-review",
    totalTokens: 200,
  });
  seedRoleSpawn(store, {
    id: "plan",
    kind: "plan_gate",
    provider: "codex",
    model: "gpt-5.6",
    providerThreadId: "thread-plan",
    totalTokens: 200,
  });

  const bd = await buildUsageBreakdown({
    store,
    range: "all",
    now: NOW,
    apiKey: false,
    codexModelUsage: () => ({ "gpt-5.6": 250 }),
  });

  expect(bd.models.codex.byRole).toEqual({
    review: { "gpt-5.6": 200 },
    plan_gate: { "gpt-5.6": 50 },
  });
});

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

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });

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
  expect(t1.name).toBe("name-TASK-01"); // short name threads snapshot → breakdown
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

  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });
  const taskIds24h = bd24h.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(taskIds24h).toContain("recent");
  expect(taskIds24h).not.toContain("stale");

  const bdAll = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });
  const taskIdsAll = bdAll.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(taskIdsAll).toContain("recent");
  expect(taskIdsAll).toContain("stale");

  const bd30d = await buildUsageBreakdown({ store, range: "30d", now: NOW, apiKey: false });
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

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });

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
    epicAuthoring: false,
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
  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });
  const task24h = bd24h.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === liveSessionId);
  expect(task24h).toBeDefined();
  expect(task24h!.tokens.input).toBe(300);
  expect(task24h!.tokens.output).toBe(100);

  // all: both records
  const bdAll = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });
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
    epicAuthoring: false,
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

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });
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
    epicAuthoring: false,
  });

  // @ts-expect-error accessing internal db for test setup
  store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [
    claudeSessionId,
    mtSession.id,
  ]);

  writeJsonl(worktreePath, claudeSessionId, [
    asst({ requestId: "r1", ts: NOW, model: "claude-opus-4-8", input: 1000, output: 500 }),
  ]);

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });
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

  const bd = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });

  expect(bd.totalUnits).toBeCloseTo(bd.authoringUnits + bd.satelliteUnits, 10);
  expect(bd.totalUnits).toBeCloseTo(bd.cacheReadUnits + bd.generationUnits, 10);
  expect(bd.generationUnits).toBeGreaterThanOrEqual(0);
});

test("empty store returns zero-valued breakdown", async () => {
  const store = new SessionStore(":memory:");
  const bd = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });

  expect(bd.range).toBe("24h");
  expect(bd.generatedAt).toBe(NOW);
  expect(bd.totalUnits).toBe(0);
  expect(bd.authoringUnits).toBe(0);
  expect(bd.satelliteUnits).toBe(0);
  expect(bd.cacheReadUnits).toBe(0);
  expect(bd.generationUnits).toBe(0);
  expect(bd.repos).toHaveLength(0);
});

test("apiKey gate: dollars non-null and equals total units when true, null when false", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  // Two repos, each with one task + satellite spend
  const snapAWu = weightedUnits(
    { input: 1000, output: 400, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "ak-s1",
      desig: "TASK-01",
      repoPath: "/repos/ak-alpha",
      input: 1000,
      output: 400,
      weightedUnits: snapAWu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );

  const snapBWu = weightedUnits(
    { input: 600, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "ak-s2",
      desig: "TASK-02",
      repoPath: "/repos/ak-beta",
      input: 600,
      output: 200,
      weightedUnits: snapBWu,
      cacheReadUnits: 0,
      snapshotAt: NOW,
    }),
  );

  // Add a satellite spawn on ak-s1 to ensure satelliteUnits are included
  const spawnInput = 200;
  const spawnOutput = 80;
  store.recordReviewerSpawn({
    reviewerSessionId: "ak-rev-1",
    taskSessionId: "ak-s1",
    kind: "review",
    worktreePath: "/wt",
    model,
    spawnedAt: NOW - 1000,
  });
  store.completeReviewerSpawn(
    "ak-rev-1",
    {
      input: spawnInput,
      output: spawnOutput,
      cacheRead: 0,
      cacheWrite: 0,
      total: spawnInput + spawnOutput,
      messageCount: 1,
      lastActivity: NOW - 500,
      byModel: { [model]: spawnInput + spawnOutput },
      fullRecaches: 0,
      sidechainCount: 0,
    },
    NOW - 500,
  );

  // apiKey: true — dollars must be non-null and equal authoringUnits + satelliteUnits
  const bdOn = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: true });

  expect(bdOn.dollars).not.toBeNull();
  expect(bdOn.dollars).toBeCloseTo(bdOn.authoringUnits + bdOn.satelliteUnits, 10);

  for (const repo of bdOn.repos) {
    expect(repo.dollars).not.toBeNull();
    expect(repo.dollars).toBeCloseTo(repo.authoringUnits + repo.satelliteUnits, 10);
    // per-task dollars must equal each task's own weighted units and sum to repo.dollars
    let taskDollarsSum = 0;
    for (const task of repo.tasks) {
      expect(task.dollars).not.toBeNull();
      expect(task.dollars).toBeCloseTo(task.authoringUnits + task.satelliteUnits, 10);
      taskDollarsSum += task.dollars!;
    }
    expect(taskDollarsSum).toBeCloseTo(repo.dollars!, 10);
  }

  // apiKey: false — dollars must be null at every level
  const bdOff = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });

  expect(bdOff.dollars).toBeNull();
  for (const repo of bdOff.repos) {
    expect(repo.dollars).toBeNull();
    for (const task of repo.tasks) {
      expect(task.dollars).toBeNull();
    }
  }
});

// ── Task 4: windowed bucket + rollup tests ────────────────────────────────────

// TestRollup subclass that uses worktreePath as directory directly (mirrors usage.test.ts pattern).
class TestRollup extends SessionUsageRollup {
  constructor(private dir: string) {
    super();
  }
  protected override pathFor(worktreePath: string, claudeSessionId: string): string {
    return join(this.dir, `${claudeSessionId}.jsonl`);
  }
}

/** Write a JSONL file to a TestRollup-compatible location. */
function writeRollupJsonl(dir: string, claudeSessionId: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true });
  Bun.write(join(dir, `${claudeSessionId}.jsonl`), lines.join("\n") + "\n");
}

/** Helper to create and wire a session in the store, patching claudeSessionId via DB. */
function createLiveSession(
  store: SessionStore,
  opts: {
    sessionId?: string; // optional: use a fixed id to make test deterministic
    worktreePath: string;
    claudeSessionId: string;
    repoPath: string;
    desig?: string;
  },
): string {
  const s = store.create({
    name: opts.desig ?? "test-session",
    prompt: "test",
    repoPath: opts.repoPath,
    baseBranch: "main",
    branch: "shepherd/test",
    worktreePath: opts.worktreePath,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
  });
  // @ts-expect-error accessing internal db for test setup
  store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [
    opts.claudeSessionId,
    s.id,
  ]);
  return s.id;
}

/** Insert a session_usage row + its bucket rows. */
function insertSnapshotWithBuckets(
  store: SessionStore,
  snap: Parameters<typeof makeSnap>[0],
  buckets: Omit<SessionUsageBucket, "sessionId">[],
): void {
  const snapRow = makeSnap(snap);
  store.upsertSessionUsage(snapRow);
  store.replaceSessionUsageBuckets(
    snap.sessionId,
    buckets.map((b) => ({ ...b, sessionId: snap.sessionId })),
  );
}

// ── Test 1: persisted windowed sub-session ────────────────────────────────────

test("persisted windowed sub-session: 24h returns only recent hour; 30d/all returns full total", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  // Two hours of activity
  const oldHour = NOW - 48 * 60 * 60 * 1000; // 48h ago (outside 24h, inside 30d)
  const oldHourFloor = oldHour - (oldHour % 3_600_000);
  const recentHour = NOW - 1 * 60 * 60 * 1000; // 1h ago (inside 24h)
  const recentHourFloor = recentHour - (recentHour % 3_600_000);

  const oldWu = weightedUnits(
    { input: 500, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const recentWu = weightedUnits(
    { input: 300, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const totalWu = weightedUnits(
    { input: 800, output: 300, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );

  insertSnapshotWithBuckets(
    store,
    {
      sessionId: "bucketed-s1",
      desig: "TASK-01",
      repoPath: "/repos/foo",
      model,
      input: 800,
      output: 300,
      weightedUnits: totalWu,
      cacheReadUnits: 0,
      snapshotAt: NOW - 500, // archived recently
    },
    [
      {
        bucketStart: oldHourFloor,
        input: 500,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        weightedUnits: oldWu,
        cacheReadUnits: 0,
        byModel: { [model]: oldWu },
        rawByModel: { [model]: 700 },
      },
      {
        bucketStart: recentHourFloor,
        input: 300,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        weightedUnits: recentWu,
        cacheReadUnits: 0,
        byModel: { [model]: recentWu },
        rawByModel: { [model]: 400 },
      },
    ],
  );

  // 24h: only recent bucket (straddling the cutoff — recentHour is inside 24h window)
  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });
  const task24h = bd24h.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === "bucketed-s1");
  expect(task24h).toBeDefined();
  expect(task24h!.tokens.input).toBe(300);
  expect(task24h!.tokens.output).toBe(100);
  expect(task24h!.authoringUnits).toBeCloseTo(recentWu, 10);
  expect(bd24h.models.claude).toEqual({
    totalTokens: 400,
    byModel: { [model]: 400 },
    byRole: { coding: { [model]: 400 } },
  });

  // 30d: both buckets (old hour is 48h ago, within 30d)
  const bd30d = await buildUsageBreakdown({ store, range: "30d", now: NOW, apiKey: false });
  const task30d = bd30d.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === "bucketed-s1");
  expect(task30d).toBeDefined();
  expect(task30d!.tokens.input).toBe(800);
  expect(task30d!.tokens.output).toBe(300);
  expect(task30d!.authoringUnits).toBeCloseTo(totalWu, 10);
  expect(bd30d.models.claude).toEqual({
    totalTokens: 1100,
    byModel: { [model]: 1100 },
    byRole: { coding: { [model]: 1100 } },
  });

  // all: uses aggregate row → same total
  const bdAll = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });
  const taskAll = bdAll.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === "bucketed-s1");
  expect(taskAll).toBeDefined();
  expect(taskAll!.tokens.input).toBe(800);
  expect(taskAll!.tokens.output).toBe(300);
  expect(taskAll!.authoringUnits).toBeCloseTo(totalWu, 10);
});

// ── Test 2: legacy fallback (no buckets) ─────────────────────────────────────

test("legacy fallback: no bucket rows → included whole iff snapshotAt >= cutoff", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  const recentAt = NOW - H24 / 2; // within 24h
  const staleAt = NOW - 2 * H24; // outside 24h

  const recentWu = weightedUnits(
    { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const staleWu = weightedUnits(
    { input: 200, output: 80, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );

  // No bucket rows inserted — legacy fallback
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "legacy-recent",
      desig: "TASK-01",
      repoPath: "/repos/foo",
      model,
      input: 100,
      output: 50,
      weightedUnits: recentWu,
      cacheReadUnits: 0,
      snapshotAt: recentAt,
    }),
  );
  store.upsertSessionUsage(
    makeSnap({
      sessionId: "legacy-stale",
      desig: "TASK-02",
      repoPath: "/repos/foo",
      model,
      input: 200,
      output: 80,
      weightedUnits: staleWu,
      cacheReadUnits: 0,
      snapshotAt: staleAt,
    }),
  );

  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });
  const ids24h = bd24h.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(ids24h).toContain("legacy-recent");
  expect(ids24h).not.toContain("legacy-stale");

  // Both appear in 30d (stale is 2d, within 30d)
  const bd30d = await buildUsageBreakdown({ store, range: "30d", now: NOW, apiKey: false });
  const ids30d = bd30d.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));
  expect(ids30d).toContain("legacy-recent");
  expect(ids30d).toContain("legacy-stale");
});

// ── Test 3: bucketed-zero dropped vs spawn-parent retained ────────────────────

test("bucketed zero-window: dropped when no spawn; retained as zero-authoring when spawn exists", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  // Two sessions: only old bucket (outside 24h). No bucket 0.
  // Session A: no spawn → should be DROPPED from 24h
  // Session B: has a completed spawn → should be RETAINED with authoringUnits 0

  const oldHour = NOW - 48 * 60 * 60 * 1000;
  const oldHourFloor = oldHour - (oldHour % 3_600_000);
  const oldWu = weightedUnits(
    { input: 400, output: 150, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const totalWu = oldWu; // only the old bucket

  for (const sessId of ["dropped-s", "retained-s"]) {
    store.upsertSessionUsage(
      makeSnap({
        sessionId: sessId,
        desig: sessId === "dropped-s" ? "TASK-10" : "TASK-11",
        repoPath: "/repos/bar",
        model,
        input: 400,
        output: 150,
        weightedUnits: totalWu,
        cacheReadUnits: 0,
        snapshotAt: NOW - 500,
      }),
    );
    store.replaceSessionUsageBuckets(sessId, [
      {
        sessionId: sessId,
        bucketStart: oldHourFloor,
        input: 400,
        output: 150,
        cacheRead: 0,
        cacheWrite: 0,
        weightedUnits: oldWu,
        cacheReadUnits: 0,
        byModel: { [model]: oldWu },
        rawByModel: { [model]: 550 },
      },
    ]);
  }

  // Add a completed spawn for retained-s
  const spawnWu = weightedUnits(
    { input: 200, output: 80, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  store.recordReviewerSpawn({
    reviewerSessionId: "rev-retained",
    taskSessionId: "retained-s",
    kind: "review",
    worktreePath: "/wt",
    model,
    spawnedAt: NOW - 2000,
  });
  store.completeReviewerSpawn(
    "rev-retained",
    {
      input: 200,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      total: 280,
      messageCount: 1,
      lastActivity: NOW - 1500,
      byModel: { [model]: 280 },
      fullRecaches: 0,
      sidechainCount: 0,
    },
    NOW - 1500,
  );

  const bd24h = await buildUsageBreakdown({ store, range: "24h", now: NOW, apiKey: false });
  const ids24h = bd24h.repos.flatMap((r) => r.tasks.map((t) => t.sessionId));

  // Session with no spawn is dropped
  expect(ids24h).not.toContain("dropped-s");

  // Session with completed spawn is retained
  expect(ids24h).toContain("retained-s");
  const retainedTask = bd24h.repos
    .flatMap((r) => r.tasks)
    .find((t) => t.sessionId === "retained-s");
  expect(retainedTask).toBeDefined();
  expect(retainedTask!.authoringUnits).toBe(0);
  // Satellite cost is attributed
  expect(retainedTask!.satelliteUnits).toBeCloseTo(spawnWu, 10);
});

// ── Test 4: live via rollup == re-parse fallback ──────────────────────────────

test("live via rollup == re-parse fallback: identical authoringUnits/tokens/byModel/model", async () => {
  const rollupDir = join(
    tmpdir(),
    `rollup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(rollupDir, { recursive: true });

  const store = new SessionStore(":memory:");
  const claudeSessionId = "live-rollup-csid";
  const worktreePath = "/wt/rollup-live";

  // Write JSONL fixture to tmpDir (for TestRollup) AND to the real config.claudeProjectsDir path
  // (for the liveSessionToAccum re-parse fallback).
  const model = "claude-opus-4-8";
  const lines = [
    asst({ requestId: "rr1", ts: NOW - H24 / 4, model, input: 300, output: 120, cacheRead: 50 }),
    asst({ requestId: "rr2", ts: NOW - H24 / 8, model, input: 150, output: 60 }),
  ];

  // Write for re-parse fallback (uses config.claudeProjectsDir + dashified worktreePath)
  writeJsonl(worktreePath, claudeSessionId, lines);

  // Write for TestRollup (uses rollupDir + claudeSessionId.jsonl)
  writeRollupJsonl(rollupDir, claudeSessionId, lines);

  // Create live session in store
  const sessId = createLiveSession(store, {
    worktreePath,
    claudeSessionId,
    repoPath: "/repos/rollup-test",
  });

  const rollup = new TestRollup(rollupDir);

  // Build WITH rollup
  const bdWithRollup = await buildUsageBreakdown({
    store,
    range: "24h",
    now: NOW,
    apiKey: false,
    usageRollup: rollup,
  });
  const taskWithRollup = bdWithRollup.repos
    .flatMap((r) => r.tasks)
    .find((t) => t.sessionId === sessId);

  // Build WITHOUT rollup (re-parse fallback)
  const bdFallback = await buildUsageBreakdown({
    store,
    range: "24h",
    now: NOW,
    apiKey: false,
  });
  const taskFallback = bdFallback.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === sessId);

  expect(taskWithRollup).toBeDefined();
  expect(taskFallback).toBeDefined();

  // Both paths must agree on all fields
  expect(taskWithRollup!.tokens.input).toBe(taskFallback!.tokens.input);
  expect(taskWithRollup!.tokens.output).toBe(taskFallback!.tokens.output);
  expect(taskWithRollup!.tokens.cacheRead).toBe(taskFallback!.tokens.cacheRead);
  expect(taskWithRollup!.tokens.cacheWrite).toBe(taskFallback!.tokens.cacheWrite);
  expect(taskWithRollup!.authoringUnits).toBeCloseTo(taskFallback!.authoringUnits, 10);
  expect(taskWithRollup!.model).toBe(taskFallback!.model);
  expect(taskWithRollup!.byModel).toEqual(taskFallback!.byModel);
  expect(bdWithRollup.models.claude).toEqual(bdFallback.models.claude);

  // Sanity: actual values match the 24h window (both records are within 24h)
  expect(taskWithRollup!.tokens.input).toBe(450);
  expect(taskWithRollup!.tokens.output).toBe(180);

  rmSync(rollupDir, { recursive: true, force: true });
});

// ── Test 5: cutoff===0 persisted uses aggregate rows ─────────────────────────

test("cutoff===0 persisted uses aggregate rows (bucketed session all-time = aggregate row)", async () => {
  const store = new SessionStore(":memory:");
  const model = "claude-opus-4-8";

  const oldHour = NOW - 48 * 60 * 60 * 1000;
  const oldHourFloor = oldHour - (oldHour % 3_600_000);
  const recentHour = NOW - 1 * 60 * 60 * 1000;
  const recentHourFloor = recentHour - (recentHour % 3_600_000);

  const oldWu = weightedUnits(
    { input: 500, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const recentWu = weightedUnits(
    { input: 300, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );
  const totalWu = weightedUnits(
    { input: 800, output: 300, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );

  insertSnapshotWithBuckets(
    store,
    {
      sessionId: "all-time-s",
      desig: "TASK-01",
      repoPath: "/repos/alltime",
      model,
      input: 800,
      output: 300,
      weightedUnits: totalWu,
      cacheReadUnits: 0,
      snapshotAt: NOW - 500,
    },
    [
      {
        bucketStart: oldHourFloor,
        input: 500,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        weightedUnits: oldWu,
        cacheReadUnits: 0,
        byModel: { [model]: oldWu },
        rawByModel: { [model]: 700 },
      },
      {
        bucketStart: recentHourFloor,
        input: 300,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        weightedUnits: recentWu,
        cacheReadUnits: 0,
        byModel: { [model]: recentWu },
        rawByModel: { [model]: 400 },
      },
    ],
  );

  const bdAll = await buildUsageBreakdown({ store, range: "all", now: NOW, apiKey: false });
  const taskAll = bdAll.repos.flatMap((r) => r.tasks).find((t) => t.sessionId === "all-time-s");
  expect(taskAll).toBeDefined();
  // Must use aggregate row (input=800, output=300), not just recent bucket
  expect(taskAll!.tokens.input).toBe(800);
  expect(taskAll!.tokens.output).toBe(300);
  expect(taskAll!.authoringUnits).toBeCloseTo(totalWu, 10);
});
