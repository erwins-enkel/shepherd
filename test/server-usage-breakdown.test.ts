import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import {
  USAGE_BREAKDOWN_KEYS,
  USAGE_REPO_KEYS,
  USAGE_TASK_KEYS,
  USAGE_TOKENS_KEYS,
} from "../src/types";
import type { SessionUsageSnapshot } from "../src/types";
import { SessionUsageRollup } from "../src/usage";

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
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

  for (const repo of body.repos) {
    exactKeys(repo, USAGE_REPO_KEYS);
    expect(repo.dollars).toBeNull();
    for (const task of repo.tasks) {
      exactKeys(task, USAGE_TASK_KEYS);
      exactKeys(task.tokens, USAGE_TOKENS_KEYS);
    }
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
    Bun.write(join(rollupDir, `${claudeSessionId}.jsonl`), line1 + "\n");

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
