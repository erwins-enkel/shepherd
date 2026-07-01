import { describe, it, expect, beforeEach } from "vitest";
import { demoState } from "./state";
import { bus } from "./bus";
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
    const repo = demoState.sessions()[0].repoPath;
    const epic = demoState.epic(repo, 100);
    expect(epic?.children.length).toBeGreaterThan(0);
    const summaries = demoState.epicSummaries(repo);
    expect(summaries.epics[0].total).toBe(epic!.children.length);
    expect(summaries.subIssues).toContain(101);
  });
});

describe("demoState mutators emit the correct WsEvent frames", () => {
  it("reply emits activity + hold-clear + status(running)", () => {
    const frames = capture(() => demoState.reply("s1", "keep going"));
    expect(events(frames)).toEqual(["session:activity", "session:hold", "session:status"]);
    const status = frames.find((f) => f.event === "session:status");
    expect(status && "status" in status.data && status.data.status).toBe("running");
  });

  it("setAutopilot emits session:autopilot with the new enabled flag", () => {
    const frames = capture(() => demoState.setAutopilot("s1", false));
    expect(events(frames)).toEqual(["session:autopilot"]);
    const f = frames[0];
    expect(f.event === "session:autopilot" && f.data.enabled).toBe(false);
  });

  it("releasePlanGate emits plangate(executing) + hold-clear + status", () => {
    const frames = capture(() => demoState.releasePlanGate("s2"));
    expect(events(frames)).toEqual(["session:plangate", "session:hold", "session:status"]);
    const pg = frames[0];
    expect(pg.event === "session:plangate" && pg.data.planPhase).toBe("executing");
    expect(demoState.sessions().find((s) => s.id === "s2")?.planPhase).toBe("executing");
  });

  it("reviewPlan emits the reviewing latch", () => {
    const frames = capture(() => demoState.reviewPlan("s2"));
    expect(events(frames)).toEqual(["session:plangate-reviewing"]);
  });

  it("mergePr emits session:merging with a since timestamp", () => {
    const frames = capture(() => demoState.mergePr("s3"));
    expect(events(frames)).toEqual(["session:merging"]);
    const f = frames[0];
    expect(f.event === "session:merging" && typeof f.data.since).toBe("number");
    expect(demoState.sessions().find((s) => s.id === "s3")?.mergingSince).not.toBeNull();
  });

  it("setReadyToMerge emits session:ready", () => {
    const frames = capture(() => demoState.setReadyToMerge("s1", true));
    expect(events(frames)).toEqual(["session:ready"]);
    expect(demoState.sessions().find((s) => s.id === "s1")?.readyToMerge).toBe(true);
  });

  it("approveEpicNext emits epic:update and advances a child", () => {
    const repo = demoState.sessions()[0].repoPath;
    const frames = capture(() => demoState.approveEpicNext(repo, 100));
    expect(events(frames)).toEqual(["epic:update"]);
    const running = demoState.epic(repo, 100)!.children.filter((c) => c.state === "running");
    expect(running.length).toBeGreaterThan(1);
  });

  it("spawnHeld emits session:new + held:changed and grows the herd", () => {
    const before = demoState.sessions().length;
    const heldId = demoState.held()[0].id;
    const frames = capture(() => demoState.spawnHeld(heldId));
    expect(events(frames)).toEqual(["session:new", "held:changed"]);
    expect(demoState.sessions().length).toBe(before + 1);
    expect(demoState.held().length).toBe(0);
  });

  it("archiveSession emits session:archived and removes the session", () => {
    const frames = capture(() => demoState.archiveSession("s1"));
    expect(events(frames)).toEqual(["session:archived"]);
    expect(demoState.sessions().find((s) => s.id === "s1")).toBeUndefined();
  });

  it("answerPlanQuestions emits activity and reports delivered", () => {
    let result: { delivered: boolean } | undefined;
    const frames = capture(() => (result = demoState.answerPlanQuestions("s2")));
    expect(events(frames)).toEqual(["session:activity"]);
    expect(result?.delivered).toBe(true);
  });
});

describe("structuredClone isolation", () => {
  it("mutating live state never leaks into the seed across resets", () => {
    demoState.reset();
    const cleanCount = demoState.sessions().length;
    demoState.archiveSession("s1");
    demoState.spawnHeld(demoState.held()[0].id);
    demoState.reset();
    // A fresh reset restores the exact seeded herd — no leaked mutations.
    expect(demoState.sessions().length).toBe(cleanCount);
    expect(demoState.sessions().find((s) => s.id === "s1")).toBeDefined();
    expect(demoState.held().length).toBeGreaterThan(0);
  });
});
