import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeavySlotService } from "../src/heavy-slot";
import { parseHeavySlotSnapshot, readLastResults } from "../src/heavy-slot-snapshot";
import { SessionStore } from "../src/store";
import type { Session } from "../src/types";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slot-res-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real service on a real store; the session is the temp repo itself (no linked worktree). */
function setup() {
  const store = new SessionStore(":memory:");
  const session = { id: "s1", status: "running", repoPath: dir, worktreePath: dir } as Session;
  const lookup = {
    get: (id: string) => (id === "s1" ? session : null),
    lastHeavySlotResults: () => store.lastHeavySlotResults(),
  };
  const svc = new HeavySlotService({
    store: {
      get: lookup.get,
      listHeavySlotJobs: (s) => store.listHeavySlotJobs(s),
      upsertHeavySlotJob: (j) => store.upsertHeavySlotJob(j),
      heavySlotDurations: (k) => store.heavySlotDurations(k),
      pruneHeavySlotJobs: (b) => store.pruneHeavySlotJobs(b),
    } as ConstructorParameters<typeof HeavySlotService>[0]["store"],
    events: { emit: () => {} },
    steer: async () => true,
    enabled: true,
    budget: { slots: 1, minAvailableBytes: 0, psiFullMax: 100, releaseHoldMs: 0 },
    scanMarkers: async () => new Map(),
    sampleMemory: async () => ({ availableBytes: 1e12, psiFullAvg10: 0 }),
    platform: "linux",
  });
  return { svc, lookup };
}

async function runJob(exitCode: number) {
  const ctx = setup();
  const res = await ctx.svc.acquire("s1", "vitest run", null);
  if (res?.decision !== "run" || !("jobId" in res)) throw new Error("expected a run decision");
  await ctx.svc.finish("s1", res.jobId!, exitCode);
  return ctx.lookup;
}

test("a passing result is current until the worktree moves on, then stale", async () => {
  const lookup = await runJob(0);
  const [fresh] = await readLastResults(lookup, 10_000);
  expect(fresh).toMatchObject({ sessionId: "s1", result: "passed", exitCode: 0, stale: false });
  expect(fresh!.head).toMatch(/^[0-9a-f]{40}$/);
  writeFileSync(join(dir, "a.txt"), "changed\n");
  const [stale] = await readLastResults(lookup, 20_000);
  expect(stale).toMatchObject({ result: "passed", stale: true });
});

test("a failed result keeps its result and also turns stale", async () => {
  const lookup = await runJob(1);
  git("commit", "--allow-empty", "-qm", "next");
  const [r] = await readLastResults(lookup, 30_000);
  expect(r).toMatchObject({ result: "failed", exitCode: 1, stale: true });
});

test("a remote snapshot without lastResults parses to an empty list; bad entries are dropped", () => {
  const base = { enabled: true, capacity: 1, holders: [], waiters: [] };
  expect(parseHeavySlotSnapshot(base)?.lastResults).toEqual([]);
  const parsed = parseHeavySlotSnapshot({
    ...base,
    lastResults: [
      { sessionId: "a", command: "c", startedAt: 1, result: "passed", treeHash: "t", head: "h" },
      { sessionId: "b" },
    ],
  });
  expect(parsed?.lastResults).toHaveLength(1);
  // unreported staleness never reads as current
  expect(parsed?.lastResults[0]).toMatchObject({ sessionId: "a", result: "passed", stale: true });
});
