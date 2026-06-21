import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { snapshotSessionUsage } from "../src/usage-snapshot";
import { jsonlPathFor } from "../src/usage";
import type { Session } from "../src/types";

// Build a minimal assistant JSONL line matching the shape parseLine expects.
function asst(opts: {
  model?: string;
  requestId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  w5m?: number;
  w1h?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-30T09:31:01.924Z",
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

function makeSession(over: {
  id?: string;
  desig?: string;
  name?: string;
  prompt?: string;
  repoPath?: string;
  model?: string;
  claudeSessionId?: string;
  worktreePath?: string;
  createdAt?: number;
}): Session {
  return {
    id: over.id ?? "sess-1",
    desig: over.desig ?? "TASK-01",
    name: over.name ?? "feat-x",
    prompt: over.prompt ?? "add a button",
    repoPath: over.repoPath ?? "/repos/foo",
    model: over.model ?? "claude-opus-4-8",
    claudeSessionId: over.claudeSessionId ?? "abc-123",
    worktreePath: over.worktreePath ?? "/repos/foo",
    createdAt: over.createdAt ?? 1_000_000,
  } as unknown as Session;
}

let tmpDir: string;
let origProjectsDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `usage-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  origProjectsDir = config.claudeProjectsDir;
  config.claudeProjectsDir = tmpDir;
});

afterEach(() => {
  config.claudeProjectsDir = origProjectsDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(worktreePath: string, claudeSessionId: string, lines: string[]): void {
  const p = jsonlPathFor(worktreePath, claudeSessionId);
  mkdirSync(join(p, ".."), { recursive: true });
  Bun.write(p, lines.join("\n"));
}

test("normal session → one row with correct fields", async () => {
  const session = makeSession({
    id: "sess-1",
    desig: "TASK-01",
    repoPath: "/repos/foo",
    worktreePath: "/repos/foo",
    claudeSessionId: "abc-123",
    createdAt: 1_000_000,
    model: "claude-opus-4-8",
  });
  writeJsonl("/repos/foo", "abc-123", [
    asst({
      requestId: "r1",
      model: "claude-opus-4-8",
      input: 100,
      output: 50,
      cacheRead: 10,
      w5m: 5,
    }),
    asst({ requestId: "r2", model: "claude-opus-4-8", input: 200, output: 80 }),
  ]);

  const store = new SessionStore(":memory:");
  const before = Date.now();
  await snapshotSessionUsage(session, store);
  const after = Date.now();

  const rows = store.listSessionUsage();
  expect(rows).toHaveLength(1);
  const r = rows[0]!;
  expect(r.sessionId).toBe("sess-1");
  expect(r.desig).toBe("TASK-01");
  expect(r.repoPath).toBe("/repos/foo");
  expect(r.model).toBe("claude-opus-4-8");
  expect(r.messageCount).toBe(2);
  expect(r.input).toBe(300);
  expect(r.output).toBe(130);
  expect(r.cacheRead).toBe(10);
  expect(r.cacheWrite).toBe(5);
  expect(r.weightedUnits).toBeGreaterThan(0);
  expect(r.cacheReadUnits).toBeGreaterThan(0);
  expect(typeof r.byModel).toBe("object");
  expect(r.byModel["claude-opus-4-8"]).toBeGreaterThan(0);
  expect(r.createdAt).toBe(1_000_000);
  expect(r.archivedAt).toBe(r.snapshotAt);
  expect(r.archivedAt).toBeGreaterThanOrEqual(before);
  expect(r.archivedAt).toBeLessThanOrEqual(after);
});

test("merge-train session → no row (archetype skip)", async () => {
  const session = makeSession({ name: "merge-train", prompt: "merge" });
  writeJsonl("/repos/foo", "abc-123", [asst({ requestId: "r1", input: 100, output: 50 })]);
  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);
  expect(store.listSessionUsage()).toHaveLength(0);
});

test("/impeccable prompt session → no row (archetype skip)", async () => {
  const session = makeSession({ name: "feat-x", prompt: "/impeccable audit" });
  writeJsonl("/repos/foo", "abc-123", [asst({ requestId: "r1", input: 100, output: 50 })]);
  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);
  expect(store.listSessionUsage()).toHaveLength(0);
});

test("absent JSONL → resolves without throwing and writes no row", async () => {
  const session = makeSession({ claudeSessionId: "no-file-here" });
  const store = new SessionStore(":memory:");
  await expect(snapshotSessionUsage(session, store)).resolves.toBe("skipped");
  expect(store.listSessionUsage()).toHaveLength(0);
});

test("empty claudeSessionId → no row", async () => {
  const session = makeSession({ claudeSessionId: "" });
  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);
  expect(store.listSessionUsage()).toHaveLength(0);
});

test("empty transcript (0 assistant records) → no row", async () => {
  const session = makeSession({ claudeSessionId: "empty-transcript" });
  writeJsonl("/repos/foo", "empty-transcript", [
    JSON.stringify({ type: "user", message: { content: "hello" } }),
  ]);
  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);
  expect(store.listSessionUsage()).toHaveLength(0);
});

test("asOf override → row stamped with historical timestamp", async () => {
  const T = 1_700_000_000_000;
  const session = makeSession({
    id: "sess-backfill",
    desig: "TASK-99",
    repoPath: "/repos/foo",
    worktreePath: "/repos/foo",
    claudeSessionId: "backfill-123",
    createdAt: 1_000_000,
    model: "claude-opus-4-8",
  });
  writeJsonl("/repos/foo", "backfill-123", [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  ]);
  const store = new SessionStore(":memory:");
  const result = await snapshotSessionUsage(session, store, { asOf: T });
  expect(result).toBe("snapshotted");
  const rows = store.listSessionUsage();
  expect(rows).toHaveLength(1);
  const r = rows[0]!;
  expect(r.archivedAt).toBe(T);
  expect(r.snapshotAt).toBe(T);
});

// ── New bucket tests (Task 3) ────────────────────────────────────────────────

/** Build an assistant JSONL line with an explicit ISO timestamp. */
function asstAt(ts: string, opts: Parameters<typeof asst>[0]): string {
  const line = JSON.parse(asst(opts)) as Record<string, unknown>;
  line.timestamp = ts;
  return JSON.stringify(line);
}

test("buckets persisted: ≥2 hours → ≥2 bucket rows, Σ buckets == aggregate", async () => {
  // Two records in different UTC hours
  const session = makeSession({ id: "sess-b1", claudeSessionId: "bkt-multi" });
  writeJsonl("/repos/foo", "bkt-multi", [
    asstAt("2026-05-30T09:00:00.000Z", { requestId: "r1", input: 100, output: 50, cacheRead: 10 }),
    asstAt("2026-05-30T10:00:00.000Z", { requestId: "r2", input: 200, output: 80, w5m: 5 }),
  ]);
  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);

  // At least 2 bucket rows
  expect(store.bucketedSessionIds().has("sess-b1")).toBe(true);
  const sums = store.sumSessionUsageBucketsSince(0);
  expect(sums.has("sess-b1")).toBe(true);

  const bucketed = sums.get("sess-b1")!;
  const rows = store.listSessionUsage();
  const r = rows.find((x) => x.sessionId === "sess-b1")!;
  expect(r).toBeDefined();

  // Σ buckets == aggregate row (float-tolerant for REAL fields)
  expect(bucketed.input).toBe(r.input);
  expect(bucketed.output).toBe(r.output);
  expect(bucketed.cacheRead).toBe(r.cacheRead);
  expect(bucketed.cacheWrite).toBe(r.cacheWrite);
  expect(bucketed.weightedUnits).toBeCloseTo(r.weightedUnits, 6);
  expect(bucketed.cacheReadUnits).toBeCloseTo(r.cacheReadUnits, 6);
});

test("ts=0 record lands in bucket 0 and is included in aggregate", async () => {
  const session = makeSession({ id: "sess-b2", claudeSessionId: "bkt-ts0" });
  // One record with unparseable timestamp (ts=0), one normal
  const line0 = JSON.stringify({
    type: "assistant",
    timestamp: "not-a-date",
    requestId: "r0",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0 },
    },
  });
  const line1 = asstAt("2026-05-30T09:00:00.000Z", { requestId: "r1", input: 100, output: 50 });
  writeJsonl("/repos/foo", "bkt-ts0", [line0, line1]);

  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);

  const rows = store.listSessionUsage();
  const r = rows.find((x) => x.sessionId === "sess-b2")!;
  expect(r).toBeDefined();
  expect(r.messageCount).toBe(2);
  // Bucket 0 must exist
  expect(store.bucketedSessionIds().has("sess-b2")).toBe(true);
  // Σ input includes both records
  expect(r.input).toBe(150);
});

test("idempotent re-archive: second call replaces buckets, no dup, no FK error", async () => {
  const session = makeSession({ id: "sess-b3", claudeSessionId: "bkt-idem" });
  writeJsonl("/repos/foo", "bkt-idem", [
    asstAt("2026-05-30T09:00:00.000Z", { requestId: "r1", input: 100, output: 50 }),
  ]);
  const store = new SessionStore(":memory:");
  await snapshotSessionUsage(session, store);
  await snapshotSessionUsage(session, store);

  // Still only one aggregate row
  expect(store.listSessionUsage().filter((r) => r.sessionId === "sess-b3")).toHaveLength(1);
  // Bucket sums unchanged (no double-counting)
  const sums = store.sumSessionUsageBucketsSince(0);
  const r = store.listSessionUsage().find((x) => x.sessionId === "sess-b3")!;
  expect(sums.get("sess-b3")!.input).toBe(r.input);
});
