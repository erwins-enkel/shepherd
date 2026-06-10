import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import {
  attributeSatellites,
  type ResolvedSession,
  type ReviewRow,
  type PlanGateRow,
  type ReviewSpawnRow,
  type SessionRow,
} from "../scripts/usage-report";

/** One assistant usage line so cost-units are non-zero for the review dir. */
function usageLine(): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-10T09:00:00.000Z",
    requestId: "req-1",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

function makeSession(id: string): ResolvedSession {
  const row: SessionRow = {
    id,
    desig: "TASK-001",
    name: "test",
    prompt: "do the thing",
    baseBranch: "main",
    branch: null,
    worktreePath: "/tmp/wt",
    repoPath: "/tmp/repo",
    model: null,
    claudeSessionId: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    archivedAt: null,
    status: null,
  };
  return {
    row,
    authoring: { usage: { ...emptyUsage() }, costUnits: 0 },
    ancillary: [],
    end: 2_000,
    durationMs: 1_000,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    messageCount: 0,
    byModel: {},
    lastActivity: null as number | null,
  };
}

let prevProjectsDir: string;
let tempBase: string | null = null;

afterEach(() => {
  config.claudeProjectsDir = prevProjectsDir;
  if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  tempBase = null;
});

test("attributeSatellites links a reviewer dir to its task by the stored spawn record (tag: spawn)", async () => {
  prevProjectsDir = config.claudeProjectsDir;
  tempBase = mkdtempSync(join(tmpdir(), "usage-report-spawn-"));
  config.claudeProjectsDir = tempBase;

  const reviewerSessionId = "11111111-2222-3333-4444-555555555555";
  const sessionId = "task-session-abc";

  // A `*-review-*` project dir whose transcript .jsonl basename is the reviewerSessionId.
  const dirName = "-tmp-repo-review-deadbeef";
  const dirPath = join(tempBase, dirName);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, `${reviewerSessionId}.jsonl`), usageLine() + "\n");

  const sessions = [makeSession(sessionId)];
  const reviews: ReviewRow[] = [];
  const planGates: PlanGateRow[] = [];
  const spawns: ReviewSpawnRow[] = [{ sessionId, reviewerSessionId }];

  const result = await attributeSatellites(sessions, reviews, planGates, spawns);

  const sats = result.bySession.get(sessionId);
  expect(sats).toBeDefined();
  expect(sats!.length).toBe(1);
  expect(sats![0]!.tag).toBe("spawn");
  expect(sats![0]!.dir).toBe(dirName);
  expect(sats![0]!.costUnits).toBeGreaterThan(0);
  // exact-link consumed the dir — no residual leakage.
  expect(result.residual.length).toBe(0);
});

test("attributeSatellites ignores a spawn record whose task is out of scope", async () => {
  prevProjectsDir = config.claudeProjectsDir;
  tempBase = mkdtempSync(join(tmpdir(), "usage-report-spawn-"));
  config.claudeProjectsDir = tempBase;

  const reviewerSessionId = "99999999-8888-7777-6666-555555555555";
  const dirName = "-tmp-repo-review-cafef00d";
  const dirPath = join(tempBase, dirName);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, `${reviewerSessionId}.jsonl`), usageLine() + "\n");

  // session in scope is "in-scope"; the spawn references a different (out-of-scope) session.
  const sessions = [makeSession("in-scope")];
  const spawns: ReviewSpawnRow[] = [{ sessionId: "other-session", reviewerSessionId }];

  const result = await attributeSatellites(sessions, [], [], spawns);
  expect(result.bySession.get("in-scope")).toBeUndefined();
});
