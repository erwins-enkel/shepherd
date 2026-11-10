import { describe, expect, test } from "bun:test";
import {
  CiStartupFailureService,
  RERUN_SETTLE_MS,
  RUNS_CACHE_TTL_MS,
  STARTUP_GRACE_MS,
  ciStartupSteer,
  classifyStartupRun,
  startupFailureOverlay,
} from "../src/ci-startup-failure";
import type { ForgeRun, GitState } from "../src/forge/types";

const HEAD = "9b5426ba98a8629263d48a9592a385a769bad657";
const RUN_URL = "https://github.com/o/r/actions/runs/42672130324";

function run(over: Partial<ForgeRun> = {}): ForgeRun {
  return {
    id: 42672130324,
    workflowName: "CI",
    workflowFile: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "failure",
    attempt: 1,
    headSha: HEAD,
    createdAt: 1,
    url: RUN_URL,
    ...over,
  };
}

/** TASK-2966's PR as the poller cached it: open, clean, CI repo, an empty rollup. */
function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    number: 34,
    checks: "none",
    mergeable: true,
    mergeStateStatus: "clean",
    headSha: HEAD,
    noCi: false,
    deployConfigured: false,
    ...over,
  };
}

/** A fake GitHub forge: `runs` answers every head read; reruns are recorded. */
function fakeForge(runs: () => ForgeRun[], opts: { rerunFails?: boolean } = {}) {
  const reads: string[] = [];
  const reruns: number[] = [];
  return {
    reads,
    reruns,
    forge: {
      headWorkflowRuns: async (sha: string) => {
        reads.push(sha);
        return runs();
      },
      rerunWorkflowRun: async (id: number, o: { failedOnly: boolean }) => {
        expect(o.failedOnly).toBe(false);
        reruns.push(id);
        if (opts.rerunFails) throw new Error("HTTP 403: this workflow run cannot be re-run");
      },
    },
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("classifyStartupRun", () => {
  test("a first-attempt run that failed before any job is re-run", () => {
    expect(classifyStartupRun(run(), undefined, 0)).toBe("rerun");
    expect(classifyStartupRun(run({ conclusion: "startup_failure" }), undefined, 0)).toBe("rerun");
  });

  test("a later attempt counts as failed: Shepherd never re-runs one twice", () => {
    expect(classifyStartupRun(run({ attempt: 2 }), undefined, 0)).toBe("failed");
  });

  test("after Shepherd re-ran it: running → rerunning, failed again → failed", () => {
    const mark = { at: 0 };
    expect(classifyStartupRun(run({ status: "in_progress", attempt: 2 }), mark, 5)).toBe(
      "rerunning",
    );
    expect(classifyStartupRun(run({ status: "queued", conclusion: null }), mark, 5)).toBe(
      "rerunning",
    );
    expect(classifyStartupRun(run({ attempt: 2 }), mark, 5)).toBe("failed");
  });

  test("a lagging read of the re-run attempt reads as rerunning until the settle window ends", () => {
    const mark = { at: 0 };
    expect(classifyStartupRun(run(), mark, RERUN_SETTLE_MS - 1)).toBe("rerunning");
    expect(classifyStartupRun(run(), mark, RERUN_SETTLE_MS)).toBe("failed");
  });

  test("a re-run the forge refused counts as failed", () => {
    expect(classifyStartupRun(run(), { at: 0, refused: true }, 1)).toBe("failed");
  });

  test("not a startup failure: success, cancelled, skipped, or a run still in flight", () => {
    expect(classifyStartupRun(run({ conclusion: "success" }), undefined, 0)).toBeNull();
    expect(classifyStartupRun(run({ conclusion: "cancelled" }), undefined, 0)).toBeNull();
    expect(classifyStartupRun(run({ conclusion: "skipped" }), undefined, 0)).toBeNull();
    expect(
      classifyStartupRun(run({ status: "in_progress", conclusion: null }), undefined, 0),
    ).toBeNull();
  });
});

describe("startupFailureOverlay", () => {
  test("no entries leaves the state untouched", () => {
    const g = git();
    expect(startupFailureOverlay(g, [])).toBe(g);
  });

  test("a failed run reads as red CI with one job linking the run", () => {
    expect(startupFailureOverlay(git(), [{ run: run(), state: "failed" }])).toEqual({
      ...git(),
      checks: "failure",
      jobs: [{ name: "CI", state: "failure", url: RUN_URL, startupFailure: true }],
    });
  });

  test("a run Shepherd is re-running reads as CI in flight", () => {
    const out = startupFailureOverlay(git(), [{ run: run(), state: "rerunning" }]);
    expect(out.checks).toBe("pending");
    expect(out.runningChecks).toEqual(["CI"]);
    expect(out.jobs).toEqual([
      { name: "CI", state: "pending", url: RUN_URL, startupFailure: true },
    ]);
  });

  test("worst-of like the rollup: one failed run beats one being re-run", () => {
    const out = startupFailureOverlay(git(), [
      { run: run(), state: "failed" },
      {
        run: run({ id: 7, workflowName: "", workflowFile: ".github/workflows/lint.yml" }),
        state: "rerunning",
      },
    ]);
    expect(out.checks).toBe("failure");
    expect(out.jobs?.map((j) => j.name)).toEqual(["CI", ".github/workflows/lint.yml"]);
  });
});

describe("ciStartupSteer", () => {
  test("names the run, says there are no job logs and forbids blind workflow edits", () => {
    const red = startupFailureOverlay(git(), [{ run: run({ attempt: 2 }), state: "failed" }]);
    const text = ciStartupSteer(red)!;
    expect(text).toContain("PR #34");
    expect(text).toContain("head 9b5426b");
    expect(text).toContain(RUN_URL);
    expect(text).toContain("gh run view 42672130324");
    expect(text).toContain("gh run rerun 42672130324");
    expect(text).toContain("before starting any job");
  });

  test("ordinary red CI and a run still being re-run get no startup steer", () => {
    expect(
      ciStartupSteer(git({ checks: "failure", jobs: [{ name: "CI / test", state: "failure" }] })),
    ).toBeNull();
    expect(
      ciStartupSteer(startupFailureOverlay(git(), [{ run: run(), state: "rerunning" }])),
    ).toBeNull();
  });
});

describe("CiStartupFailureService.stamp", () => {
  test("TASK-2966: waits out the grace, re-runs once, then reads red after the re-run fails", async () => {
    const c = clock();
    let current = run();
    const f = fakeForge(() => [current]);
    const svc = new CiStartupFailureService({ now: c.now });

    // Inside the grace: the PR may simply not have registered its checks yet.
    expect(await svc.stamp("s1", git(), f.forge)).toEqual(git());
    expect(f.reads).toEqual([]);

    c.advance(STARTUP_GRACE_MS);
    const first = await svc.stamp("s1", git(), f.forge);
    expect(f.reruns).toEqual([42672130324]);
    expect(first.checks).toBe("pending");

    // GitHub picked the re-run up: attempt 2 in flight, still without jobs.
    current = run({ status: "in_progress", conclusion: null, attempt: 2 });
    c.advance(RUNS_CACHE_TTL_MS);
    expect((await svc.stamp("s1", git(), f.forge)).checks).toBe("pending");

    // The re-run failed the same way: red CI, never a second automatic re-run.
    current = run({ attempt: 2 });
    c.advance(RUNS_CACHE_TTL_MS);
    const red = await svc.stamp("s1", git(), f.forge);
    expect(red.checks).toBe("failure");
    expect(red.jobs).toEqual([
      { name: "CI", state: "failure", url: RUN_URL, startupFailure: true },
    ]);
    c.advance(RUNS_CACHE_TTL_MS);
    await svc.stamp("s1", git(), f.forge);
    expect(f.reruns).toEqual([42672130324]);
  });

  test("a run whose first attempt someone else already re-ran is never re-run again", async () => {
    const c = clock();
    const f = fakeForge(() => [run({ attempt: 3 })]);
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), f.forge);
    c.advance(STARTUP_GRACE_MS);
    expect((await svc.stamp("s1", git(), f.forge)).checks).toBe("failure");
    expect(f.reruns).toEqual([]);
  });

  test("a refused re-run reads red at once", async () => {
    const c = clock();
    const f = fakeForge(() => [run()], { rerunFails: true });
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), f.forge);
    c.advance(STARTUP_GRACE_MS);
    expect((await svc.stamp("s1", git(), f.forge)).checks).toBe("failure");
    c.advance(RUNS_CACHE_TTL_MS);
    expect((await svc.stamp("s1", git(), f.forge)).checks).toBe("failure");
    expect(f.reruns).toEqual([42672130324]);
  });

  test("two overlapping reads of one PR issue a single re-run", async () => {
    const c = clock();
    const f = fakeForge(() => [run()]);
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), f.forge);
    c.advance(STARTUP_GRACE_MS);
    const [a, b] = await Promise.all([
      svc.stamp("s1", git(), f.forge),
      svc.stamp("s1", git(), f.forge),
    ]);
    expect(f.reruns).toEqual([42672130324]);
    expect([a.checks, b.checks]).toEqual(["pending", "pending"]);
  });

  test("head runs are read at most once per cache window", async () => {
    const c = clock();
    const f = fakeForge(() => [run({ conclusion: "cancelled" })]);
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), f.forge);
    c.advance(STARTUP_GRACE_MS);
    await svc.stamp("s1", git(), f.forge);
    await svc.stamp("s1", git(), f.forge);
    expect(f.reads).toEqual([HEAD]);
    c.advance(RUNS_CACHE_TTL_MS);
    await svc.stamp("s1", git(), f.forge);
    expect(f.reads).toEqual([HEAD, HEAD]);
  });

  test("only the newest run of a workflow counts", async () => {
    const c = clock();
    const f = fakeForge(() => [
      run({ id: 1, createdAt: 1 }),
      run({ id: 2, createdAt: 2, status: "in_progress", conclusion: null }),
    ]);
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), f.forge);
    c.advance(STARTUP_GRACE_MS);
    expect(await svc.stamp("s1", git(), f.forge)).toEqual(git());
    expect(f.reruns).toEqual([]);
  });

  test("a new head restarts the grace", async () => {
    const c = clock();
    const f = fakeForge(() => [run({ headSha: "new" })]);
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), f.forge);
    c.advance(STARTUP_GRACE_MS);
    expect(await svc.stamp("s1", git({ headSha: "new" }), f.forge)).toEqual(
      git({ headSha: "new" }),
    );
    expect(f.reads).toEqual([]);
  });

  test("a failed runs read leaves the state untouched", async () => {
    const c = clock();
    const svc = new CiStartupFailureService({ now: c.now });
    const forge = {
      headWorkflowRuns: async () => {
        throw new Error("HTTP 502");
      },
      rerunWorkflowRun: async () => {},
    };
    await svc.stamp("s1", git(), forge);
    c.advance(STARTUP_GRACE_MS);
    expect(await svc.stamp("s1", git(), forge)).toEqual(git());
  });

  test.each([
    ["a repo without PR CI", git({ noCi: true })],
    ["a PR with any check run", git({ jobs: [{ name: "CI / lint", state: "none" }] })],
    ["green CI", git({ checks: "success" })],
    ["CI in flight", git({ checks: "pending" })],
    ["a merged PR", git({ state: "merged" })],
    ["no head", git({ headSha: undefined })],
  ])("leaves %s alone", async (_label, state) => {
    const c = clock();
    const f = fakeForge(() => [run()]);
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", state, f.forge);
    c.advance(STARTUP_GRACE_MS);
    expect(await svc.stamp("s1", state, f.forge)).toEqual(state);
    expect(f.reads).toEqual([]);
    expect(f.reruns).toEqual([]);
  });

  test("a forge without the Actions reads (Gitea, local) is left alone", async () => {
    const c = clock();
    const svc = new CiStartupFailureService({ now: c.now });
    await svc.stamp("s1", git(), {});
    c.advance(STARTUP_GRACE_MS);
    expect(await svc.stamp("s1", git(), {})).toEqual(git());
  });
});
