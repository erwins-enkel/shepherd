import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { runSessionUsageBackfill } from "../src/usage-backfill";
import { buildUsageBreakdown } from "../src/usage-breakdown";
import { jsonlPathFor } from "../src/usage";

// ── JSONL helpers (same shape as usage-snapshot.test.ts) ──────────────────

function asst(opts: {
  model?: string;
  requestId?: string;
  input?: number;
  output?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-30T09:31:01.924Z",
    requestId: opts.requestId ?? "r1",
    message: {
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 100,
        output_tokens: opts.output ?? 50,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

function writeJsonl(worktreePath: string, claudeSessionId: string, lines: string[]): void {
  const p = jsonlPathFor(worktreePath, claudeSessionId);
  mkdirSync(join(p, ".."), { recursive: true });
  Bun.write(p, lines.join("\n"));
}

// ── Test infra ──────────────────────────────────────────────────────────────

let tmpDir: string;
let origProjectsDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `usage-backfill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  origProjectsDir = config.claudeProjectsDir;
  config.claudeProjectsDir = tmpDir;
});

afterEach(() => {
  config.claudeProjectsDir = origProjectsDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a session via store.create() then archive it with a known archivedAt.
function makeArchivedSession(
  store: SessionStore,
  opts: {
    claudeSessionId: string;
    worktreePath?: string;
    archivedAt?: number;
    updatedAt?: number;
  },
): ReturnType<SessionStore["get"]> {
  const input = {
    name: "feat-x",
    prompt: "add a button",
    repoPath: tmpDir,
    baseBranch: "main",
    branch: "feat-x",
    worktreePath: opts.worktreePath ?? tmpDir,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
    model: "claude-opus-4-8",
    auto: false,
  } as const;
  const s = store.create(input);
  // Manually set claudeSessionId + archived status + archivedAt directly in DB.
  const csid = opts.claudeSessionId;
  const archivedAt = opts.archivedAt ?? Date.now();
  const updatedAt = opts.updatedAt ?? archivedAt;
  store["db"].run(
    `UPDATE sessions SET claudeSessionId=?, status='archived', archivedAt=?, updatedAt=? WHERE id=?`,
    [csid, archivedAt, updatedAt, s.id],
  );
  return store.get(s.id);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("gap-fill: archived session with transcript and no existing row → row written with correct archivedAt", async () => {
  const store = new SessionStore(":memory:");
  const ARCHIVED_AT = 1_700_000_000_000; // a known past timestamp
  const s = makeArchivedSession(store, {
    claudeSessionId: "csid-gap-1",
    archivedAt: ARCHIVED_AT,
  });

  writeJsonl(tmpDir, "csid-gap-1", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  await runSessionUsageBackfill(store);

  const rows = store.listSessionUsage();
  expect(rows).toHaveLength(1);
  const r = rows[0]!;
  expect(r.sessionId).toBe(s!.id);
  expect(r.snapshotAt).toBe(ARCHIVED_AT);
  expect(r.archivedAt).toBe(ARCHIVED_AT);
  // sanity: NOT stamped with "now" (which would be ~1.75 trillion, not 1.7 trillion)
  expect(r.snapshotAt).toBeLessThan(Date.now() - 1_000_000);
});

test("skip existing: archived session with pre-existing usage row is NOT overwritten", async () => {
  const store = new SessionStore(":memory:");
  const s = makeArchivedSession(store, {
    claudeSessionId: "csid-existing",
    archivedAt: 1_700_000_000_000,
  });

  writeJsonl(tmpDir, "csid-existing", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  // Pre-seed a sentinel usage row with a known sentinel value.
  store.upsertSessionUsage({
    sessionId: s!.id,
    desig: "TASK-SENTINEL",
    name: "sentinel-name",
    repoPath: tmpDir,
    model: "sentinel-model",
    input: 9999,
    output: 9999,
    cacheRead: 0,
    cacheWrite: 0,
    total: 9999,
    weightedUnits: 42.0,
    cacheReadUnits: 0,
    messageCount: 99,
    byModel: { "sentinel-model": 42.0 },
    rawByModel: { "sentinel-model": 9999 },
    createdAt: 1,
    archivedAt: 1,
    snapshotAt: 1,
  });

  await runSessionUsageBackfill(store);

  // Row must NOT have been overwritten — sentinel values must remain.
  const rows = store.listSessionUsage();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.model).toBe("sentinel-model");
  expect(rows[0]!.weightedUnits).toBe(42.0);
});

test("skip non-archived: live session with transcript → no row written", async () => {
  const store = new SessionStore(":memory:");
  const input = {
    name: "live-feat",
    prompt: "live feature",
    repoPath: tmpDir,
    baseBranch: "main",
    branch: "live-feat",
    worktreePath: tmpDir,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
    model: "claude-opus-4-8",
    auto: false,
  } as const;
  const s = store.create(input);
  // Set claudeSessionId but keep status = 'running'
  store["db"].run(`UPDATE sessions SET claudeSessionId=? WHERE id=?`, ["csid-live", s.id]);

  writeJsonl(tmpDir, "csid-live", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  await runSessionUsageBackfill(store);

  expect(store.listSessionUsage()).toHaveLength(0);
});

test("COALESCE fallback: archived session with NULL archivedAt → snapshotAt === updatedAt", async () => {
  const store = new SessionStore(":memory:");
  const UPDATED_AT = 1_690_000_000_000;
  const s = makeArchivedSession(store, {
    claudeSessionId: "csid-coalesce",
    archivedAt: undefined, // will be set to now in makeArchivedSession, we override below
    updatedAt: UPDATED_AT,
  });

  // Override: set archivedAt to NULL but keep updatedAt = UPDATED_AT.
  store["db"].run(`UPDATE sessions SET archivedAt=NULL, updatedAt=? WHERE id=?`, [
    UPDATED_AT,
    s!.id,
  ]);

  writeJsonl(tmpDir, "csid-coalesce", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  await runSessionUsageBackfill(store);

  const rows = store.listSessionUsage();
  expect(rows).toHaveLength(1);
  // snapshotAt should equal updatedAt (the COALESCE fallback), not now
  expect(rows[0]!.snapshotAt).toBe(UPDATED_AT);
  expect(rows[0]!.archivedAt).toBe(UPDATED_AT);
});

test("end-to-end bucketing: months-old session excluded from 24h but included in all", async () => {
  const store = new SessionStore(":memory:");
  const now = Date.now();
  const OLD_AT = now - 120 * 24 * 60 * 60 * 1000; // ~120 days ago

  makeArchivedSession(store, {
    claudeSessionId: "csid-old",
    archivedAt: OLD_AT,
  });

  writeJsonl(tmpDir, "csid-old", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  await runSessionUsageBackfill(store);

  const breakdown24h = await buildUsageBreakdown({ store, range: "24h", now, apiKey: false });
  const breakdownAll = await buildUsageBreakdown({ store, range: "all", now, apiKey: false });

  // 120-day-old session should NOT appear in 24h view
  expect(breakdown24h.repos).toHaveLength(0);

  // But should appear in "all" view
  expect(breakdownAll.repos.length).toBeGreaterThan(0);
});

test("idempotent / guarded: second run after guard is set does NOT re-create deleted row", async () => {
  const store = new SessionStore(":memory:");
  const s = makeArchivedSession(store, {
    claudeSessionId: "csid-guard",
    archivedAt: 1_700_000_000_000,
  });

  writeJsonl(tmpDir, "csid-guard", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  // First run — should snapshot and set guard.
  await runSessionUsageBackfill(store);
  expect(store.listSessionUsage()).toHaveLength(1);
  expect(store.getSetting("backfill:session_usage_v1")).toBe("done");

  // Delete the row to verify guard short-circuits a second run.
  store["db"].run(`DELETE FROM session_usage WHERE sessionId = ?`, [s!.id]);
  expect(store.listSessionUsage()).toHaveLength(0);

  // Second run — guard is "done", should NOT re-create the row.
  await runSessionUsageBackfill(store);
  expect(store.listSessionUsage()).toHaveLength(0);
});

test("errored session is one-shot: guard is set even when a snapshot fails (no permanent retry loop)", async () => {
  const store = new SessionStore(":memory:");
  makeArchivedSession(store, {
    claudeSessionId: "csid-err",
    archivedAt: 1_700_000_000_000,
  });
  writeJsonl(tmpDir, "csid-err", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);

  // Force snapshotSessionUsage into its catch (→ "error") by making the upsert throw — this
  // models a deterministic failure (e.g. an unparseable transcript) that would recur every boot.
  store.upsertSessionUsage = (() => {
    throw new Error("boom");
  }) as typeof store.upsertSessionUsage;

  await runSessionUsageBackfill(store);

  // Guard is set despite errored > 0: a deterministic failure must not trap the migration in a
  // permanent every-boot re-scan. No row was written (the upsert threw).
  expect(store.getSetting("backfill:session_usage_v1")).toBe("done");
  expect(store.listSessionUsage()).toHaveLength(0);
});
