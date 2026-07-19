import { test, expect, mock } from "bun:test";
import { AutoMergeService, type AutoMergeDeps } from "../src/automerge";

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
  expect((setState as any).mock.calls[0]).toEqual(["s1", { rebaseCount: 1, rebaseHead: "h1" }]);
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
  expect((setState as any).mock.calls[0]).toEqual(["s1", { rebaseCount: 1, rebaseHead: "h1" }]);
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
  expect((setState as any).mock.calls[0]).toEqual(["s1", { rebaseCount: 1, rebaseHead: "h1" }]);
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

test("rebase steer fails to deliver → attempt IS recorded (was: not bumped)", async () => {
  // CONTRACT CHANGE. This previously asserted the counter was NOT bumped, on the reasoning that
  // a steer which never landed shouldn't burn rebase budget. That reasoning cost more than it
  // saved: an unrecorded attempt leaves no rebaseCount and no rebaseHead, so rebaseAvailable
  // stays true forever and — because a rebase decision breaks the pump loop — the session
  // consumes the repo's single rebase slot on every tick, head-of-line blocking its siblings.
  // doRebase now records every attempt, matching reEngageRebase (autopilot.ts:643-648), so a
  // session whose steers keep failing marches to rebaseCap and hands back cleanly instead.
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
  expect((setState as any).mock.calls).toContainEqual(["s1", { rebaseCount: 1, rebaseHead: "h1" }]);
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
  expect((setState as any).mock.calls).toContainEqual(["s1", { rebaseCount: 4, rebaseHead: "h1" }]);
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

// ── Fix 2: per-session override enables the train in a repo defaulting off ────────

test("per-session override true + repo default false → merges (repoHasFullAuto via override)", async () => {
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

test("behind rebase on a DEAD pane records the attempt (no head-of-line block on siblings)", async () => {
  // Without this the session leaves no trace, rebaseAvailable stays true forever, and since a
  // rebase decision breaks the pump loop it consumes the repo's one rebase slot every tick —
  // starving conflicting siblings, i.e. exactly what this change exists to unstick.
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
    paneAlive: () => false,
    service: {
      archive: mock(() => 1),
      reply,
      resume: mock(() => false),
      resolveMerging: mock(() => {}),
    } as any,
    // behind (not conflicting): mergeable true, but the branch is behind its base.
    worktree: { behindBase: async () => true } as any,
    prCache: {
      snapshot: () => ({
        [s.id]: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "h1" },
      }),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");

  expect(reply).not.toHaveBeenCalled();
  // Counted + head recorded, so rebaseAvailable's per-head dedup now suppresses it and the
  // next pump is free to serve a sibling. No rebaseSteeredAt — that stamp is conflict-only.
  expect((setAutoMergeState as any).mock.calls).toContainEqual([
    s.id,
    { rebaseCount: 1, rebaseHead: "h1" },
  ]);
});

test("behind rebase whose steer FAILS on a live pane still records (no head-of-line block)", async () => {
  // The sibling of the dead-pane case, and reachable because the two liveness sources disagree:
  // paneAlive matches via matchAgent's cwd/name fallback, while reply → operatorReply requires a
  // strict liveTerminalIds().has(herdrAgentId). A herdr-recreated pane whose agent id hasn't been
  // re-pointed reads ALIVE here (so resume() is skipped entirely) and DEAD to reply.
  const setAutoMergeState = mock(() => {});
  const s = baseSession({ autoMergeRebaseCount: 0 });
  const resume = mock(() => true);
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
    paneAlive: () => true, // alive to THIS gate…
    service: {
      archive: mock(() => 1),
      reply: mock(() => false), // …but the steer does not land
      resume,
      resolveMerging: mock(() => {}),
    } as any,
    worktree: { behindBase: async () => true } as any,
    prCache: {
      snapshot: () => ({
        [s.id]: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "h1" },
      }),
    } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");

  expect(resume).not.toHaveBeenCalled(); // proves we took the live-pane arm, not the dead one
  expect((setAutoMergeState as any).mock.calls).toContainEqual([
    s.id,
    { rebaseCount: 1, rebaseHead: "h1" },
  ]);
});
