import { test, expect, mock, spyOn } from "bun:test";
import { AutoMergeService, type AutoMergeDeps } from "../src/automerge";
import {
  MergeEnqueuedError,
  StackedMergeRefusedError,
  StackUntestedError,
} from "../src/forge/types";

function baseSession(over: any = {}) {
  return {
    id: "s1",
    desig: "TASK-01",
    repoPath: "/r",
    baseBranch: "main",
    worktreePath: "/wt",
    branch: "shepherd/x",
    status: "idle",
    auto: true,
    issueNumber: 9,
    autopilotEnabled: true,
    autoMergeEnabled: true,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    ...over,
  };
}

function deps(over: Partial<AutoMergeDeps> = {}): AutoMergeDeps {
  const session = baseSession();
  return {
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
      listEpicStack: () => [],
      markEpicStackLanded: mock(() => {}),
    } as any,
    service: {
      archive: mock(() => 1),
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge: mock(async () => {}),
        closeIssue: mock(async () => {}),
      }) as any,
    worktree: { behindBase: async () => false } as any,
    prCache: {
      snapshot: () => ({
        s1: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "h1" },
      }),
    } as any,
    paneAlive: () => true,
    repos: () => ["/r"],
    emitStatus: mock(() => {}),
    emitArchived: mock(() => {}),
    dropPrCache: mock(() => {}),
    retainClaim: mock(() => {}),
    rebaseCap: 5,
    ...over,
  };
}

test("ready PR → forge.merge called with squash + delete-branch, then archived", async () => {
  const merge = mock(async () => {});
  const archive = mock(() => 1);
  const resolveMerging = mock(() => {});
  const noted: Array<{ sessionId: string; prNumber: number; headSha: string | null }> = [];
  const order: string[] = [];
  const d = deps({
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive: mock(() => {
        order.push("archive");
        return archive();
      }),
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging,
    } as any,
    noteMergedForRecap: (input) => {
      order.push("note");
      noted.push(input);
    },
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect((merge as any).mock.calls[0]).toEqual([7, { method: "squash", deleteBranch: true }]);
  expect(archive.mock.calls.length).toBe(1);
  expect((resolveMerging as any).mock.calls).toEqual([["s1", true]]);
  expect(noted).toEqual([{ sessionId: "s1", prNumber: 7, headSha: "h1" }]);
  expect(order).toEqual(["note", "archive"]);
});

test("mergeStateStatus blocked from prCache prevents merge", async () => {
  const merge = mock(async () => {});
  const d = deps({
    prCache: {
      snapshot: () => ({
        s1: {
          state: "open",
          checks: "success",
          mergeable: true,
          mergeStateStatus: "blocked",
          number: 7,
          headSha: "h1",
        },
      }),
    } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(merge).not.toHaveBeenCalled();
});

test("behind → steers a rebase + bumps the counter, does NOT merge", async () => {
  const reply = mock(() => true);
  const setState = mock(() => {});
  const merge = mock(async () => {});
  const d = deps({
    worktree: { behindBase: async () => true } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
  });
  const apState = mock(() => {});
  d.store.setAutoMergeState = setState as any;
  d.store.setAutopilotState = apState as any;
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(1);
  expect((setState as any).mock.calls[0]).toEqual([
    "s1",
    { rebaseCount: 1, rebaseHead: "h1", rebaseSteeredAt: expect.any(Number) },
  ]);
  // The rebase is a fresh procedural task → autopilot's step budget is reset so unblocking
  // it across gates doesn't spuriously trip the runaway cap.
  expect((apState as any).mock.calls[0]).toEqual(["s1", { stepCount: 0 }]);
  expect(merge.mock.calls.length).toBe(0);
});

test("forge.merge throws (non-conflict) → fail-closed: not archived", async () => {
  const archive = mock(() => 1);
  const resolveMerging = mock(() => {});
  const d = deps({
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge: async () => {
          throw new Error("403");
        },
        closeIssue: mock(async () => {}),
      }) as any,
    service: { archive, reply: mock(() => true), resume: mock(() => true), resolveMerging } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(archive.mock.calls.length).toBe(0);
  expect(resolveMerging.mock.calls.length).toBe(0);
});

test("train merge materializes manual steps with the PR number + title (#3133)", async () => {
  const materializeManualSteps = mock(() => {});
  const d = deps({
    materializeManualSteps,
    prCache: {
      snapshot: () => ({
        s1: {
          state: "open",
          checks: "success",
          mergeable: true,
          number: 7,
          title: "feat: x",
          headSha: "h1",
        },
      }),
    } as any,
  });
  await new AutoMergeService(d).pump("/r");
  expect(materializeManualSteps.mock.calls.length).toBe(1);
  const [sess, n, title] = materializeManualSteps.mock.calls[0] as unknown as [any, number, string];
  expect(sess.id).toBe("s1");
  expect(n).toBe(7);
  expect(title).toBe("feat: x");
});

test("failed train merge does not materialize manual steps (#3133)", async () => {
  const materializeManualSteps = mock(() => {});
  const d = deps({
    materializeManualSteps,
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge: async () => {
          throw new Error("403");
        },
        closeIssue: mock(async () => {}),
      }) as any,
  });
  await new AutoMergeService(d).pump("/r");
  expect(materializeManualSteps.mock.calls.length).toBe(0);
});

test("dead pane → resume attempted before steer; counter bumped once resumed", async () => {
  const reply = mock(() => true);
  const resume = mock(() => true);
  const setState = mock(() => {});
  const d = deps({
    worktree: { behindBase: async () => true } as any,
    paneAlive: () => false,
    service: { archive: mock(() => 1), reply, resume, resolveMerging: mock(() => {}) } as any,
  });
  d.store.setAutoMergeState = setState as any;
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(resume.mock.calls.length).toBe(1);
  expect(reply.mock.calls.length).toBe(1);
  expect((setState as any).mock.calls[0]).toEqual([
    "s1",
    { rebaseCount: 1, rebaseHead: "h1", rebaseSteeredAt: expect.any(Number) },
  ]);
});

test("herdr-restored account husk (deferSteer true) → resume attempted before steer, even though paneAlive", async () => {
  const reply = mock(() => true);
  const resume = mock(() => true);
  const setState = mock(() => {});
  const d = deps({
    worktree: { behindBase: async () => true } as any,
    paneAlive: () => true, // pane IS live — only deferSteer forces the resume() detour
    deferSteer: () => true,
    service: { archive: mock(() => 1), reply, resume, resolveMerging: mock(() => {}) } as any,
  });
  d.store.setAutoMergeState = setState as any;
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(resume.mock.calls.length).toBe(1);
  expect(reply.mock.calls.length).toBe(1);
  expect((setState as any).mock.calls[0]).toEqual([
    "s1",
    { rebaseCount: 1, rebaseHead: "h1", rebaseSteeredAt: expect.any(Number) },
  ]);
});

test("deferSteer false + paneAlive true → replies directly, no resume (unchanged)", async () => {
  const reply = mock(() => true);
  const resume = mock(() => true);
  const d = deps({
    worktree: { behindBase: async () => true } as any,
    paneAlive: () => true,
    deferSteer: () => false,
    service: { archive: mock(() => 1), reply, resume, resolveMerging: mock(() => {}) } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(resume.mock.calls.length).toBe(0);
  expect(reply.mock.calls.length).toBe(1);
});

test("behind rebase steer fails to deliver → counter NOT bumped", async () => {
  // count-on-success-only, deliberately. Counting delivery failures here was tried and reverted:
  // resetClearedCounters only clears once the PR is current AND mergeable, and reEngageRebase's
  // reset is unreachable for full-auto sessions, so a transient pane outage spanning rebaseCap
  // pumps would permanently park the PR at the rebase_cap hold. See doRebase's note.
  const reply = mock(() => false);
  const setState = mock(() => {});
  const d = deps({
    worktree: { behindBase: async () => true } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  d.store.setAutoMergeState = setState as any;
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(1);
  expect(setState.mock.calls.length).toBe(0);
});

// ── multi-session ──────────────────────────────────────────────────────────────

test("multi-session: merges ready A then steers rebase for behind B", async () => {
  const sessionA = baseSession({ id: "sA", desig: "TASK-A", autoMergeRebaseCount: 0 });
  const sessionB = baseSession({
    id: "sB",
    desig: "TASK-B",
    autoMergeRebaseCount: 0,
    worktreePath: "/wtB",
    branch: "shepherd/b",
  });
  const mergeA = mock(async () => {});
  const reply = mock(() => true);
  const archive = mock(() => 1);

  // After merging A, store.list() returns only B (A is gone).
  let callCount = 0;
  const listFn = mock(() => {
    callCount++;
    return callCount <= 1 ? [sessionA as any, sessionB as any] : [sessionB as any];
  });
  const getFn = mock((id: string) => (id === "sA" ? (sessionA as any) : (sessionB as any)));

  const d = deps({
    store: {
      get: getFn as any,
      list: listFn as any,
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    service: { archive, reply, resume: mock(() => true), resolveMerging: mock(() => {}) } as any,
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge: mergeA,
        closeIssue: mock(async () => {}),
      }) as any,
    // A is up-to-date (behind=false → ready to merge), B is behind → needs rebase
    worktree: {
      behindBase: async (wt: string) => (wt === "/wt" ? false : true),
    } as any,
    prCache: {
      snapshot: () => ({
        sA: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "hA" },
        sB: { state: "open", checks: "success", mergeable: true, number: 8, headSha: "hB" },
      }),
    } as any,
  });

  const svc = new AutoMergeService(d);
  await svc.pump("/r");

  // A was merged
  expect(mergeA.mock.calls.length).toBe(1);
  expect((mergeA as any).mock.calls[0]).toEqual([7, { method: "squash", deleteBranch: true }]);
  // B got a rebase steer
  expect(reply.mock.calls.length).toBe(1);
});

// ── merge_error status ─────────────────────────────────────────────────────────

test("forge.merge throws → emitStatus called with merge_error state", async () => {
  const emitStatus = mock(() => {});
  const d = deps({
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge: async () => {
          throw new Error("500");
        },
        closeIssue: mock(async () => {}),
      }) as any,
    emitStatus,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  const calls: any[] = (emitStatus as any).mock.calls;
  const errorCall = calls.find((c) => c[0]?.state === "merge_error");
  expect(errorCall).toBeDefined();
});

// ── rebase_cap hold ────────────────────────────────────────────────────────────

test("rebase_cap: behind session at cap → no reply steer, emitStatus rebase_cap", async () => {
  const reply = mock(() => true);
  const emitStatus = mock(() => {});
  const session = baseSession({ autoMergeRebaseCount: 5 }); // at cap
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    worktree: { behindBase: async () => true } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    emitStatus,
    rebaseCap: 5,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(0);
  const calls: any[] = (emitStatus as any).mock.calls;
  const capCall = calls.find((c) => c[0]?.state === "rebase_cap");
  expect(capCall).toBeDefined();
});

test("manual_steps gate: otherwise-ready PR with an un-acked step → emitStatus manual_steps, no merge (#1060)", async () => {
  const emitStatus = mock(() => {});
  const merge = mock(async () => {});
  const session = baseSession({
    manualSteps: [{ id: "ms1", text: "flip the flag", postMerge: false }],
    manualStepsAckedAt: null,
  });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    emitStatus,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(merge.mock.calls.length).toBe(0); // held — not merged
  const calls: any[] = (emitStatus as any).mock.calls;
  const held = calls.find((c) => c[0]?.state === "manual_steps");
  expect(held?.[0]?.sessionId).toBe("s1");
  expect(held?.[0]?.detail).toBe("TASK-01");
});

// ── rebase counter reset on progress ──────────────────────────────────────────

test("reset-on-progress: behind=false + mergeable=true → rebaseCount reset to 0 then merged", async () => {
  // Session had 3 prior rebase attempts, but now the branch is current + conflict-free.
  // pump should reset the counter AND proceed to merge.
  const setState = mock(() => {});
  const merge = mock(async () => {});
  const session = baseSession({ autoMergeRebaseCount: 3 });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: setState,
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
    } as any,
    worktree: { behindBase: async () => false } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive: mock(() => 1),
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  // Counter was reset
  expect((setState as any).mock.calls).toContainEqual([
    "s1",
    { rebaseCount: 0, rebaseHead: null, rebaseSteeredAt: null },
  ]);
  // Merge was called (session is ready after reset)
  expect(merge.mock.calls.length).toBe(1);
});

test("reset-on-progress NEGATIVE: behind=false + mergeable=false → counter NOT reset (still conflicting)", async () => {
  // The branch is current but the host says it can't merge (textual conflict).
  // The counter must NOT be reset — it keeps counting toward the cap.
  const setState = mock(() => {});
  const reply = mock(() => true);
  const session = baseSession({ autoMergeRebaseCount: 3 });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: setState,
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
    } as any,
    worktree: { behindBase: async () => false } as any,
    // PR is open+green but mergeable=false (conflict)
    prCache: {
      snapshot: () => ({
        s1: { state: "open", checks: "success", mergeable: false, number: 7, headSha: "h1" },
      }),
    } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  // No reset call with rebaseCount:0
  const resetCalls = (setState as any).mock.calls.filter((c: any[]) => c[1]?.rebaseCount === 0);
  expect(resetCalls.length).toBe(0);
  // A rebase steer was sent (mergeable=false triggers needsRebase) and counter bumped to 4
  expect(reply.mock.calls.length).toBe(1);
  expect((setState as any).mock.calls).toContainEqual([
    "s1",
    { rebaseCount: 4, rebaseHead: "h1", rebaseSteeredAt: expect.any(Number) },
  ]);
});

// ── behind cache ───────────────────────────────────────────────────────────────

test("behind cache: two pumps with frozen clock call behindBase only once", async () => {
  let nowVal = 1000;
  const behindBase = mock(async () => true);
  const reply = mock(() => true);

  const d = deps({
    worktree: { behindBase } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    now: () => nowVal,
    behindTtlMs: 10_000,
  });

  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  await svc.pump("/r");

  // Both pumps share the same frozen timestamp → behindBase called once
  expect((behindBase as any).mock.calls.length).toBe(1);

  // Advance clock past TTL, pump again → should call again
  nowVal = 1000 + 10_001;
  await svc.pump("/r");
  expect((behindBase as any).mock.calls.length).toBe(2);
});

// ── tick repo-gating ───────────────────────────────────────────────────────────

test("tick: skips repo with no full-auto session (no merge/steer)", async () => {
  const merge = mock(async () => {});
  const reply = mock(() => true);
  // Repo flag off AND the session opts merge OFF → no full-auto session exists → train idle.
  const session = baseSession({ autoMergeEnabled: false });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: false, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge,
        closeIssue: mock(async () => {}),
      }) as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });

  const svc = new AutoMergeService(d);
  await svc.tick();

  expect(merge.mock.calls.length).toBe(0);
  expect(reply.mock.calls.length).toBe(0);
});

test("the Operator Assistant is never carried by the train, even with both overrides forced on", async () => {
  const merge = mock(async () => {});
  const reply = mock(() => true);
  // Overrides forced on and a ready PR cached: only the assistant predicate keeps the train off it.
  const session = baseSession({ operatorAssistant: true, auto: false, issueNumber: null });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.tick();
  await svc.pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(reply.mock.calls.length).toBe(0);
});

// ── Fix 2: per-session override enables the train in a repo defaulting off ────────

test("per-session override true + repo default false → merges (fullAutoRepos via override)", async () => {
  const merge = mock(async () => {});
  const archive = mock(() => 1);
  // Repo flag OFF, but the session overrides autoMergeEnabled true → full-auto → train runs.
  const session = baseSession({ autoMergeEnabled: true });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: false, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive,
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.tick();
  expect(merge.mock.calls.length).toBe(1);
  expect(archive.mock.calls.length).toBe(1);
});

// ── Fix 1: rebase-outstanding guard ──────────────────────────────────────────────

test("rebase outstanding: same head not re-steered / not re-bumped on a second pump", async () => {
  const reply = mock(() => true);
  // First pump: behind + no steered head yet → steer + persist rebaseHead "h1".
  // Mutate the session in place to mirror what the store would persist, then pump again.
  const session = baseSession({ autoMergeRebaseHead: null });
  const setState = mock((_id: string, patch: any) => {
    if (patch.rebaseHead !== undefined) session.autoMergeRebaseHead = patch.rebaseHead;
    if (patch.rebaseCount !== undefined) session.autoMergeRebaseCount = patch.rebaseCount;
  });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: setState as any,
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
    } as any,
    worktree: { behindBase: async () => true } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(1);
  expect(session.autoMergeRebaseHead).toBe("h1");
  expect(session.autoMergeRebaseCount).toBe(1);
  // Second pump, SAME head "h1" still behind → outstanding → no re-steer, no re-bump.
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(1);
  expect(session.autoMergeRebaseCount).toBe(1);
});

// ── Fix 6: merge-error backoff ───────────────────────────────────────────────────

test("merge-error backoff: after CAP failures the stuck PR is skipped, a ready sibling merges", async () => {
  const nowVal = 1000;
  const mergeA = mock(async () => {
    throw new Error("branch protection");
  });
  const mergeB = mock(async () => {});
  const archive = mock(() => 1);
  const sessionA = baseSession({ id: "sA", desig: "TASK-A" });
  const sessionB = baseSession({ id: "sB", desig: "TASK-B", worktreePath: "/wtB" });
  // B appears only after A is permanently stuck, so each pump first tries A.
  const listFn = () => [sessionA as any, sessionB as any];
  const getFn = (id: string) => (id === "sA" ? (sessionA as any) : (sessionB as any));
  const forge = {
    kind: "github",
    mergeMethod: "squash",
    merge: (n: number) => (n === 7 ? mergeA() : mergeB()),
    closeIssue: mock(async () => {}),
  };
  const d = deps({
    store: {
      get: getFn as any,
      list: listFn as any,
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    resolveForge: () => forge as any,
    service: {
      archive,
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    prCache: {
      snapshot: () => ({
        sA: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "hA" },
        sB: { state: "open", checks: "success", mergeable: true, number: 8, headSha: "hB" },
      }),
    } as any,
    now: () => nowVal,
  });
  const svc = new AutoMergeService(d);
  // Each pump: A is first-in-line, fails (attempted-guard breaks the pump). Run CAP times.
  await svc.pump("/r");
  await svc.pump("/r");
  await svc.pump("/r");
  expect(mergeA.mock.calls.length).toBe(3); // CAP failures on head hA
  // Now A is backed off (mergeBlocked) → next pump skips A, B merges.
  await svc.pump("/r");
  expect(mergeA.mock.calls.length).toBe(3); // not re-fired
  expect(mergeB.mock.calls.length).toBe(1);
});

// ── Fix 3: status carries the real sessionId ─────────────────────────────────────

test("status payload carries the affected sessionId (merging)", async () => {
  const emitStatus = mock(() => {});
  const d = deps({ emitStatus });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  const calls: any[] = (emitStatus as any).mock.calls;
  const merging = calls.find((c) => c[0]?.state === "merging");
  expect(merging?.[0]?.sessionId).toBe("s1");
});

test("status payload carries sessionId on rebase_cap hold", async () => {
  const emitStatus = mock(() => {});
  const session = baseSession({ autoMergeRebaseCount: 5 });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    worktree: { behindBase: async () => true } as any,
    emitStatus,
    rebaseCap: 5,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  const calls: any[] = (emitStatus as any).mock.calls;
  const cap = calls.find((c) => c[0]?.state === "rebase_cap");
  expect(cap?.[0]?.sessionId).toBe("s1");
});

// ── Fix 4: rebase steer names the session's real base branch ─────────────────────

test("rebase steer references origin/<baseBranch> from the session", async () => {
  const reply = mock(() => true);
  const session = baseSession({ baseBranch: "develop-trunk" });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    worktree: { behindBase: async () => true } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(1);
  expect((reply as any).mock.calls[0][1]).toContain("origin/develop-trunk");
});

// ── #1401: doMerge records epic integration BEFORE settle ────────────────────

test("doMerge: epic child records epic_integrated (pinned base) BEFORE archive", async () => {
  const order: string[] = [];
  const session = baseSession({ issueNumber: 12 });
  const d = deps({
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => ({ repoPath: "/r", parentIssueNumber: 5, mode: "auto", status: "running" }),
      getEpicIntegrationBranch: () => "epic/5-x",
      recordEpicIntegrated: mock(() => order.push("record")),
    } as any,
    prCache: {
      snapshot: () => ({
        s1: {
          state: "open",
          checks: "success",
          mergeable: true,
          number: 7,
          headSha: "h1",
          url: "http://pr/7",
          baseRefName: "epic/5-x",
        },
      }),
    } as any,
    service: {
      archive: mock(() => {
        order.push("archive");
        return 1;
      }),
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect((d.store.recordEpicIntegrated as any).mock.calls).toEqual([
    ["/r", 5, 12, { number: 7, url: "http://pr/7" }, "epic/5-x"],
  ]);
  expect(order).toEqual(["record", "archive"]); // #1037: row exists before settle reads it
});

test("doMerge: non-epic repo (no epic run) records nothing", async () => {
  const d = deps();
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect((d.store.recordEpicIntegrated as any).mock.calls.length).toBe(0);
});

// ── Defect D: the conflict path must reach rebaseCap even on a dead pane ─────────

test("conflict rebase on an UNRESUMABLE pane still counts + stamps (cap stays reachable)", async () => {
  const setAutoMergeState = mock(() => {});
  const reply = mock(() => true);
  const s = baseSession({ autoMergeRebaseCount: 0 });
  const d = deps({
    store: {
      get: () => s as any,
      list: () => [s as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true }) as any,
      getReview: () => null,
      setAutoMergeState,
      setAutopilotState: mock(() => {}),
      isEpicIntegratedChild: () => false,
      getEpicRun: () => null,
      getEpicIntegrationBranch: () => null,
      recordEpicIntegrated: mock(() => {}),
    } as any,
    // Dead pane that cannot be resumed → doRebase returns before ever replying.
    paneAlive: () => false,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => false),
      resolveMerging: mock(() => {}),
    } as any,
    prCache: {
      snapshot: () => ({
        [s.id]: {
          state: "open",
          checks: "none",
          noCi: false,
          mergeable: false,
          mergeStateStatus: "dirty",
          number: 7,
          headSha: "h1",
        },
      }),
    } as any,
    now: () => 12_345,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");

  // Never steered (the pane is gone) — but the attempt is still recorded, so repeated pumps
  // march to rebaseCap and hand back rather than wedging silently below it.
  expect(reply).not.toHaveBeenCalled();
  expect((setAutoMergeState as any).mock.calls).toContainEqual([
    s.id,
    { rebaseCount: 1, rebaseHead: "h1", rebaseSteeredAt: 12_345 },
  ]);
});

// ── #2059: a stacked PR holds the train instead of burning MERGE_ERROR_CAP ────

/** Deps whose forge refuses every merge the way GithubForge does for a stacked PR. */
function stackedDeps(over: Partial<AutoMergeDeps> = {}) {
  const merge = mock(async () => {
    throw new StackedMergeRefusedError(7, 2, 3);
  });
  const emitStatus = mock(() => {});
  const archive = mock(() => 1);
  const d = deps({
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive,
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    emitStatus,
    ...over,
  });
  return { d, merge, emitStatus, archive };
}

test("stacked refusal → `stacked` status, never `merge_error`, never archived", async () => {
  const { d, emitStatus, archive } = stackedDeps();
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  const states = (emitStatus as any).mock.calls.map((c: any[]) => c[0]?.state);
  expect(states).toContain("stacked");
  expect(states).not.toContain("merge_error");
  expect(archive.mock.calls.length).toBe(0);
});

test("stacked refusal costs the session NO merge-error budget (#2059)", async () => {
  const { d, merge, emitStatus } = stackedDeps();
  const svc = new AutoMergeService(d);
  // Three pumps — one more than MERGE_ERROR_CAP would tolerate for a genuine failure.
  await svc.pump("/r");
  await svc.pump("/r");
  await svc.pump("/r");
  // The forge is asked exactly ONCE: after the first refusal the core holds the PR, so the train
  // stops re-probing. A cap burn would instead show up as three attempts then a backoff.
  expect((merge as any).mock.calls.length).toBe(1);
  expect((emitStatus as any).mock.calls.map((c: any[]) => c[0]?.state)).not.toContain(
    "merge_error",
  );
});

test("stacked hold surfaces on snapshot() too, not only the live status event", async () => {
  const { d } = stackedDeps();
  const svc = new AutoMergeService(d);
  await svc.pump("/r"); // learn the stack
  expect(await svc.snapshot()).toEqual([
    {
      repoPath: "/r",
      enabled: true,
      state: "stacked",
      detail: "TASK-01",
      sessionId: "s1",
      waiting: [{ sessionId: "s1", code: "stacked" }],
    },
  ]);
});

test("an in-flight async merge neither settles the session nor records a failure", async () => {
  const merge = mock(async () => {
    throw new MergeEnqueuedError(7);
  });
  const archive = mock(() => 1);
  const emitStatus = mock(() => {});
  const d = deps({
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive,
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    emitStatus,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(archive.mock.calls.length).toBe(0); // enqueued ≠ merged — must NOT archive
  expect((emitStatus as any).mock.calls.map((c: any[]) => c[0]?.state)).not.toContain(
    "merge_error",
  );
});

test("a stack untested against the trunk holds as stack_untested, not a merge failure (#3192)", async () => {
  const merge = mock(async () => {
    throw new StackUntestedError(7, "main");
  });
  const archive = mock(() => 1);
  const emitStatus = mock(() => {});
  const d = deps({
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: {
      archive,
      reply: mock(() => true),
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    emitStatus,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(archive.mock.calls.length).toBe(0);
  const states = (emitStatus as any).mock.calls.map((c: any[]) => c[0]?.state);
  expect(states).toContain("stack_untested");
  expect(states).not.toContain("merge_error");
  // No backoff recorded: the next pump attempts the merge again.
  await svc.pump("/r");
  expect(merge.mock.calls.length).toBe(2);
});

test("Codex capacity: automatic rebase waits without consuming attempt budget", async () => {
  let free = false;
  const d = deps({ capacity: async () => free, worktree: { behindBase: async () => true } as any });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(d.service.reply).not.toHaveBeenCalled();
  expect(d.store.setAutoMergeState).not.toHaveBeenCalled();
  free = true;
  await svc.pump("/r");
  expect(d.service.reply).toHaveBeenCalledTimes(1);
});

test("snapshot and tick read the session list a constant number of times, not once per repo", async () => {
  // Regression: repoHasFullAuto() re-ran store.list() — a full SELECT + hydrate of every session —
  // for each repo under the root. ~500 dirs there blocked the event loop ~2.6s per GET
  // /api/automerge and per ~30s tick, and every web terminal's keystrokes queued behind it.
  const others = Array.from({ length: 50 }, (_, i) => `/other-${i}`);
  const listCalls = async (repos: string[], run: (svc: AutoMergeService) => Promise<unknown>) => {
    const d = deps({ repos: () => repos });
    const list = spyOn(d.store, "list");
    await run(new AutoMergeService(d));
    return list.mock.calls.length;
  };
  for (const run of [
    (svc: AutoMergeService) => svc.snapshot(),
    (svc: AutoMergeService) => svc.tick(),
  ]) {
    expect(await listCalls(["/r", ...others], run)).toBe(await listCalls(["/r"], run));
  }
});

test("held status carries waiting: critic-pending full-auto PR listed, non-full-auto omitted", async () => {
  const held = baseSession();
  const manual = baseSession({ id: "s2", desig: "TASK-02", autoMergeEnabled: false });
  const emitStatus = mock(() => {});
  const d = deps({
    store: {
      ...deps().store,
      get: (id: string) => ([held, manual].find((s) => s.id === id) as any) ?? null,
      list: () => [held, manual] as any,
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: true, autopilotEnabled: true }) as any,
    } as any,
    prCache: {
      snapshot: () => ({
        s1: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "h1" },
        s2: { state: "open", checks: "success", mergeable: true, number: 8, headSha: "h2" },
      }),
    } as any,
    emitStatus,
  });
  await new AutoMergeService(d).pump("/r");
  const last = (emitStatus as any).mock.calls.at(-1)[0];
  expect(last.waiting).toEqual([{ sessionId: "s1", code: "critic_pending" }]);
});

test("tick clears a stale wait list once full-auto is switched off for the repo", async () => {
  const session = baseSession();
  const emitStatus = mock(() => {});
  const d = deps({
    store: {
      ...deps().store,
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () =>
        ({ autoMergeEnabled: true, criticEnabled: true, autopilotEnabled: true }) as any,
    } as any,
    emitStatus,
  });
  const svc = new AutoMergeService(d);
  await svc.tick();
  expect((emitStatus as any).mock.calls.at(-1)[0].waiting).toEqual([
    { sessionId: "s1", code: "critic_pending" },
  ]);
  session.autoMergeEnabled = false; // operator turns full-auto off for this session
  await svc.tick();
  expect((emitStatus as any).mock.calls.at(-1)[0]).toMatchObject({ enabled: false, waiting: [] });
  const calls = (emitStatus as any).mock.calls.length;
  await svc.tick(); // nothing left to clear → no further emit
  expect((emitStatus as any).mock.calls.length).toBe(calls);
});

// ── #3104: a no-CI repo holds unless the operator opts in to mergeWithoutCi ──

function noCiDeps(
  mergeWithoutCi: boolean,
  merge: () => Promise<void>,
  emitStatus = mock(() => {}),
) {
  return deps({
    store: {
      ...deps().store,
      getRepoConfig: () =>
        ({
          autoMergeEnabled: true,
          criticEnabled: false,
          autopilotEnabled: true,
          mergeWithoutCi,
        }) as any,
    } as any,
    prCache: {
      snapshot: () => ({
        s1: {
          state: "open",
          checks: "none",
          noCi: true,
          mergeable: true,
          number: 7,
          headSha: "h1",
        },
      }),
    } as any,
    resolveForge: () =>
      ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    emitStatus,
  });
}

test("#3104: no-CI repo without mergeWithoutCi → no merge, waiting no_ci", async () => {
  const merge = mock(async () => {});
  const emitStatus = mock(() => {});
  await new AutoMergeService(noCiDeps(false, merge, emitStatus)).pump("/r");
  expect(merge).not.toHaveBeenCalled();
  expect((emitStatus as any).mock.calls.at(-1)[0].waiting).toEqual([
    { sessionId: "s1", code: "no_ci" },
  ]);
});

test("#3104: no-CI repo with mergeWithoutCi → merges", async () => {
  const merge = mock(async () => {});
  await new AutoMergeService(noCiDeps(true, merge)).pump("/r");
  expect((merge as any).mock.calls[0]).toEqual([7, { method: "squash", deleteBranch: true }]);
});

// ── Incremental epic child touching migrations: held, never merged by the train ────────────

/** Deps for an incremental-epic child; `prChangedPaths` is the forge's PR-files read (omit the
 *  key to model a forge without it). */
function migrationsDeps(
  prChangedPaths: ((n: number) => Promise<string[]>) | undefined,
  sessionOver: any = { incrementalEpicParent: 100 },
) {
  const session = baseSession(sessionOver);
  const merge = mock(async () => {});
  const emitStatus = mock(() => {});
  const forge: any = {
    kind: "github",
    mergeMethod: "squash",
    merge,
    closeIssue: mock(async () => {}),
    defaultBranch: async () => "main",
  };
  if (prChangedPaths) forge.prChangedPaths = prChangedPaths;
  const base = deps();
  const d = deps({
    store: { ...base.store, get: () => session as any, list: () => [session as any] } as any,
    resolveForge: () => forge,
    emitStatus,
  });
  return { d, merge, emitStatus };
}

const statesOf = (emitStatus: any) => emitStatus.mock.calls.map((c: any[]) => c[0]?.state);

test("migrations: incremental child touching a migration → `migrations` hold, no merge", async () => {
  const paths = mock<(n: number) => Promise<string[]>>(async () => [
    "src/a.ts",
    "db/migrations/0001_init.sql",
  ]);
  const { d, merge, emitStatus } = migrationsDeps(paths);
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(paths.mock.calls[0]).toEqual([7]);
  expect(statesOf(emitStatus)).toContain("migrations");
  const last = (emitStatus as any).mock.calls.at(-1)[0];
  expect(last).toMatchObject({ detail: "TASK-01", sessionId: "s1" });
  expect(last.waiting).toEqual([{ sessionId: "s1", code: "migrations" }]);
});

test("migrations: incremental child with no migration paths → merges", async () => {
  const { d, merge } = migrationsDeps(async () => ["src/a.ts", "README.md"]);
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls.length).toBe(1);
});

test("migrations: prChangedPaths throws → held (fail closed)", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { d, merge, emitStatus } = migrationsDeps(async () => {
    throw new Error("gh down");
  });
  await new AutoMergeService(d).pump("/r");
  warn.mockRestore();
  expect(merge.mock.calls.length).toBe(0);
  expect(statesOf(emitStatus)).toContain("migrations");
});

test("migrations: forge without prChangedPaths → held (fail closed)", async () => {
  const { d, merge, emitStatus } = migrationsDeps(undefined);
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(statesOf(emitStatus)).toContain("migrations");
});

test("migrations: non-incremental session never probes changed paths, merges", async () => {
  const paths = mock(async () => ["db/migrations/0001_init.sql"]);
  const { d, merge } = migrationsDeps(paths, {});
  await new AutoMergeService(d).pump("/r");
  expect(paths.mock.calls.length).toBe(0);
  expect(merge.mock.calls.length).toBe(1);
});

test("migrations: probe cached per (session, head) — same head → one forge call", async () => {
  const paths = mock(async () => ["drizzle/0001.sql"]);
  const { d } = migrationsDeps(paths);
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  await svc.pump("/r");
  await svc.snapshot();
  expect(paths.mock.calls.length).toBe(1);
});

test("migrations: a new head re-probes", async () => {
  const paths = mock(async () => ["drizzle/0001.sql"]);
  let head = "h1";
  const { d } = migrationsDeps(paths);
  d.prCache = {
    snapshot: () => ({
      s1: { state: "open", checks: "success", mergeable: true, number: 7, headSha: head },
    }),
  } as any;
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  head = "h2";
  await svc.pump("/r");
  expect(paths.mock.calls.length).toBe(2);
});

// ── #3197: an incremental epic's stack (trunk = main) is landed bottom-up by the train ─────────

interface LayerOpts {
  /** Recorded `epic_stack` rows (parent 100). */
  rows?: { childNumber: number; prNumber: number; position: number; landedAt?: number | null }[];
  /** The live stack the host reports for a PR; throw to model a failed read. */
  stackForPr?: (pr: number) => Promise<any>;
  sessions?: any[];
  prs?: Record<string, any>;
  prChangedPaths?: (n: number) => Promise<string[]>;
  now?: () => number;
}

function layerDeps(o: LayerOpts = {}) {
  const sessions = o.sessions ?? [baseSession({ incrementalEpicParent: 100 })];
  const merge = mock<(pr: number, o: any) => Promise<void>>(async () => {});
  const emitStatus = mock(() => {});
  const markEpicStackLanded = mock<(r: string, p: number, c: number, pr: number) => void>(() => {});
  const stackForPr = mock(o.stackForPr ?? (async () => null));
  const forge: any = {
    kind: "github",
    mergeMethod: "squash",
    merge,
    closeIssue: mock(async () => {}),
    defaultBranch: async () => "main",
    stackForPr,
    prChangedPaths: o.prChangedPaths ?? (async () => ["src/a.ts"]),
  };
  const base = deps();
  const rows = (o.rows ?? []).map((r) => ({
    stackNumber: 4,
    baseBranch: "main",
    landedAt: null,
    ...r,
  }));
  const d = deps({
    store: {
      ...base.store,
      get: (id: string) => sessions.find((x) => x.id === id),
      list: () => sessions,
      listEpicStack: () => rows,
      markEpicStackLanded,
    } as any,
    resolveForge: () => forge,
    prCache: {
      snapshot: () =>
        o.prs ?? {
          s1: {
            state: "open",
            checks: "success",
            mergeable: true,
            number: 7,
            headSha: "h1",
            baseRefName: "main",
          },
        },
    } as any,
    emitStatus,
    ...(o.now ? { now: o.now } : {}),
  });
  return { d, merge, emitStatus, stackForPr, markEpicStackLanded };
}

const waitingOf = (emitStatus: any) => (emitStatus as any).mock.calls.at(-1)?.[0]?.waiting;

test("#3197 layer: a layer above an unlanded one is held `stacked`, never merged", async () => {
  const { d, merge, emitStatus, stackForPr } = layerDeps({
    rows: [
      { childNumber: 8, prNumber: 6, position: 1 },
      { childNumber: 9, prNumber: 7, position: 2 },
    ],
  });
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(stackForPr.mock.calls.length).toBe(0); // store-only hold
  expect(waitingOf(emitStatus)).toEqual([{ sessionId: "s1", code: "stacked" }]);
});

test("#3197 layer: the bottom-most unmerged layer merges with allowStacked and is stamped landed", async () => {
  const { d, merge, markEpicStackLanded } = layerDeps({
    rows: [
      { childNumber: 8, prNumber: 6, position: 1, landedAt: 1 },
      { childNumber: 9, prNumber: 7, position: 2 },
    ],
    stackForPr: async () => ({ number: 4, baseRef: "main", prNumbers: [6, 7] }),
  });
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls[0]).toEqual([
    7,
    { method: "squash", deleteBranch: true, allowStacked: true },
  ]);
  expect(markEpicStackLanded.mock.calls[0]).toEqual(["/r", 100, 9, 7]);
});

test("#3197 layer: an uncomposed child on a sibling's branch is held, no stack read", async () => {
  const { d, merge, stackForPr, emitStatus } = layerDeps({
    sessions: [baseSession({ incrementalEpicParent: 100, baseBranch: "shepherd/sib" })],
  });
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(stackForPr.mock.calls.length).toBe(0);
  expect(waitingOf(emitStatus)).toEqual([{ sessionId: "s1", code: "stacked" }]);
});

test("#3197 layer: a foreign PR below is held for the window, then re-confirmed and merged", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let t = 1_000_000;
  let live = [5, 7];
  const { d, merge, emitStatus, stackForPr } = layerDeps({
    rows: [{ childNumber: 9, prNumber: 7, position: 1 }],
    stackForPr: async () => ({ number: 4, baseRef: "main", prNumbers: live }),
    now: () => t,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(statesOf(emitStatus)).not.toContain("merge_error");

  await svc.pump("/r"); // inside the window: held without another read
  expect(stackForPr.mock.calls.length).toBe(1);

  live = [7];
  t += 61_000;
  await svc.pump("/r");
  expect(merge.mock.calls[0]).toEqual([
    7,
    { method: "squash", deleteBranch: true, allowStacked: true },
  ]);
  warn.mockRestore();
});

test("#3197 layer: a throwing stack read sets no hold — the next pump retries", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { d, merge, stackForPr } = layerDeps({
    rows: [{ childNumber: 9, prNumber: 7, position: 1 }],
    stackForPr: async () => {
      throw new Error("gh down");
    },
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  await svc.pump("/r");
  expect(stackForPr.mock.calls.length).toBe(2);
  expect(merge.mock.calls.length).toBe(0);
  warn.mockRestore();
});

test("#3197 keep-branch: a merged branch a live session is based on is not deleted", async () => {
  const successor = baseSession({
    id: "s2",
    incrementalEpicParent: 100,
    issueNumber: 10,
    baseBranch: "shepherd/x",
    branch: "shepherd/y",
  });
  const { d, merge } = layerDeps({
    sessions: [baseSession({ incrementalEpicParent: 100 }), successor],
    rows: [
      { childNumber: 9, prNumber: 7, position: 1 },
      { childNumber: 10, prNumber: 8, position: 2 },
    ],
    stackForPr: async () => ({ number: 4, baseRef: "main", prNumbers: [7, 8] }),
  });
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls[0]).toEqual([
    7,
    { method: "squash", deleteBranch: false, allowStacked: true },
  ]);
});

test("#3197 migrations: a held bottom layer keeps the layer above it held", async () => {
  const upper = baseSession({
    id: "s2",
    incrementalEpicParent: 100,
    issueNumber: 10,
    baseBranch: "shepherd/x",
    branch: "shepherd/y",
  });
  const pr = (number: number, headSha: string) => ({
    state: "open",
    checks: "success",
    mergeable: true,
    number,
    headSha,
    baseRefName: "main",
  });
  const { d, merge, emitStatus } = layerDeps({
    sessions: [baseSession({ incrementalEpicParent: 100 }), upper],
    prs: { s1: pr(7, "h1"), s2: pr(8, "h2") },
    rows: [
      { childNumber: 9, prNumber: 7, position: 1 },
      { childNumber: 10, prNumber: 8, position: 2 },
    ],
    prChangedPaths: async (n) => (n === 7 ? ["db/migrations/0001.sql"] : ["src/a.ts"]),
  });
  await new AutoMergeService(d).pump("/r");
  expect(merge.mock.calls.length).toBe(0);
  expect(waitingOf(emitStatus)).toEqual([
    { sessionId: "s1", code: "migrations" },
    { sessionId: "s2", code: "stacked" },
  ]);
});

// ── #3223: merge-queue base ─────────────────────────────────────────────────────────────────

/** Three green full-auto PRs (#7/#8/#9) on `main`, a forge whose merge enqueues and whose queue
 *  read answers from `queue()`, and a controllable clock. */
function queueRig(o: {
  queue: () => Promise<number[] | null>;
  behind?: boolean;
  merge?: (n: number) => Promise<void>;
  heads?: Record<string, string>;
}) {
  const ids = ["s1", "s2", "s3"];
  const sessions = ids.map((id, i) => baseSession({ id, desig: `TASK-0${i + 1}` }));
  const heads = o.heads ?? {};
  let clock = 1_000_000;
  const merged: number[] = [];
  const merge = mock(async (n: number) => {
    merged.push(n);
    if (o.merge) return o.merge(n);
    throw new MergeEnqueuedError(n);
  });
  const queueReads = mock(o.queue);
  const reply = mock(() => true);
  const d = deps({
    now: () => clock,
    store: {
      ...deps().store,
      get: (id: string) => sessions.find((s) => s.id === id) as any,
      list: () => sessions as any,
    } as any,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => true),
      resolveMerging: mock(() => {}),
    } as any,
    resolveForge: () =>
      ({
        kind: "github",
        mergeMethod: "squash",
        merge,
        mergeQueueEntries: queueReads,
        closeIssue: mock(async () => {}),
      }) as any,
    worktree: { behindBase: async () => o.behind ?? false } as any,
    prCache: {
      snapshot: () =>
        Object.fromEntries(
          ids.map((id, i) => [
            id,
            {
              state: "open",
              checks: "success",
              mergeable: true,
              number: 7 + i,
              headSha: heads[id] ?? "h1",
              baseRefName: "main",
            },
          ]),
        ),
    } as any,
  });
  return {
    svc: new AutoMergeService(d),
    merged,
    queueReads,
    reply,
    advance: (ms: number) => (clock += ms),
  };
}

test("#3223: one pump enqueues every green PR, each exactly once", async () => {
  const rig = queueRig({ queue: async () => [] });
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([7, 8, 9]);
  // A second pump inside the grace window re-merges nothing.
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([7, 8, 9]);
});

test("#3223: queue base + behind → merges, never steers a rebase", async () => {
  const rig = queueRig({ queue: async () => [], behind: true });
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([7, 8, 9]);
  expect(rig.reply).not.toHaveBeenCalled();
});

test("#3223: a PR already in the queue (enqueued by anyone) is skipped and reads as queued", async () => {
  const rig = queueRig({ queue: async () => [7] });
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([8, 9]);
  const [st] = await rig.svc.snapshot();
  expect(st!.waiting).toContainEqual({ sessionId: "s1", code: "queued" });
});

test("#3223: unreadable queue → behind gates as before (fail open to queue-less behavior)", async () => {
  const rig = queueRig({
    queue: async () => {
      throw new Error("graphql rate limit backoff");
    },
    behind: true,
  });
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([]);
  expect(rig.reply).toHaveBeenCalled(); // rebase steer, today's behavior
});

test("#3223: no queue on the base → behind still gates", async () => {
  const rig = queueRig({ queue: async () => null, behind: true });
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([]);
});

test("#3223: ejection on the same head counts a failure; backs off at the cap", async () => {
  // Queue always reads empty: every enqueue is "ejected" once the grace lapses.
  const rig = queueRig({ queue: async () => [] });
  await rig.svc.pump("/r"); // enqueue #1 (all three)
  for (let i = 0; i < 3; i++) {
    rig.advance(61_000); // past grace + queue TTL
    await rig.svc.pump("/r"); // ejection counted, re-enqueued
  }
  const count7 = () => rig.merged.filter((n) => n === 7).length;
  expect(count7()).toBe(3); // the 3rd ejection hits MERGE_ERROR_CAP → backed off
  const [st] = await rig.svc.snapshot();
  expect(st!.waiting).toContainEqual({ sessionId: "s1", code: "merge_backoff" });
});

test("#3223: a head change while queued drops the mark without counting a failure", async () => {
  const heads: Record<string, string> = {};
  const rig = queueRig({ queue: async () => [], heads });
  await rig.svc.pump("/r");
  for (let i = 0; i < 4; i++) {
    heads.s1 = `h${i + 2}`; // agent pushed: GitHub dequeues it
    rig.advance(61_000);
    await rig.svc.pump("/r");
  }
  // Never backed off: every re-enqueue followed a new head, not an ejection.
  expect(rig.merged.filter((n) => n === 7).length).toBe(5);
});

test("#3223: a forge without merge queues keeps today's behavior", async () => {
  const merge = mock(async () => {});
  const d = deps({
    worktree: { behindBase: async () => true } as any,
    resolveForge: () =>
      ({ kind: "gitea", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
  });
  await new AutoMergeService(d).pump("/r");
  expect(merge).not.toHaveBeenCalled();
  expect(d.service.reply).toHaveBeenCalled();
});

test("#3223: queue reads are shared across one pump's sessions", async () => {
  const rig = queueRig({ queue: async () => [] });
  await rig.svc.pump("/r");
  expect(rig.queueReads.mock.calls.length).toBe(1);
});

test("#3223: a PR seen in the queue gets a fresh grace once it leaves (merge, poller lag)", async () => {
  let listed = true;
  const rig = queueRig({ queue: async () => (listed ? [7, 8, 9] : []) });
  await rig.svc.pump("/r"); // enqueue all three
  rig.advance(120_000);
  await rig.svc.pump("/r"); // still listed: grace restarts now
  listed = false;
  rig.advance(30_000); // left the queue 30s ago — inside the fresh grace
  await rig.svc.pump("/r");
  expect(rig.merged).toEqual([7, 8, 9]); // not read as ejected → no re-merge
});
