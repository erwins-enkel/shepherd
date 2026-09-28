// ci-watch end to end over fakes (#2542): poll → classify → file → sync. Auto-close on green
// before claim, never after, re-file on a new red streak, drain label dropped after 2 attempts.

import { test, expect, beforeEach } from "bun:test";
import { createClassifier } from "../src/plugins/bundled/ci-watch/classify";
import { CI_LABEL, createFiler } from "../src/plugins/bundled/ci-watch/file";
import { createPoller } from "../src/plugins/bundled/ci-watch/poller";
import { readStatus } from "../src/plugins/bundled/ci-watch/state";
import { syncFiled } from "../src/plugins/bundled/ci-watch/sync";
import type {
  PluginIssue,
  PluginIssueCreateInput,
  PluginRepo,
  PluginRun,
  PluginSessionSnapshot,
  PluginState,
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
const repos: PluginRepo[] = [
  { path: REPO, name: "web", autoLabel: "shepherd", lightweight: false },
];
let state: PluginState;
let runs: PluginRun[];
let created: PluginIssueCreateInput[];
let issues: Map<number, PluginIssue>;
let closed: number[];
let sessions: PluginSessionSnapshot[];
let clock: number;

/** An `Eval*` workflow — the flake probe is skipped, so a red run classifies straight away. */
function run(id: number, conclusion: "failure" | "success"): PluginRun {
  return {
    id,
    workflowName: "Eval nightly",
    workflowFile: ".github/workflows/eval.yml",
    event: "schedule",
    status: "completed",
    conclusion,
    attempt: 1,
    headSha: `sha${id}`,
    createdAt: 0,
    url: `https://gh/runs/${id}`,
    jobs: [{ id, name: "eval", conclusion }],
  };
}

function plugin() {
  const log = { log: () => {}, warn: () => {} };
  const now = () => new Date(clock);
  const forgeIssues = {
    create: async (_repo: string, o: PluginIssueCreateInput) => {
      created.push(o);
      const number = 40 + created.length;
      const url = `https://gh/issues/${number}`;
      issues.set(number, {
        number,
        title: o.title,
        body: o.body,
        url,
        labels: o.labels ?? [],
        state: "open",
      });
      return { number, url };
    },
    get: async (_repo: string, n: number) => issues.get(n) ?? null,
    close: async (_repo: string, n: number) => {
      closed.push(n);
      issues.set(n, { ...issues.get(n)!, state: "closed" });
    },
  };
  const forgeRuns = {
    listDefaultBranchRuns: async (_repo: string, o: { sinceId?: number } = {}) => {
      const out = runs.filter((r) => r.id > (o.sinceId ?? 0));
      return { runs: out, cursor: out.at(-1)?.id ?? o.sinceId ?? 0 };
    },
    getRun: async () => null,
    rerunFailed: async () => {},
    failedJobLogs: async () => [
      { job: "eval", step: "score", lines: ["below 0.8"], truncated: false },
    ],
  };
  const stage = createClassifier({
    state,
    runs: forgeRuns,
    judge: null,
    agents: {
      runReadonly: async () => ({
        fixable: true,
        confidence: "high",
        hypothesis: "h",
        files: ["a.ts"],
        reason: "r",
      }),
    },
    file: createFiler({
      state,
      issues: forgeIssues,
      runs: forgeRuns,
      repos: () => repos,
      now,
      log,
    }),
    now,
    log,
  });
  return createPoller({
    state,
    runs: forgeRuns,
    repos: () => repos,
    forward: (c) => stage.process(c),
    sync: () =>
      syncFiled({ state, issues: forgeIssues, sessions: { list: () => sessions }, now, log }),
    now,
    log,
  });
}

async function poll(r: PluginRun) {
  runs.push(r);
  clock += 60_000;
  await plugin().poll();
  return readStatus(state).lastResult;
}

beforeEach(() => {
  state = memState();
  runs = [];
  created = [];
  issues = new Map();
  closed = [];
  sessions = [];
  clock = Date.parse("2026-09-28T12:00:00Z");
  state.set("settings", { enabled: true });
  state.set("repos", { [REPO]: { enabled: true, autoDrain: true } });
  state.set(`cursor:${REPO}`, { sinceId: 0, baselined: true });
});

test("green before claim closes; red re-files; the third filing drops the drain label", async () => {
  expect(await poll(run(1, "failure"))).toMatchObject({ "issue-filed": 1, "sync-open": 1 });
  expect(created[0]!.labels).toEqual([CI_LABEL, "shepherd"]);
  expect(created[0]!.body).toContain("https://gh/runs/1");

  expect(await poll(run(2, "success"))).toMatchObject({ "sync-closed-green": 1 });
  expect(closed).toEqual([41]);

  expect(await poll(run(3, "failure"))).toMatchObject({ "issue-filed": 1 });
  expect(created[1]!.labels).toEqual([CI_LABEL, "shepherd"]);
  expect(created[1]!.body).toContain("https://gh/issues/41");

  // Closed by someone else while red: no re-file until a green + red.
  issues.set(42, { ...issues.get(42)!, state: "closed" });
  expect(await poll(run(4, "failure"))).toMatchObject({ filed: 1, "sync-gh-closed": 1 });
  expect(created).toHaveLength(2);
  await poll(run(5, "success"));
  expect(await poll(run(6, "failure"))).toMatchObject({ "issue-filed": 1 });
  expect(created[2]!.labels).toEqual([CI_LABEL]);
  expect(created[2]!.body).toContain("needs a human");
});

test("a claimed issue is never closed, and no duplicate is filed while it is open", async () => {
  await poll(run(1, "failure"));
  sessions = [{ repoPath: REPO, issueNumber: 41, createdAt: 1 } as PluginSessionSnapshot];
  expect(await poll(run(2, "success"))).toMatchObject({ "sync-claimed": 1 });
  expect(await poll(run(3, "failure"))).toMatchObject({ filed: 1, "sync-claimed": 1 });
  expect(closed).toEqual([]);
  expect(created).toHaveLength(1);
});
