// ci-watch classification (#2541): flake probe (one rerun per run) → JEV → triage, over fakes.

import { test, expect, beforeEach } from "bun:test";
import {
  createClassifier,
  jevGate,
  logSections,
  PROBE_TIMEOUT_MS,
  registerClassifyRoutes,
  verdictId,
  type ClassifyRecord,
  type TriageVerdict,
} from "../src/plugins/bundled/ci-watch/classify";
import type { Filing } from "../src/plugins/bundled/ci-watch/file";
import type { Candidate } from "../src/plugins/bundled/ci-watch/poller";
import { mapKey, type KeyRecord } from "../src/plugins/bundled/ci-watch/state";
import {
  PluginAgentError,
  PluginForgeError,
  PluginJudgeError,
  type PluginJudgeChoiceAnswer,
  type PluginJudgeChoiceOptions,
  type PluginRouteHandler,
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
const WF = ".github/workflows/ci.yml";
let state: PluginState;
let clock: number;
let reruns: number[];
let getRuns: number[];
let rerunError: Error | null;
/** What getRun returns. */
let fresh: PluginRun | null;
let judgeCalls: PluginJudgeChoiceOptions[];
let judgeAnswer: PluginJudgeChoiceAnswer | Error;
let triageCalls: number;
let triageAnswer: TriageVerdict | Error;
let hasJudge: boolean;
let logFetches: number;
let fileCalls: Array<{ id: string; override: boolean }>;
/** What the injected `file` returns (null = not now). */
let fileAnswer: Filing | null;

const HIGH: TriageVerdict = {
  fixable: true,
  confidence: "high",
  hypothesis: "h",
  files: ["a.ts"],
  reason: "found it",
};

function cand(job: string, over: Partial<Candidate> = {}): Candidate {
  const workflowName = over.workflowName ?? "CI";
  const key = mapKey(REPO, WF, job);
  // The poller owns the key record; seed the one it would have written.
  const rec: KeyRecord = {
    repo: REPO,
    workflowName,
    workflowFile: WF,
    job,
    streak: 1,
    lastRunId: over.runId ?? 7,
    lastConclusion: "failure",
    recent: ["success", "failure"],
  };
  state.set(key, rec);
  return {
    repo: REPO,
    key,
    workflowName,
    workflowFile: WF,
    job,
    streak: 1,
    runId: 7,
    attempt: 1,
    runUrl: "https://gh/runs/7",
    headSha: "abc",
    event: "push",
    ...over,
  };
}

function rerun(jobs: Array<[string, string]>, over: Partial<PluginRun> = {}): PluginRun {
  return {
    id: 7,
    workflowName: "CI",
    workflowFile: WF,
    event: "push",
    status: "completed",
    conclusion: jobs.some(([, c]) => c === "failure") ? "failure" : "success",
    attempt: 2,
    headSha: "abc",
    createdAt: 0,
    url: "https://gh/runs/7",
    jobs: jobs.map(([name, conclusion], i) => ({ id: i, name, conclusion })),
    ...over,
  };
}

function stage() {
  return createClassifier({
    state,
    runs: {
      rerunFailed: async (_repo, id) => {
        reruns.push(id);
        if (rerunError) throw rerunError;
      },
      getRun: async (_repo, id) => {
        getRuns.push(id);
        return fresh;
      },
      failedJobLogs: async () => (
        logFetches++,
        [
          { job: "test (ubuntu, 20)", step: "run tests", lines: ["FAIL x"], truncated: false },
          { job: "lint", step: "eslint", lines: ["error y"], truncated: false },
        ]
      ),
    },
    judge: hasJudge
      ? {
          choice: async (o) => {
            judgeCalls.push(o);
            if (judgeAnswer instanceof Error) throw judgeAnswer;
            return judgeAnswer;
          },
        }
      : null,
    agents: {
      runReadonly: async () => {
        triageCalls++;
        if (triageAnswer instanceof Error) throw triageAnswer;
        return triageAnswer;
      },
    },
    file: async (r, o) => {
      fileCalls.push({ id: r.id, override: o.override });
      return fileAnswer;
    },
    now: () => new Date(clock),
    log: { log: () => {}, warn: () => {} },
  });
}

const rec = (c: Candidate) => state.get<ClassifyRecord>(`triage:${verdictId(c.key, c.runId)}`)!;
const keyRec = (c: Candidate) => state.get<KeyRecord>(c.key)!;
const answer = (choice: string, p: number): PluginJudgeChoiceAnswer => ({
  choice,
  probabilities: { [choice]: p, other: 1 - p },
});

beforeEach(() => {
  state = memState();
  clock = Date.parse("2026-09-28T12:00:00Z");
  reruns = [];
  getRuns = [];
  rerunError = null;
  fresh = null;
  judgeCalls = [];
  judgeAnswer = answer("regression", 0.9);
  triageCalls = 0;
  triageAnswer = HIGH;
  hasJudge = true;
  logFetches = 0;
  fileCalls = [];
  fileAnswer = null;
});

test("probe green → flaky, one rerun, nothing classified", async () => {
  const s = stage();
  const c = cand("test");
  expect(await s.process(c)).toBe("probing");
  expect(reruns).toEqual([7]);
  expect(keyRec(c).classified).toEqual({ runId: 7, outcome: "probing" });

  fresh = rerun([["test (ubuntu, 20)", "success"]]);
  await s.advance();
  expect(rec(c)).toMatchObject({ outcome: "flaky", probe: "green" });
  expect(keyRec(c).classified).toEqual({ runId: 7, outcome: "flaky" });
  expect(judgeCalls.length + triageCalls).toBe(0);
  expect(state.keys().some((k) => k.startsWith("probe:"))).toBe(false);
});

test("probe waits while the attempt is unchanged or the rerun is in flight", async () => {
  const s = stage();
  const c = cand("test");
  await s.process(c);
  fresh = rerun([["test", "failure"]], { attempt: 1 });
  await s.advance();
  fresh = rerun([["test", "failure"]], { status: "in_progress", conclusion: null });
  await s.advance();
  expect(rec(c).outcome).toBe("probing");
  expect(triageCalls).toBe(0);
});

test("probe red → classified", async () => {
  const s = stage();
  const c = cand("test");
  await s.process(c);
  fresh = rerun([["test", "failure"]]);
  await s.advance();
  expect(rec(c)).toMatchObject({ outcome: "accepted", probe: "red" });
  expect(keyRec(c).classified?.outcome).toBe("accepted");
});

test("two failing keys of one run share one rerun and resolve by their own job", async () => {
  const s = stage();
  const a = cand("test");
  const b = cand("lint");
  expect(await s.process(a)).toBe("probing");
  expect(await s.process(b)).toBe("probing");
  expect(reruns).toEqual([7]);

  fresh = rerun([
    ["test (ubuntu, 20)", "success"],
    ["lint", "failure"],
  ]);
  await s.advance();
  expect(getRuns).toEqual([7]);
  expect(rec(a).outcome).toBe("flaky");
  expect(rec(b)).toMatchObject({ outcome: "accepted", probe: "red" });
  expect(triageCalls).toBe(1);
});

test("reject-glob workflow skips the probe and classifies immediately", async () => {
  const s = stage();
  const c = cand("eval", { workflowName: "Eval — stop classifier" });
  expect(await s.process(c)).toBe("accepted");
  expect(reruns).toEqual([]);
  expect(rec(c).probe).toBe("glob");
});

test("rerun refused → classify now; other keys of the run don't retry the rerun", async () => {
  rerunError = new PluginForgeError("unsupported", "gitea");
  const s = stage();
  const a = cand("test");
  const b = cand("lint");
  expect(await s.process(a)).toBe("accepted");
  expect(await s.process(b)).toBe("accepted");
  expect(reruns).toEqual([7]);
  expect(rec(b).probe).toBe("rerun-failed");
});

test("probe timeout or missing run → classify", async () => {
  const s = stage();
  const c = cand("test");
  await s.process(c);
  fresh = rerun([["test", "failure"]], { attempt: 1 });
  clock += PROBE_TIMEOUT_MS + 1;
  await s.advance();
  expect(rec(c)).toMatchObject({ outcome: "accepted", probe: "timeout" });

  const d = cand("lint", { runId: 8 });
  await s.process(d);
  fresh = null;
  await s.advance();
  expect(rec(d)).toMatchObject({ outcome: "accepted", probe: "missing" });
});

test.each([
  ["flaky", 0.9, false],
  ["infra", 0.9, false],
  ["eval-variance", 0.9, false],
  ["regression", 0.59, false],
  ["regression", 0.6, true],
  ["secret-config", 0.7, true],
] as const)("jevGate(%s, %d) → %s", (choice, p, pass) => {
  expect(jevGate(answer(choice, p)).pass).toBe(pass);
});

test("JEV rejection stops before triage; the class and p are recorded", async () => {
  judgeAnswer = answer("infra", 0.8);
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  expect(await s.process(c)).toBe("rejected");
  expect(triageCalls).toBe(0);
  expect(rec(c)).toMatchObject({ stage: "jev", jev: { choice: "infra", p: 0.8 } });
  expect(s.rejected().map((r) => r.id)).toEqual([rec(c).id]);
});

test("JEV input: names + history trusted, only the key's log fenced as untrusted", async () => {
  const s = stage();
  await s.process(cand("test", { workflowName: "Eval x" }));
  const o = judgeCalls[0]!;
  expect(Object.keys(o.options)).toEqual([
    "regression",
    "flaky",
    "infra",
    "secret-config",
    "eval-variance",
  ]);
  expect(o.context).toContain("Job: test");
  expect(o.context).toContain("run tests");
  expect(o.context).toContain("success, failure");
  expect(o.untrusted).toEqual([{ label: "test (ubuntu, 20) / run tests", content: "FAIL x" }]);
});

test.each([
  ["off", false, null],
  ["unavailable", true, new PluginJudgeError("unavailable", "off")],
  ["error", true, new Error("boom")],
] as const)("JEV %s → triage still runs", async (_n, judge, err) => {
  hasJudge = judge;
  if (err) judgeAnswer = err;
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  expect(await s.process(c)).toBe("accepted");
  expect(triageCalls).toBe(1);
  expect(rec(c).jev).toHaveProperty("error");
});

test("triage below fixable+high → rejected at triage", async () => {
  triageAnswer = { ...HIGH, confidence: "medium" };
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  expect(await s.process(c)).toBe("rejected");
  expect(rec(c)).toMatchObject({ stage: "triage", verdict: { confidence: "medium" } });
});

test("triage failure → rejected with the code", async () => {
  triageAnswer = new PluginAgentError("timeout", "slow");
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  expect(await s.process(c)).toBe("rejected");
  expect(rec(c).reason).toBe("triage failed: timeout");
});

test("triage deferred → pending, retried with backoff, logs fetched once, JEV asked once", async () => {
  triageAnswer = new PluginAgentError("cap-exceeded", "cap");
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  expect(await s.process(c)).toBe("deferred");
  expect(rec(c)).toMatchObject({ outcome: "pending", retries: 1 });

  await s.advance(); // same tick: not yet due
  clock += 14 * 60_000;
  await s.advance();
  expect(triageCalls).toBe(1);

  clock += 60_000; // 15 min
  await s.advance();
  expect(triageCalls).toBe(2);
  expect(rec(c)).toMatchObject({ outcome: "pending", retries: 2 });
  clock += 29 * 60_000; // backoff doubled to 30 min
  await s.advance();
  expect(triageCalls).toBe(2);

  triageAnswer = HIGH;
  clock += 60_000;
  await s.advance();
  expect(triageCalls).toBe(3);
  expect(rec(c).outcome).toBe("accepted");
  expect(rec(c)).not.toHaveProperty("logs");
  expect(rec(c)).not.toHaveProperty("retryAt");
  expect(judgeCalls.length).toBe(1);
  expect(logFetches).toBe(1);
});

test("an already classified run is not re-processed", async () => {
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  await s.process(c);
  expect(await s.process(c)).toBe("classified");
  expect(triageCalls).toBe(1);
});

test("a resolution never overwrites a newer streak's classification", async () => {
  const s = stage();
  const c = cand("test");
  await s.process(c);
  state.set(c.key, { ...keyRec(c), classified: undefined }); // green since
  fresh = rerun([["test", "success"]]);
  await s.advance();
  expect(rec(c).outcome).toBe("flaky");
  expect(keyRec(c).classified).toBeUndefined();
});

test("file anyway: rejected → accepted (overridden); unknown 404, non-rejected 409", async () => {
  judgeAnswer = answer("flaky", 0.9);
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  await s.process(c);
  const routes = new Map<string, PluginRouteHandler>();
  registerClassifyRoutes({ route: (m, p, h) => void routes.set(`${m} ${p}`, h) }, s);
  const post = (id: unknown) =>
    routes.get("POST triage/file-anyway")!(
      new Request("http://x", { method: "POST", body: JSON.stringify({ id }) }),
    );

  const listed = await (await routes.get("GET triage/rejected")!(new Request("http://x"))).json();
  expect(listed).toHaveLength(1);

  expect((await post(rec(c).id)).status).toBe(200);
  expect(rec(c)).toMatchObject({ outcome: "accepted", overridden: true });
  expect(keyRec(c).classified?.outcome).toBe("accepted");
  expect(s.rejected()).toEqual([]);
  expect((await post(rec(c).id)).status).toBe(409);
  expect((await post("nope")).status).toBe(404);
  expect((await post(null)).status).toBe(400);
});

test("logSections keeps the latest text within budget", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const out = logSections([{ job: "j", step: "s", lines: big, truncated: false }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.content.length).toBeLessThanOrEqual(24_000);
  expect(out[0]!.content.endsWith("line 4999")).toBe(true);
});

test("accepted → filed; a filing that can't happen now is retried by advance()", async () => {
  const s = stage();
  const c = cand("test", { workflowName: "Eval x" }); // probe skipped
  fileAnswer = { status: "filed", number: 5, url: "u5" };
  expect(await s.process(c)).toBe("issue-filed");
  expect(rec(c).filing).toEqual({ status: "filed", number: 5, url: "u5" });
  expect(fileCalls).toEqual([{ id: rec(c).id, override: false }]);
  await s.advance();
  expect(fileCalls).toHaveLength(1);

  const d = cand("lint", { workflowName: "Eval x", runId: 8 });
  fileAnswer = null;
  expect(await s.process(d)).toBe("accepted");
  expect(rec(d).filing).toBeUndefined();
  fileAnswer = { status: "duplicate", number: 5, url: "u5" };
  await s.advance();
  expect(rec(d).filing).toEqual({ status: "duplicate", number: 5, url: "u5" });
  await s.advance();
  expect(fileCalls).toHaveLength(3);
});

test("file anyway files with the override", async () => {
  judgeAnswer = answer("flaky", 0.9);
  const s = stage();
  const c = cand("eval", { workflowName: "Eval x" });
  await s.process(c);
  fileAnswer = { status: "filed", number: 9, url: "u9" };
  const res = await s.fileAnyway(rec(c).id);
  expect(res).toMatchObject({ ok: true, record: { outcome: "accepted", overridden: true } });
  expect(rec(c).filing).toEqual({ status: "filed", number: 9, url: "u9" });
  expect(fileCalls).toEqual([{ id: rec(c).id, override: true }]);
});
