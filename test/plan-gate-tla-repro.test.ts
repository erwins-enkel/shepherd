// Reproductions of the counterexamples TLC found in docs/spec/plan-gate/PlanGate.tla (#4154).
// Each is `test.failing`: it asserts the operator's invariant, and fails because current code
// violates it. The fix PR for each linked issue flips it to `test`. Results and traces:
// docs/spikes/4154-tla-plan-gate.md.
import { expect, test, beforeEach, afterEach } from "bun:test";
import { PlanGateService, planHashOf } from "../src/plan-gate";
import { CodexRolloutResolver } from "../src/codex-activity";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

const APPROVE = { decision: "approve", summary: "ok", body: "", findings: [] };
const CHANGES = { decision: "request-changes", summary: "no", body: "", findings: ["fix X"] };

/** A stateful fake world: one session, the plan_gates row, reviewer_spawns rows, the live plan
 *  file and per-worktree verdict files. Shared across PlanGateService instances, so `restart()`
 *  can model a server restart (fresh in-memory state, same persistent state). */
function world(over: any = {}) {
  const session: any = {
    id: "s1",
    desig: "TASK-01",
    repoPath: "/r",
    baseBranch: "main",
    worktreePath: "/wt",
    prompt: "do X",
    planPhase: "planning",
    auto: false,
  };
  const state = {
    plan: "PLAN A",
    gate: null as any,
    spawns: [] as any[],
    verdicts: new Map<string, unknown>(),
    started: [] as string[],
    wtSeq: 0,
    termSeq: 0,
  };
  const store = {
    get: () => session,
    getPlanGate: () => state.gate,
    putPlanGate: (g: any) => {
      state.gate = g;
    },
    dropPlanGate() {},
    snapshotPlanGates: () => ({}),
    getRepoConfig: () => ({ planGateEnabled: true }),
    addSignal() {},
    setPlanPhase() {},
    listActiveTaskAmendments: () => [],
    recordReviewerSpawn: (r: any) => state.spawns.push({ ...r, completedAt: null }),
    completeReviewerSpawn: (id: string, _u: unknown, at: number) => {
      const row = state.spawns.find((s) => s.reviewerSessionId === id);
      if (row) row.completedAt = at;
    },
    setReviewerSpawnOutcome() {},
    listReviewerSpawns: () => state.spawns.map((s) => ({ ...s })),
    recordAgentPlanRevision() {},
    listPlanRevisions: () => [],
    dropPlanRevisions() {},
    putSpawnNotice: () => true,
    getSpawnNotice: () => null,
    bumpSpawnNoticeSteers: () => 0,
    clearSpawnNotice() {},
  };
  let clock = 1000;
  const deps: any = {
    store,
    herdr: {
      start: async (_l: string, cwd: string) => {
        state.started.push(cwd);
        return { terminalId: `t-${++state.termSeq}` };
      },
      async stop() {},
      listAsync: async () => [],
    },
    worktreeExists: () => true,
    worktree: {
      createDetached: async () => ({ worktreePath: `/wt-rev-${++state.wtSeq}`, branch: "main" }),
      remove() {},
      gitCommonDir: () => "/fake-git-common",
    },
    detectBackend: () => null,
    codexResolver: new CodexRolloutResolver({ listMetas: () => [], now: () => 0 }),
    reply: async () => true,
    paneAlive: async () => true,
    resume: async () => ({}),
    deferSteer: async () => false,
    async release() {},
    async regate() {},
    onChange() {},
    onReviewing() {},
    cap: 3,
    now: () => ++clock,
    readPlan: () => state.plan,
    readVerdict: (wt: string) => state.verdicts.get(wt) ?? null,
    readUsage: async () => null,
    baseSha: () => ({ sha: "abc", anchored: true, ahead: 0 }),
    anchorStaleness: () => ({ behind: 0, changedSince: [] }),
    ...over,
  };
  return {
    session,
    state,
    deps,
    svc: new PlanGateService(deps),
    restart: (extra: any = {}) => new PlanGateService({ ...deps, ...extra }),
  };
}

// CE-1 (#4160; INV-ApprovalMatchesReviewed): the reviewer reads plan A; the plan changes to B; the server
// restarts; adoptOrphans -> buildAdoptedInflight hashes the CURRENT plan (B), so the reviewer's
// approval of A is stamped on B — a plan no reviewer has read.
test.failing(
  "CE-1: an adopted orphan's approval is stamped on the plan the reviewer read",
  async () => {
    const w = world();
    await w.svc.consider(w.session);
    expect(w.state.started).toHaveLength(1);
    const reviewerWt = w.state.spawns[0]!.worktreePath;

    w.state.plan = "PLAN B"; // agent (or operator) edits the plan while the review runs
    const restarted = w.restart(); // server restart: in-memory inflight is gone
    await restarted.adoptOrphans();
    w.state.verdicts.set(reviewerWt, APPROVE); // the reviewer approves what it read: PLAN A
    await restarted.tick();

    expect(w.state.gate.approved).toBe(true);
    expect(w.state.gate.planHash).toBe(planHashOf("PLAN A"));
  },
);

// CE-2 (#4161; INV-SingleReviewer / INV-NoLeakedSpawn / INV-NoStaleReviewer): at boot, adoptOrphans checks
// `inflight`/`starting`, then awaits buildAdoptedInflight (herdr.listAsync). A consider() in that
// window passes its own guard and spawns a second reviewer; whichever `inflight.set` lands last
// wins and the other reviewer is never finalized.
test.failing(
  "CE-2: consider() does not spawn a second reviewer while an orphan is being adopted",
  async () => {
    const w = world();
    await w.svc.consider(w.session); // reviewer #1 running, then the server restarts
    expect(w.state.started).toHaveLength(1);

    const listing = Promise.withResolvers<never[]>();
    const restarted = w.restart({
      herdr: { ...w.deps.herdr, listAsync: () => listing.promise },
    });
    const adopting = restarted.adoptOrphans(); // parks in resolveTerminal
    await restarted.consider(w.session); // a settle edge fires during the boot chain
    listing.resolve([]);
    await adopting;

    expect(w.state.started).toHaveLength(1);
  },
);

// CE-3 (#4162; INV-RegateSticks): a forced re-review of an approved-then-edited plan returns
// changes_requested while the session is still PLANNING. applyChangesRequested withdraws the
// approval only for an EXECUTING session before its findings-steer await, so during that await the
// gate still reads approved: Go (releasePlanGateInner) or the chat release
// (releasePlanOnOperatorReply) — both guard on `getPlanGate(id).approved` — move the session to
// executing, and the tail putPlanGate then leaves it executing on a withdrawn approval.
test.failing(
  "CE-3: the approval is withdrawn before the findings steer can be raced by Go",
  async () => {
    let approvedDuringSteer: boolean | undefined;
    const w = world();
    w.deps.reply = async () => {
      approvedDuringSteer = w.state.gate?.approved; // what a concurrent Go / chat release would read
      return true;
    };
    await w.svc.consider(w.session);
    w.state.verdicts.set(w.state.spawns[0]!.worktreePath, APPROVE);
    await w.svc.tick();
    expect(w.state.gate.approved).toBe(true);

    w.state.plan = "PLAN B"; // edited after approval; operator forces a re-review (#2224)
    await w.svc.consider(w.session, { force: true });
    expect(w.state.started).toHaveLength(2);
    w.state.verdicts.set(w.state.spawns[1]!.worktreePath, CHANGES);
    await w.svc.tick();

    expect(w.state.gate.approved).toBe(false);
    expect(approvedDuringSteer).toBe(false);
  },
);

// CE-4 (#4163; INV-NoLeakedSpawn): reapReviewer (PR auto-advance) drops a run that is mid-finalize;
// a forced re-review then claims the slot; when the old finalize's tick() reaches its finally,
// dropInflight deletes `inflight` by SESSION id — removing the new run, whose verdict is never read.
test("CE-4: a finishing finalize does not drop a newer run's inflight entry", async () => {
  const stopping = Promise.withResolvers<void>();
  const w = world();
  w.deps.herdr.stop = (terminalId: string) =>
    terminalId === "t-1" ? stopping.promise : Promise.resolve();
  await w.svc.consider(w.session);
  w.state.verdicts.set(w.state.spawns[0]!.worktreePath, APPROVE);
  const ticking = w.svc.tick(); // approves PLAN A, then parks in finalize's herdr.stop
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(w.state.gate?.approved).toBe(true);

  w.session.planPhase = "executing"; // a PR appeared: advanceToExecutionOnPr ...
  w.svc.reapReviewer(w.session.id); // ... + planGate.reapReviewer (index.ts)
  w.state.plan = "PLAN B";
  await w.svc.consider(w.session, { force: true }); // operator re-reviews the edited plan
  expect(w.svc.reviewingIds()).toEqual(["s1"]);

  stopping.resolve();
  await ticking;

  expect(w.svc.reviewingIds()).toEqual(["s1"]);
});

// #4163 follow-on: the same race, parked one await earlier (captureRunUsage, before finalize's
// `finally`). The old run's run-ended signal must not clear the NEW run's reviewing state.
test("a finishing finalize does not signal run-ended over a newer run", async () => {
  const usage = Promise.withResolvers<null>();
  const events: [string, boolean][] = [];
  let usageCalls = 0;
  const w = world({
    readUsage: () => (++usageCalls === 1 ? usage.promise : Promise.resolve(null)),
    onReviewing: (id: string, reviewing: boolean) => events.push([id, reviewing]),
  });
  await w.svc.consider(w.session);
  w.state.verdicts.set(w.state.spawns[0]!.worktreePath, APPROVE);
  const ticking = w.svc.tick(); // approves PLAN A, then parks in captureRunUsage
  await new Promise((r) => setTimeout(r, 0));
  expect(usageCalls).toBe(1);

  w.session.planPhase = "executing";
  w.svc.reapReviewer(w.session.id);
  w.state.plan = "PLAN B";
  await w.svc.consider(w.session, { force: true });
  expect(events.at(-1)).toEqual(["s1", true]);

  usage.resolve(null);
  await ticking;

  expect(events.filter(([id]) => id === "s1").at(-1)).toEqual(["s1", true]);
  expect(w.svc.reviewingIds()).toEqual(["s1"]);
});
