import { describe, it, expect, beforeEach } from "vitest";
import { demoState } from "./state";
import { bus } from "./bus";
import { displayStatus } from "$lib/display-status";
import type { WsEvent } from "$lib/types";

/** Collect every frame the bus emits while `fn` runs. */
function capture(fn: () => void): WsEvent[] {
  const frames: WsEvent[] = [];
  const unsub = bus.subscribe((ev) => frames.push(ev));
  try {
    fn();
  } finally {
    unsub();
  }
  return frames;
}

const events = (frames: WsEvent[]) => frames.map((f) => f.event);

beforeEach(() => demoState.reset());

describe("demoState.reset() → bootstrap getters", () => {
  it("every bootstrap getter returns a non-empty, shaped value", () => {
    expect(demoState.sessions().length).toBeGreaterThan(0);
    expect(Object.keys(demoState.gitStates()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.activityStates()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.claudeAliveStates()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.workingBlockedStates()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.holdStates()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.subagentStates()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.previewStates()).length).toBeGreaterThan(0);

    expect(demoState.usageLimits().limits.session5h).not.toBeNull();
    expect(demoState.usageLimits().projections.length).toBeGreaterThan(0);
    expect(demoState.update()).toHaveProperty("behind");
    expect(demoState.herdrUpdate()).toHaveProperty("current");
    expect(demoState.codexUpdate()).toHaveProperty("current");
    expect(demoState.starPrompt()).toHaveProperty("shouldPrompt");
    expect(demoState.drain().length).toBeGreaterThan(0);
    expect(demoState.autoMerge().length).toBeGreaterThan(0);
    expect(demoState.completedEpics().length).toBeGreaterThan(0);
  });

  it("every lens getter returns a non-empty, shaped value", () => {
    expect(demoState.settings().repoRoot).toBeTruthy();
    expect(demoState.plugins().length).toBeGreaterThan(0);
    expect(demoState.diagnostics().checks.length).toBeGreaterThan(0);
    expect(demoState.backlog().projects.length).toBeGreaterThan(0);
    expect(Object.keys(demoState.buildQueues()).length).toBeGreaterThan(0);
    expect(demoState.held().length).toBeGreaterThan(0);
    expect(Object.keys(demoState.recaps()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.reviews()).length).toBeGreaterThan(0);
    expect(Object.keys(demoState.planGates()).length).toBeGreaterThan(0);
    expect(demoState.herdDigest()).not.toBeNull();
    expect(demoState.upNext()?.sections.length).toBeGreaterThan(0);
    expect(demoState.steers().length).toBeGreaterThan(0);
    expect(Object.keys(demoState.projectIcons()).length).toBeGreaterThan(0);
    expect(demoState.pendingLearnings().length).toBeGreaterThan(0);
  });

  it("epic getters derive from the seeded epic graph", () => {
    const epic = demoState.epic("/demo/acme/storefront", 100);
    expect(epic?.children.length).toBeGreaterThan(0);
    const summaries = demoState.epicSummaries("/demo/acme/storefront");
    expect(summaries.epics[0].total).toBe(epic!.children.length);
    expect(summaries.subIssues).toContain(101);
  });
});

describe("the rich 8-session scenario is seeded coherently", () => {
  it("all eight stable session ids are present with the expected states", () => {
    const byId = new Map(demoState.sessions().map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual(
      [
        "authstore",
        "checkout-child",
        "coupon",
        "deps",
        "envflag",
        "neon",
        "ogimg",
        "rounding",
      ].sort(),
    );
    expect(byId.get("coupon")!.status).toBe("running");
    expect(byId.get("coupon")!.lastState).toBe("working");
    expect(byId.get("rounding")!.status).toBe("idle");
    expect(byId.get("rounding")!.readyToMerge).toBe(true);
    expect(byId.get("authstore")!.planPhase).toBe("planning");
    expect(byId.get("neon")!.status).toBe("blocked");
    expect(byId.get("neon")!.autopilotPaused).toBe(true);
    expect(byId.get("neon")!.autopilotQuestion).toBeTruthy();
    expect(byId.get("ogimg")!.mergingSince).not.toBeNull();
    expect(byId.get("deps")!.status).toBe("done");
    expect(byId.get("deps")!.manualSteps.length).toBeGreaterThan(0);
    expect(byId.get("envflag")!.status).toBe("done");
    expect(byId.get("envflag")!.manualSteps.length).toBeGreaterThan(0);
    expect(byId.get("envflag")!.manualSteps[0].postMerge).toBe(false);
    expect(byId.get("envflag")!.manualStepsAckedAt).toBeNull();
    expect(byId.get("checkout-child")!.autopilotEnabled).toBe(true);
  });

  it("spans two repos", () => {
    const repos = new Set(demoState.sessions().map((s) => s.repoPath));
    expect(repos).toEqual(new Set(["/demo/acme/storefront", "/demo/acme/api"]));
  });

  it("the Checkout v2 epic links its in-flight children to their sessions", () => {
    const epic = demoState.epic("/demo/acme/storefront", 100)!;
    expect(epic.parentTitle).toBe("Checkout v2");
    const byNumber = new Map(epic.children.map((c) => [c.number, c]));
    expect(byNumber.get(101)!.sessionId).toBe("coupon");
    expect(byNumber.get(102)!.sessionId).toBe("checkout-child");
    expect(byNumber.get(103)!.sessionId).toBe("rounding");
    // A mid-drain epic keeps at least one un-started child for approveEpicNext.
    expect(epic.children.some((c) => c.state === "blocked" || c.state === "ready")).toBe(true);
  });

  it("gitStates carry the PR states the scenario table demands", () => {
    const git = demoState.gitStates();
    expect(git.coupon.state).toBe("none"); // hero has no PR yet
    expect(git.rounding.state).toBe("open"); // ready-to-merge
    expect(git.rounding.checks).toBe("success");
    expect(git.ogimg.state).toBe("open"); // in merge train
    expect(git.deps.state).toBe("merged"); // done
    expect(git.envflag.state).toBe("merged"); // done, un-acked pre-merge step (#1478)
  });

  it("holds cover the blocked question and the owed manual step", () => {
    const holds = demoState.holdStates();
    expect(holds.neon.code).toBe("autopilot-paused");
    expect(holds.deps.code).toBe("manual-steps");
  });

  it("neon is NOT workingBlocked, so displayStatus renders it blocked (not upgraded to running)", () => {
    const neon = demoState.sessions().find((s) => s.id === "neon")!;
    expect(neon.status).toBe("blocked");
    expect(demoState.workingBlockedStates().neon).toBe(false);
    expect(displayStatus(neon, demoState.workingBlockedStates())).toBe("blocked");
  });

  it("no seeded session is stuck working-blocked (which would silently upgrade a blocked status)", () => {
    const blocked = new Set(
      demoState
        .sessions()
        .filter((s) => s.status === "blocked")
        .map((s) => s.id),
    );
    for (const [id, isWorkingBlocked] of Object.entries(demoState.workingBlockedStates())) {
      if (isWorkingBlocked) expect(blocked.has(id)).toBe(false);
    }
  });

  it("diagnostics checks carry valid, existing hintKeys (diagnostics_hint_<tool>_<state>)", () => {
    for (const check of demoState.diagnostics().checks) {
      expect(check.hintKey).toMatch(/^diagnostics_hint_\w+_\w+$/);
    }
  });

  it("the showcased lens datasets are seeded and keyed to the scenario", () => {
    expect(demoState.reviews().rounding).toBeDefined();
    expect(demoState.planGates().authstore?.approved).toBe(true);
    expect(demoState.recaps().deps).toBeDefined();
    expect(Object.keys(demoState.buildQueues())).toContain("coupon");
    expect(demoState.held().length).toBeGreaterThan(0);
    expect(demoState.pendingLearnings().length).toBeGreaterThan(0);
    expect(Object.keys(demoState.projectIcons())).toHaveLength(2);
  });
});

describe("demoState mutators emit the correct WsEvent frames", () => {
  it("reply emits activity + hold-clear + status(running)", () => {
    const frames = capture(() => demoState.reply("coupon", "keep going"));
    expect(events(frames)).toEqual(["session:activity", "session:hold", "session:status"]);
    const status = frames.find((f) => f.event === "session:status");
    expect(status && "status" in status.data && status.data.status).toBe("running");
  });

  it("setAutopilot emits session:autopilot with the new enabled flag", () => {
    const frames = capture(() => demoState.setAutopilot("coupon", false));
    expect(events(frames)).toEqual(["session:autopilot"]);
    const f = frames[0];
    expect(f.event === "session:autopilot" && f.data.enabled).toBe(false);
  });

  it("releasePlanGate emits plangate(executing) + hold-clear + status", () => {
    const frames = capture(() => demoState.releasePlanGate("authstore"));
    expect(events(frames)).toEqual(["session:plangate", "session:hold", "session:status"]);
    const pg = frames[0];
    expect(pg.event === "session:plangate" && pg.data.planPhase).toBe("executing");
    expect(demoState.sessions().find((s) => s.id === "authstore")?.planPhase).toBe("executing");
  });

  it("reviewPlan emits the reviewing latch", () => {
    let status: ReturnType<typeof demoState.reviewPlan> | undefined;
    const frames = capture(() => {
      status = demoState.reviewPlan("authstore");
    });
    expect(status).toBe("started");
    expect(events(frames)).toEqual(["session:plangate-reviewing"]);
  });

  it("reviewPlan returns plan-unavailable without a reviewing latch when no plan gate exists", () => {
    let status: ReturnType<typeof demoState.reviewPlan> | undefined;
    const frames = capture(() => {
      status = demoState.reviewPlan("neon");
    });
    expect(status).toBe("plan-unavailable");
    expect(events(frames)).toEqual([]);
  });

  it("mergePr emits session:merging with a since timestamp", () => {
    const frames = capture(() => demoState.mergePr("rounding"));
    expect(events(frames)).toEqual(["session:merging"]);
    const f = frames[0];
    expect(f.event === "session:merging" && typeof f.data.since).toBe("number");
    expect(demoState.sessions().find((s) => s.id === "rounding")?.mergingSince).not.toBeNull();
  });

  it("landMerge + landRecap: a landed session gets a recap, idempotent across repeat lands", () => {
    expect(demoState.recaps()["ogimg"]).toBeUndefined();
    demoState.landMerge("ogimg");
    const frames = capture(() => demoState.landRecap("ogimg"));
    expect(events(frames)).toEqual([]); // landRecap only mutates world state; the director emits
    const recap = demoState.recaps()["ogimg"];
    expect(recap).toBeTruthy();
    expect(recap?.sessionId).toBe("ogimg");
    expect(recap?.headline).toContain("508"); // ogimg's seeded PR number

    // Landing again is a no-op past the first call — same content, no duplicate/regeneration.
    const again = demoState.landRecap("ogimg");
    expect(again).toEqual(recap);
    expect(demoState.recaps()["ogimg"]).toEqual(recap);
  });

  it("landRecap leaves an already-seeded recap untouched (deps has one from the seed)", () => {
    const before = demoState.recaps()["deps"];
    expect(before).toBeTruthy();
    const result = demoState.landRecap("deps");
    expect(result).toEqual(before);
    expect(demoState.recaps()["deps"]).toEqual(before);
  });

  it("landRecap on an unknown session returns null and touches nothing", () => {
    expect(demoState.landRecap("does-not-exist")).toBeNull();
  });

  it("setReadyToMerge emits session:ready", () => {
    const frames = capture(() => demoState.setReadyToMerge("coupon", true));
    expect(events(frames)).toEqual(["session:ready"]);
    expect(demoState.sessions().find((s) => s.id === "coupon")?.readyToMerge).toBe(true);
  });

  it("approveEpicNext emits epic:update and advances a child", () => {
    const repo = "/demo/acme/storefront";
    const before = demoState.epic(repo, 100)!.children.filter((c) => c.state === "running").length;
    const frames = capture(() => demoState.approveEpicNext(repo, 100));
    expect(events(frames)).toEqual(["epic:update"]);
    const running = demoState.epic(repo, 100)!.children.filter((c) => c.state === "running");
    expect(running.length).toBe(before + 1);
  });

  it("spawnHeld emits session:new + held:changed and grows the herd", () => {
    const before = demoState.sessions().length;
    const heldBefore = demoState.held().length;
    const heldId = demoState.held()[0].id;
    const frames = capture(() => demoState.spawnHeld(heldId));
    expect(events(frames)).toEqual(["session:new", "held:changed"]);
    expect(demoState.sessions().length).toBe(before + 1);
    expect(demoState.held().length).toBe(heldBefore - 1);
  });

  it("archiveSession emits session:archived and removes the session", () => {
    const frames = capture(() => demoState.archiveSession("coupon"));
    expect(events(frames)).toEqual(["session:archived"]);
    expect(demoState.sessions().find((s) => s.id === "coupon")).toBeUndefined();
  });

  it("mergedClearable returns the merged, non-archived deps + envflag sessions", () => {
    expect(demoState.mergedClearable()).toEqual({ ids: ["deps", "envflag"], leftovers: 0 });
  });

  it("clearMerged archives the merged ids, emits session:archived, and deps disappears", () => {
    let result: { cleared: string[]; leftovers: number } | undefined;
    const frames = capture(() => (result = demoState.clearMerged(["deps"])));
    expect(events(frames)).toEqual(["session:archived"]);
    expect(result).toEqual({ cleared: ["deps"], leftovers: 0 });
    expect(demoState.sessions().find((s) => s.id === "deps")).toBeUndefined();
    // envflag is still merged + un-archived, so it's still offered.
    expect(demoState.mergedClearable()).toEqual({ ids: ["envflag"], leftovers: 0 });
  });

  it("clearMerged skips ids that aren't actually merged", () => {
    const result = demoState.clearMerged(["coupon"]);
    expect(result).toEqual({ cleared: [], leftovers: 0 });
    expect(demoState.sessions().find((s) => s.id === "coupon")).toBeDefined();
  });

  it("answerPlanQuestions emits activity and reports delivered", () => {
    let result: { delivered: boolean } | undefined;
    const frames = capture(() => (result = demoState.answerPlanQuestions("authstore")));
    expect(events(frames)).toEqual(["session:activity"]);
    expect(result?.delivered).toBe(true);
  });
});

describe("structuredClone isolation", () => {
  it("mutating live state never leaks into the seed across resets", () => {
    demoState.reset();
    const cleanCount = demoState.sessions().length;
    demoState.archiveSession("coupon");
    demoState.spawnHeld(demoState.held()[0].id);
    demoState.reset();
    // A fresh reset restores the exact seeded herd — no leaked mutations.
    expect(demoState.sessions().length).toBe(cleanCount);
    expect(demoState.sessions().find((s) => s.id === "coupon")).toBeDefined();
    expect(demoState.held().length).toBeGreaterThan(0);
  });
});
