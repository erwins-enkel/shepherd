import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import {
  USAGE_BREAKDOWN_KEYS,
  USAGE_KIND_UNITS_KEYS,
  USAGE_MODEL_BREAKDOWN_KEYS,
  USAGE_REPO_KEYS,
  USAGE_TASK_KEYS,
  USAGE_TOKENS_KEYS,
} from "../src/types";
import type { SessionUsageSnapshot } from "../src/types";
import { SessionUsageRollup } from "../src/usage";

function harness(overrides: Partial<AppDeps> = {}): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    ...overrides,
  };
  return { app: makeApp(deps), store };
}

function exactKeys(obj: object, keys: readonly string[]): void {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  expect(actual).toEqual(expected);
}

const NOW = Date.now();

function seedSnapshot(store: SessionStore, overrides: Partial<SessionUsageSnapshot> = {}): void {
  const snap: SessionUsageSnapshot = {
    sessionId: "sess-usage-1",
    desig: "TASK-01",
    name: "my-feature",
    repoPath: "/home/user/repos/my-project",
    model: "claude-sonnet-4",
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 100,
    total: 3600,
    weightedUnits: 0.05,
    cacheReadUnits: 0.01,
    messageCount: 10,
    byModel: { "claude-sonnet-4": 0.05 },
    rawByModel: { "claude-sonnet-4": 3600 },
    createdAt: NOW - 1000,
    archivedAt: NOW - 500,
    snapshotAt: NOW - 100,
    ...overrides,
  };
  store.upsertSessionUsage(snap);
}

// ── GET /api/usage/breakdown ──────────────────────────────────────────────────

test("GET /api/usage/breakdown?range=7d → 200 with correct shape", async () => {
  const { app, store } = harness();
  seedSnapshot(store);

  const res = await app.fetch(new Request("http://x/api/usage/breakdown?range=7d"));
  expect(res.status).toBe(200);

  const body = await res.json();
  exactKeys(body, USAGE_BREAKDOWN_KEYS);
  expect(body.range).toBe("7d");
  // api-key gate: subscription harness defaults to non-api-key mode → dollars must be null
  expect(body.dollars).toBeNull();
  expect(Object.keys(body.models).sort()).toEqual(["claude", "codex"]);
  exactKeys(body.models.claude, USAGE_MODEL_BREAKDOWN_KEYS);
  exactKeys(body.models.codex, USAGE_MODEL_BREAKDOWN_KEYS);
  expect(body.models.claude).toEqual({
    totalTokens: 3600,
    byModel: { "claude-sonnet-4": 3600 },
    byRole: { coding: { "claude-sonnet-4": 3600 } },
  });
  expect(body.models.codex).toEqual({ totalTokens: 0, byModel: {}, byRole: {} });

  for (const repo of body.repos) {
    exactKeys(repo, USAGE_REPO_KEYS);
    expect(repo.dollars).toBeNull();
    for (const task of repo.tasks) {
      exactKeys(task, USAGE_TASK_KEYS);
      exactKeys(task.tokens, USAGE_TOKENS_KEYS);
      // subscription harness is non-api-key mode → task dollars must be null
      expect(task.dollars).toBeNull();
    }
  }

  expect(Array.isArray(body.satelliteByKind)).toBe(true);
  for (const k of body.satelliteByKind) {
    exactKeys(k, USAGE_KIND_UNITS_KEYS);
  }
});

test("GET /api/usage/breakdown (no range) → 200 with range=7d default", async () => {
  const { app, store } = harness();
  seedSnapshot(store);

  const res = await app.fetch(new Request("http://x/api/usage/breakdown"));
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.range).toBe("7d");
});

test("GET /api/usage/breakdown?range=bogus → 400", async () => {
  const { app } = harness();

  const res = await app.fetch(new Request("http://x/api/usage/breakdown?range=bogus"));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("invalid range");
});

test("GET /api/usage/breakdown forwards cutoff to the Codex model dependency", async () => {
  let receivedCutoff: number | null = null;
  const { app } = harness({
    codexModelUsage: (cutoff) => {
      receivedCutoff = cutoff;
      return { "gpt-5.5": 700, unknown: 300 };
    },
  });

  const before = Date.now() - 7 * 86_400_000;
  const body = await (await app.fetch(new Request("http://x/api/usage/breakdown?range=7d"))).json();
  const after = Date.now() - 7 * 86_400_000;
  expect(receivedCutoff).toBeGreaterThanOrEqual(before);
  expect(receivedCutoff).toBeLessThanOrEqual(after);
  expect(body.models.codex).toEqual({
    totalTokens: 1000,
    byModel: { "gpt-5.5": 700, unknown: 300 },
    byRole: {},
  });
});

// ── satelliteByKind: global per-kind tally incl. unattributed buckets ─────────

/** Insert a completed reviewer-spawn row directly (full control over totals + completedAt). */
function seedSpawn(
  store: SessionStore,
  r: {
    id: string;
    taskSessionId: string;
    kind: "review" | "plan_gate" | "recap" | "rundown" | "doc_agent";
    model: string;
    inputTokens: number | null; // null totalTokens ⇒ unfinalized (must be excluded)
    completedAt: number;
  },
): void {
  const total = r.inputTokens == null ? null : r.inputTokens;
  // @ts-expect-error accessing internal db for test setup
  store.db.run(
    `INSERT INTO reviewer_spawns
       (reviewerSessionId, taskSessionId, kind, worktreePath, model, spawnedAt,
        completedAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      r.id,
      r.taskSessionId,
      r.kind,
      "/wt/" + r.id,
      r.model,
      r.completedAt - 1000,
      r.completedAt,
      r.inputTokens,
      0,
      0,
      0,
      total,
    ],
  );
}

test("GET /api/usage/breakdown → satelliteByKind groups all kinds incl. unattributed buckets", async () => {
  const { app, store } = harness();
  const M = "claude-opus-4-8";

  // Two reviews — one a managed-session critic, one a STANDALONE PR critic ("pr:<repo>#<n>",
  // no parent session). Both must fold into a single review entry with count 2.
  seedSpawn(store, {
    id: "rv-1",
    taskSessionId: "sess-x",
    kind: "review",
    model: M,
    inputTokens: 1000,
    completedAt: NOW - 1_000,
  });
  seedSpawn(store, {
    id: "rv-2",
    taskSessionId: "pr:/home/user/repos/my-project#5",
    kind: "review",
    model: M,
    inputTokens: 2000,
    completedAt: NOW - 2_000,
  });
  // Herd-wide rundown (taskSessionId "") — unattributed today; must still be counted.
  seedSpawn(store, {
    id: "rd-1",
    taskSessionId: "",
    kind: "rundown",
    model: M,
    inputTokens: 9000,
    completedAt: NOW - 3_000,
  });
  seedSpawn(store, {
    id: "rc-1",
    taskSessionId: "sess-x",
    kind: "recap",
    model: M,
    inputTokens: 500,
    completedAt: NOW - 4_000,
  });
  // Unfinalized spawn (null totals) — must be excluded.
  seedSpawn(store, {
    id: "pg-1",
    taskSessionId: "sess-x",
    kind: "plan_gate",
    model: M,
    inputTokens: null,
    completedAt: NOW - 5_000,
  });

  const res = await app.fetch(new Request("http://x/api/usage/breakdown?range=7d"));
  expect(res.status).toBe(200);
  const body = await res.json();

  const kinds: Array<{ kind: string; units: number; count: number }> = body.satelliteByKind;
  const byKind = new Map(kinds.map((k) => [k.kind, k]));

  // plan_gate excluded (unfinalized); review folded to one entry, count 2.
  expect([...byKind.keys()].sort()).toEqual(["recap", "review", "rundown"]);
  expect(byKind.get("review")!.count).toBe(2);
  expect(byKind.get("rundown")!.count).toBe(1); // herd-wide bucket surfaces
  expect(byKind.get("recap")!.count).toBe(1);

  // Sorted desc by units — rundown has the most input, so it leads; recap the least.
  expect(kinds).toHaveLength(3);
  expect(kinds[0]!.kind).toBe("rundown");
  expect(kinds[kinds.length - 1]!.kind).toBe("recap");
  for (let i = 1; i < kinds.length; i++) {
    expect(kinds[i - 1]!.units).toBeGreaterThanOrEqual(kinds[i]!.units);
  }
});

// ── deps.usageRollup forwarded into buildUsageBreakdown ───────────────────────

// TestRollup overrides pathFor so the fixture lives in a temp dir keyed by claudeSessionId.
class TestRollup extends SessionUsageRollup {
  constructor(private dir: string) {
    super();
  }
  protected override pathFor(_worktreePath: string, claudeSessionId: string): string {
    return join(this.dir, `${claudeSessionId}.jsonl`);
  }
}

test("GET /api/usage/breakdown with usageRollup: active session's units appear in response", async () => {
  const rollupDir = join(
    tmpdir(),
    `srv-breakdown-rollup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(rollupDir, { recursive: true });

  try {
    const store = new SessionStore(":memory:");
    const claudeSessionId = "srv-rollup-csid";
    const worktreePath = "/wt/srv-rollup-test";

    // Create an active (non-archived) session in the store.
    const sess = store.create({
      name: "TASK-99",
      prompt: "test",
      repoPath: "/repos/srv-rollup",
      baseBranch: "main",
      branch: "shepherd/task-99",
      worktreePath,
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
    // Patch claudeSessionId directly so the rollup can locate the JSONL.
    // @ts-expect-error accessing internal db for test setup
    store.db.run(`UPDATE sessions SET claudeSessionId = ? WHERE id = ?`, [
      claudeSessionId,
      sess.id,
    ]);

    // Write a JSONL fixture with two usage records inside the 24h window.
    const tsNow = Date.now();
    const line1 = JSON.stringify({
      type: "assistant",
      timestamp: new Date(tsNow - 3_600_000).toISOString(),
      requestId: "srv-r1",
      message: {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
    await Bun.write(join(rollupDir, `${claudeSessionId}.jsonl`), line1 + "\n");

    const rollup = new TestRollup(rollupDir);
    const deps: AppDeps = {
      store,
      service: {} as any,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      usageRollup: rollup,
    };
    const app = makeApp(deps);

    const res = await app.fetch(new Request("http://x/api/usage/breakdown?range=24h"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const tasks: any[] = body.repos.flatMap((r: any) => r.tasks);
    const task = tasks.find((t: any) => t.sessionId === sess.id);

    expect(task).toBeDefined();
    // Rollup ingested the fixture: active session must carry non-zero authoring units.
    expect(task!.authoringUnits).toBeGreaterThan(0);
    expect(task!.tokens.input).toBe(200);
    expect(task!.tokens.output).toBe(80);
  } finally {
    rmSync(rollupDir, { recursive: true, force: true });
  }
});
