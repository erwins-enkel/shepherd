// ci-watch filing (#2542): labels, body, guards and the attempt cap, over fakes.

import { test, expect, beforeEach } from "bun:test";
import type { ClassifyRecord } from "../src/plugins/bundled/ci-watch/classify";
import {
  CI_LABEL,
  createFiler,
  fenceLabel,
  issueBody,
  issueLabels,
  issueTitle,
} from "../src/plugins/bundled/ci-watch/file";
import { DAILY_CAP } from "../src/plugins/bundled/ci-watch/rules";
import { dayKey, filedToday, mapKey, type KeyRecord } from "../src/plugins/bundled/ci-watch/state";
import {
  PluginIssuesError,
  type PluginIssueCreateInput,
  type PluginFailedStepLog,
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
const WF = ".github/workflows/ci.yml";
const KEY = mapKey(REPO, WF, "test");
const NOW = new Date("2026-09-28T12:00:00Z");
let state: PluginState;
let created: Array<{ repo: string; o: PluginIssueCreateInput }>;
let createError: Error | null;
let logs: PluginFailedStepLog[] | Error;

function record(over: Partial<ClassifyRecord> = {}): ClassifyRecord {
  return {
    id: `${KEY}:7`,
    key: KEY,
    repo: REPO,
    runId: 7,
    runUrl: "https://gh/runs/7",
    headSha: "abc123",
    workflowName: "CI",
    workflowFile: WF,
    job: "test",
    outcome: "accepted",
    jev: { choice: "regression", p: 0.82, probabilities: { regression: 0.82 } },
    verdict: {
      fixable: true,
      confidence: "high",
      hypothesis: "the parser drops trailing commas",
      files: ["src/parse.ts"],
      reason: "found it",
    },
    reason: "found it",
    overridden: false,
    updatedAt: "",
    ...over,
  };
}

function seedKey(over: Partial<KeyRecord> = {}): void {
  state.set(KEY, {
    repo: REPO,
    workflowName: "CI",
    workflowFile: WF,
    job: "test",
    streak: 1,
    lastRunId: 7,
    lastConclusion: "failure",
    ...over,
  } satisfies KeyRecord);
}

function filer(autoDrain = true) {
  state.set("repos", { [REPO]: { enabled: true, autoDrain } });
  return createFiler({
    state,
    issues: {
      create: async (repo, o) => {
        if (createError) throw createError;
        created.push({ repo, o });
        return { number: 40 + created.length, url: `https://gh/issues/${40 + created.length}` };
      },
    },
    runs: {
      failedJobLogs: async () => {
        if (logs instanceof Error) throw logs;
        return logs;
      },
    },
    repos: () => [{ path: REPO, name: "web", autoLabel: "shepherd", lightweight: false }],
    now: () => NOW,
    log: { log: () => {}, warn: () => {} },
  });
}

const keyRec = () => state.get<KeyRecord>(KEY)!;

beforeEach(() => {
  state = memState();
  created = [];
  createError = null;
  logs = [{ job: "test (ubuntu, 20)", step: "run tests ⟦x⟧", lines: ["FAIL x"], truncated: false }];
  seedKey();
});

test.each([
  ["autoDrain on", true, "shepherd", 0, [CI_LABEL, "shepherd"]],
  ["autoDrain off", false, "shepherd", 0, [CI_LABEL]],
  ["no autoLabel", true, "", 0, [CI_LABEL]],
  ["second attempt still drains", true, "shepherd", 1, [CI_LABEL, "shepherd"]],
  ["attempts used up", true, "shepherd", 2, [CI_LABEL]],
] as const)("issueLabels: %s", (_n, autoDrain, autoLabel, prev, want) => {
  expect(issueLabels({ autoDrain }, autoLabel, prev)).toEqual([...want]);
});

test("title is trusted repo names, one line, ≤ 200 chars", () => {
  expect(issueTitle({ workflowName: "CI", job: "test" })).toBe("CI failure: CI / test");
  const long = issueTitle({ workflowName: "W\n".repeat(300), job: "j" });
  expect(long.length).toBe(200);
  expect(long).not.toContain("\n");
});

test("body carries run, workflow/job, JEV class + p; never the hypothesis", () => {
  const body = issueBody(record(), true, null);
  expect(body).toContain("https://gh/runs/7");
  expect(body).toContain("`CI` (`.github/workflows/ci.yml`)");
  expect(body).toContain("Job: `test`");
  expect(body).toContain("regression (p=0.82)");
  expect(body).not.toContain("trailing commas");
  expect(body).not.toContain("log: unavailable");
  expect(issueBody(record({ jev: { error: "unavailable" } }), false, null)).toContain(
    "unavailable (unavailable)",
  );
  expect(issueBody(record({ jev: null }), false, null)).toContain("log: unavailable");
});

test("body flags an override and a prior filing", () => {
  const body = issueBody(record({ overridden: true }), true, {
    url: "https://gh/issues/3",
    humanOnly: true,
  });
  expect(body).toContain("operator override");
  expect(body).toContain("https://gh/issues/3");
  expect(body).toContain("needs a human");
});

test("fenceLabel satisfies core's label rule", () => {
  const l = fenceLabel("test (ubuntu, 20) / run ⟦x⟧ tests".repeat(4));
  expect(l).toMatch(/^[\w .#:-]{1,64}$/);
});

test("files with labels, fenced log + triage sections; records the filing and bumps the cap", async () => {
  const f = await filer()(record(), { override: false });
  expect(f).toEqual({ status: "filed", number: 41, url: "https://gh/issues/41" });
  const { o } = created[0]!;
  expect(o.labels).toEqual([CI_LABEL, "shepherd"]);
  expect(o.untrusted?.map((u) => u.label)).toEqual([
    "test -ubuntu- 20- - run tests -x-",
    "triage hypothesis",
    "triage files",
  ]);
  for (const u of o.untrusted ?? []) expect(u.label).toMatch(/^[\w .#:-]{1,64}$/);
  expect(o.untrusted?.[0]?.content).toBe("FAIL x");
  expect(keyRec().filed).toMatchObject({ number: 41, runId: 7, attempts: 1, sync: "open" });
  expect(filedToday(state, REPO, dayKey(NOW))).toBe(1);
});

test("log fetch failure still files, noting the missing log", async () => {
  logs = new Error("gone");
  expect(await filer()(record(), { override: false })).toMatchObject({ status: "filed" });
  expect(created[0]!.o.body).toContain("log: unavailable");
});

test("an open filing makes it a duplicate; a later green run makes it fixed", async () => {
  seedKey({ filed: { number: 3, url: "u3", filedAt: "t", runId: 5, attempts: 1, sync: "open" } });
  expect(await filer()(record(), { override: true })).toEqual({
    status: "duplicate",
    number: 3,
    url: "u3",
  });
  seedKey({ lastRunId: 8, lastConclusion: "success" });
  expect(await filer()(record(), { override: true })).toEqual({ status: "fixed" });
  expect(created).toEqual([]);
});

test("the daily cap defers (null) unless overridden; a create error defers", async () => {
  state.set("meta:daily", { day: dayKey(NOW), counts: { [REPO]: DAILY_CAP } });
  const file = filer();
  expect(await file(record(), { override: false })).toBeNull();
  expect(await file(record(), { override: true })).toMatchObject({ status: "filed" });

  seedKey();
  createError = new Error("503");
  expect(await file(record(), { override: true })).toBeNull();
  expect(keyRec().filed).toBeUndefined();
});

test("re-filing after close: attempts grow, the drain label drops after MAX_AUTO_ATTEMPTS", async () => {
  const file = filer();
  const close = () => {
    const k = keyRec();
    state.set(KEY, { ...k, filed: { ...k.filed!, sync: "closed" } });
  };
  await file(record(), { override: false });
  close();
  await file(record({ runId: 9 }), { override: false });
  close();
  await file(record({ runId: 11 }), { override: false });
  expect(created.map((c) => c.o.labels)).toEqual([
    [CI_LABEL, "shepherd"],
    [CI_LABEL, "shepherd"],
    [CI_LABEL],
  ]);
  expect(created[1]!.o.body).toContain("https://gh/issues/41");
  expect(created[1]!.o.body).not.toContain("needs a human");
  expect(created[2]!.o.body).toContain("needs a human");
  expect(keyRec().filed).toMatchObject({ number: 43, attempts: 3, runId: 11 });
});

test("a second filing for a key already being filed waits (null)", async () => {
  const file = filer();
  const [a, b] = await Promise.all([
    file(record(), { override: false }),
    file(record({ runId: 9 }), { override: false }),
  ]);
  expect(a).toMatchObject({ status: "filed" });
  expect(b).toBeNull();
  expect(created).toHaveLength(1);
});

test("untrusted sections stay within core's 20: the latest logs + the triage sections", async () => {
  logs = Array.from({ length: 25 }, (_, i) => ({
    job: `test (leg ${i})`,
    step: "run",
    lines: [`FAIL ${i}`],
    truncated: false,
  }));
  expect(await filer()(record(), { override: false })).toMatchObject({ status: "filed" });
  const u = created[0]!.o.untrusted!;
  expect(u).toHaveLength(20);
  expect(u.at(-3)!.content).toBe("FAIL 24");
  expect(u.slice(-2).map((x) => x.label)).toEqual(["triage hypothesis", "triage files"]);
});

test("a ctx.issues refusal is permanent (refused), not retried", async () => {
  createError = new PluginIssuesError("invalid-input", "too many sections");
  expect(await filer()(record(), { override: false })).toEqual({
    status: "refused",
    code: "invalid-input",
  });
  expect(keyRec().filed).toBeUndefined();
});
