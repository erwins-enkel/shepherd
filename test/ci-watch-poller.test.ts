// ci-watch plugin (#2540): poll → filters → streaks → rules → forward, over scripted runs and
// in-memory state.

import { test, expect, beforeEach } from "bun:test";
import { createPoller, type Candidate } from "../src/plugins/bundled/ci-watch/poller";
import { dayKey, readCursor, readStatus } from "../src/plugins/bundled/ci-watch/state";
import {
  PluginForgeError,
  type PluginRepo,
  type PluginRun,
  type PluginState,
} from "../src/plugins/types";

function memState(): PluginState {
  const m = new Map<string, string>();
  return {
    get: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : null),
    set: (k, v) => void m.set(k, JSON.stringify(v ?? null)),
    delete: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const REPO = "/r/web";
let state: PluginState;
let repos: PluginRepo[];
/** Runs the fake forge holds per repo; served above `sinceId`, ascending, capped at `limit`. */
let held: Record<string, PluginRun[]>;
let calls: Array<{ repo: string; sinceId: number }>;
let forwarded: Candidate[];
let clock: number;
let failRepo: Record<string, Error>;

function run(
  id: number,
  jobs: Array<[string, string | null]>,
  over: Partial<PluginRun> = {},
): PluginRun {
  const red = jobs.some(([, c]) => c === "failure");
  return {
    id,
    workflowName: "CI",
    workflowFile: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: red ? "failure" : "success",
    attempt: 1,
    headSha: `sha${id}`,
    createdAt: 0,
    url: `https://gh/runs/${id}`,
    jobs: jobs.map(([name, conclusion], i) => ({ id: id * 100 + i, name, conclusion })),
    ...over,
  };
}

function poller() {
  return createPoller({
    state,
    runs: {
      listDefaultBranchRuns: async (repo, o = {}) => {
        const sinceId = o.sinceId ?? 0;
        calls.push({ repo, sinceId });
        if (failRepo[repo]) throw failRepo[repo];
        const runs = (held[repo] ?? [])
          .filter((r) => r.id > sinceId)
          .sort((a, b) => a.id - b.id)
          .slice(0, o.limit ?? 20);
        return { runs, cursor: runs.at(-1)?.id ?? sinceId };
      },
    },
    repos: () => repos,
    sync: async () => ({}),
    forward: async (c) => {
      forwarded.push(c);
      return "candidate";
    },
    now: () => new Date(clock),
    log: { log: () => {}, warn: () => {} },
  });
}

/** Enable the plugin and `repo`; baselined unless told otherwise. */
function enable(repoCfg: Record<string, unknown> = {}, baselined = true) {
  state.set("settings", { enabled: true, pollMinutes: 5 });
  state.set("repos", { [REPO]: { enabled: true, ...repoCfg } });
  if (baselined) state.set(`cursor:${REPO}`, { sinceId: 0, baselined: true });
}

beforeEach(() => {
  state = memState();
  repos = [
    { path: REPO, name: "web", autoLabel: "shepherd:auto", lightweight: false },
    { path: "/r/local", name: "local", autoLabel: "shepherd:auto", lightweight: true },
  ];
  held = {};
  calls = [];
  forwarded = [];
  clock = Date.parse("2026-09-28T12:00:00Z");
  failRepo = {};
});

test("disabled by default: no forge calls", async () => {
  held[REPO] = [run(1, [["test", "failure"]])];
  const p = poller();
  expect(await p.poll()).toBe("disabled");
  await p.tick();
  expect(calls).toEqual([]);
});

test("plugin enabled but repo not opted in: no forge calls", async () => {
  state.set("settings", { enabled: true });
  held[REPO] = [run(1, [["test", "failure"]])];
  expect(await poller().poll()).toBe("ok");
  expect(calls).toEqual([]);
});

test("lightweight repo is never queried even when opted in", async () => {
  enable();
  state.set("repos", { [REPO]: { enabled: true }, "/r/local": { enabled: true } });
  await poller().poll();
  expect(calls.map((c) => c.repo)).toEqual([REPO]);
});

test("a failure forwards a candidate; the cursor advances to the returned cursor", async () => {
  enable();
  held[REPO] = [
    run(7, [
      ["test (ubuntu, 20)", "failure"],
      ["lint", "success"],
    ]),
  ];
  const p = poller();
  await p.poll();
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toMatchObject({
    repo: REPO,
    job: "test",
    workflowName: "CI",
    runId: 7,
    streak: 1,
    event: "push",
  });
  expect(readCursor(state, REPO).sinceId).toBe(7);
  await p.poll();
  expect(calls.at(-1)!.sinceId).toBe(7);
  expect(forwarded).toHaveLength(1);
});

test("filters: non-default events, cancelled and startup_failure are dropped", async () => {
  enable();
  held[REPO] = [
    run(1, [["test", "failure"]], { event: "pull_request" }),
    run(2, [["test", "failure"]], { conclusion: "cancelled" }),
    run(3, [["test", "failure"]], { conclusion: "startup_failure" }),
    run(4, [["test", "failure"]], { event: "schedule" }),
  ];
  await poller().poll();
  expect(forwarded.map((c) => c.runId)).toEqual([4]);
  expect(readStatus(state).lastResult).toEqual({
    event: 1,
    cancelled: 1,
    startup_failure: 1,
    candidate: 1,
  });
});

test("fixed since: a later green run of the same key drops it", async () => {
  enable();
  held[REPO] = [run(1, [["test", "failure"]]), run(2, [["test", "success"]])];
  await poller().poll();
  expect(forwarded).toEqual([]);
  expect(readStatus(state).lastResult).toEqual({ fixed: 1 });
});

test("jobless failure: a later green run fixes it", async () => {
  enable();
  held[REPO] = [run(1, [], { conclusion: "failure" }), run(2, [["test", "success"]])];
  await poller().poll();
  expect(forwarded).toEqual([]);
  expect(readStatus(state).lastResult).toEqual({ fixed: 1 });
});

test("jobless failure: a green run in between resets the threshold streak", async () => {
  enable({ threshold: 2 });
  const p = poller();
  held[REPO] = [run(1, [], { conclusion: "failure" }), run(2, [["test", "success"]])];
  await p.poll();
  held[REPO].push(run(3, [], { conclusion: "failure" }));
  await p.poll();
  expect(forwarded).toEqual([]);
  expect(readStatus(state).lastResult).toEqual({ threshold: 1 });

  held[REPO].push(run(4, [], { conclusion: "failure" }));
  await p.poll();
  expect(forwarded.map((c) => [c.job, c.runId, c.streak])).toEqual([["(run)", 4, 2]]);
});

test("threshold with glob override: Eval* needs 2 consecutive failures; green resets", async () => {
  enable({ overrides: [{ glob: "Eval*", threshold: 2 }] });
  const ev = { workflowName: "Eval — stop-classifier", workflowFile: "eval.yml" };
  const p = poller();
  held[REPO] = [run(1, [["eval", "failure"]], ev)];
  await p.poll();
  expect(forwarded).toEqual([]);
  expect(readStatus(state).lastResult).toEqual({ threshold: 1 });

  held[REPO].push(run(2, [["eval", "success"]], ev), run(3, [["eval", "failure"]], ev));
  await p.poll();
  expect(forwarded).toEqual([]);

  held[REPO].push(run(4, [["eval", "failure"]], ev));
  await p.poll();
  expect(forwarded.map((c) => [c.runId, c.streak])).toEqual([[4, 2]]);
});

test("other workflows keep the repo default threshold of 1", async () => {
  enable({ overrides: [{ glob: "Eval*", threshold: 2 }] });
  held[REPO] = [run(1, [["test", "failure"]])];
  await poller().poll();
  expect(forwarded).toHaveLength(1);
});

test("dedup: an open filed issue blocks; a closed one re-forwards", async () => {
  enable();
  const key = `map:${REPO}::.github/workflows/ci.yml::test`;
  const filed = { number: 9, url: "u", filedAt: "t", runId: 1, attempts: 1, sync: "open" };
  state.set(key, {
    repo: REPO,
    workflowName: "CI",
    workflowFile: ".github/workflows/ci.yml",
    job: "test",
    streak: 1,
    lastRunId: 0,
    lastConclusion: "failure",
    filed,
  });
  held[REPO] = [run(1, [["test", "failure"]])];
  const p = poller();
  await p.poll();
  expect(forwarded).toEqual([]);
  expect(readStatus(state).lastResult).toEqual({ filed: 1 });

  state.set(key, { ...state.get<object>(key), filed: { ...filed, sync: "closed" } });
  held[REPO].push(run(2, [["test", "failure"]]));
  await p.poll();
  expect(forwarded.map((c) => c.runId)).toEqual([2]);
});

test("daily cap: a repo at its cap forwards nothing; a new UTC day resets it", async () => {
  enable();
  state.set("meta:daily", { day: dayKey(new Date(clock)), counts: { [REPO]: 3 } });
  held[REPO] = [run(1, [["test", "failure"]])];
  const p = poller();
  await p.poll();
  expect(readStatus(state).lastResult).toEqual({ cap: 1 });

  clock += 24 * 3600_000;
  held[REPO].push(run(2, [["test", "failure"]]));
  await p.poll();
  expect(forwarded.map((c) => c.runId)).toEqual([2]);
});

test("baseline: first ingest forwards nothing, later failures do", async () => {
  enable({}, false);
  held[REPO] = Array.from({ length: 55 }, (_, i) => run(i + 1, [["test", "failure"]]));
  const p = poller();
  await p.poll();
  expect(readCursor(state, REPO)).toEqual({ sinceId: 50, baselined: false });
  await p.poll();
  expect(readCursor(state, REPO)).toEqual({ sinceId: 55, baselined: true });
  expect(forwarded).toEqual([]);

  held[REPO].push(run(56, [["test", "failure"]]));
  await p.poll();
  expect(forwarded.map((c) => [c.runId, c.streak])).toEqual([[56, 56]]);
});

test("forge refusal is counted per repo and leaves the cursor; other repos continue", async () => {
  const other = "/r/api";
  repos.push({ path: other, name: "api", autoLabel: "shepherd:auto", lightweight: false });
  enable();
  state.set("repos", { [REPO]: { enabled: true }, [other]: { enabled: true } });
  state.set(`cursor:${other}`, { sinceId: 0, baselined: true });
  failRepo[REPO] = new PluginForgeError("unsupported", "no");
  held[other] = [run(1, [["test", "failure"]])];
  await poller().poll();
  expect(readCursor(state, REPO).sinceId).toBe(0);
  expect(forwarded.map((c) => c.repo)).toEqual([other]);
  expect(readStatus(state)).toMatchObject({ lastError: null, lastResult: { unsupported: 1 } });

  failRepo[REPO] = new Error("boom");
  held[other] = [];
  await poller().poll();
  expect(readStatus(state).lastError).toBe("boom");
});

test("forward errors are counted and the cursor still advances", async () => {
  enable();
  held[REPO] = [run(1, [["test", "failure"]])];
  const p = createPoller({
    state,
    runs: {
      listDefaultBranchRuns: async () => ({ runs: held[REPO]!, cursor: 1 }),
    },
    repos: () => repos,
    forward: async () => {
      throw new Error("nope");
    },
    sync: async () => ({}),
    now: () => new Date(clock),
    log: { log: () => {}, warn: () => {} },
  });
  await p.poll();
  expect(readStatus(state).lastResult).toEqual({ "forward-error": 1 });
  expect(readCursor(state, REPO).sinceId).toBe(1);
});

test("tick honours pollMinutes", async () => {
  enable();
  const p = poller();
  await p.tick();
  expect(calls).toHaveLength(1);
  clock += 4 * 60_000;
  await p.tick();
  expect(calls).toHaveLength(1);
  clock += 60_000;
  await p.tick();
  expect(calls).toHaveLength(2);
});

test("keys keep recent conclusions; a green observation clears the streak's classification", async () => {
  enable();
  const key = `map:${REPO}::.github/workflows/ci.yml::test`;
  held[REPO] = [run(1, [["test", "failure"]])];
  const p = poller();
  await p.poll();
  expect(forwarded[0]?.attempt).toBe(1);
  state.set(key, { ...state.get<object>(key), classified: { runId: 1, outcome: "rejected" } });

  held[REPO].push(run(2, [["test", "failure"]]));
  await p.poll();
  expect(forwarded.map((c) => c.runId)).toEqual([1]);
  expect(readStatus(state).lastResult).toEqual({ classified: 1 });

  held[REPO].push(run(3, [["test", "success"]]), run(4, [["test", "failure"]]));
  await p.poll();
  expect(forwarded.map((c) => c.runId)).toEqual([1, 4]);
  const rec = state.get<{ recent: string[]; classified?: unknown }>(key);
  expect(rec?.recent).toEqual(["failure", "failure", "success", "failure"]);
  expect(rec?.classified).toBeUndefined();
});
