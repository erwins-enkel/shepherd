import { test, expect } from "bun:test";
import { AutopilotService, PROCEED_STEER, OPEN_PR_STEER } from "../src/autopilot";
import type { AutopilotVerdict, Session } from "../src/types";
import type { BlockReason } from "../src/blocked";

function sess(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "t",
    prompt: "Build login",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
    claudeSessionId: "cs",
    model: null,
    readyToMerge: false,
    autopilotEnabled: true,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    status: "blocked",
    lastState: "blocked",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...over,
  };
}

function block(tail = ["Shall I start? (y/n)"]): BlockReason {
  return { shape: "awaiting-input", options: [], tail };
}

function harness(opts: {
  session: Session;
  verdict?: AutopilotVerdict;
  repoEnabled?: boolean;
  openPr?: boolean;
  paneAlive?: boolean;
  resumeOk?: boolean;
  steerOk?: boolean;
}) {
  let cur = opts.session;
  const events: any[] = [];
  const svc = new AutopilotService({
    store: {
      get: () => cur,
      getRepoConfig: () =>
        ({
          criticEnabled: true,
          autoAddressEnabled: false,
          learningsEnabled: true,
          autopilotEnabled: opts.repoEnabled ?? false,
        }) as any,
      setAutopilotState: (
        _id: string,
        patch: {
          enabled?: boolean | null;
          stepCount?: number;
          paused?: boolean;
          question?: string | null;
        },
      ) => {
        cur = {
          ...cur,
          autopilotEnabled: patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled,
          autopilotStepCount: patch.stepCount ?? cur.autopilotStepCount,
          autopilotPaused: patch.paused ?? cur.autopilotPaused,
          autopilotQuestion: patch.question === undefined ? cur.autopilotQuestion : patch.question,
        };
      },
    } as any,
    classify: async () => opts.verdict ?? { kind: "unknown", summary: "" },
    steer: (_id, text) => {
      events.push({ steer: text });
      return opts.steerOk ?? true;
    },
    resume: () => {
      events.push({ resume: true });
      return opts.resumeOk ?? true;
    },
    paneAlive: () => opts.paneAlive ?? true,
    readTail: () => ["finished, nothing else"],
    hasOpenPr: () => opts.openPr ?? false,
    onPause: (id, q) => events.push({ pause: id, q }),
    onState: (id) => events.push({ state: id }),
    stepCap: 10,
  });
  return { svc, events, state: () => cur };
}

test("gate verdict → proceed steer + step++", async () => {
  const h = harness({ session: sess(), verdict: { kind: "gate", summary: "asking to start" } });
  await h.svc.onBlock("s1", block());
  expect(h.events).toContainEqual({ steer: PROCEED_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
  expect(h.state().autopilotPaused).toBe(false);
});

test("finished verdict → open-PR steer", async () => {
  const h = harness({ session: sess(), verdict: { kind: "finished", summary: "done, no PR" } });
  await h.svc.onBlock("s1", block(["I'm done."]));
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("question verdict → pause + onPause, no steer", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "question", summary: "Which auth provider?" },
  });
  await h.svc.onBlock("s1", block(["Use OAuth or passwords?"]));
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events).toContainEqual({ pause: "s1", q: "Which auth provider?" });
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.state().autopilotQuestion).toBe("Which auth provider?");
});

test("unknown verdict → pause (bias to surface)", async () => {
  const h = harness({ session: sess(), verdict: { kind: "unknown", summary: "" } });
  await h.svc.onBlock("s1", block());
  expect(h.state().autopilotPaused).toBe(true);
});

test("menu shape never classifies or steers (always surfaces as-is)", async () => {
  const h = harness({ session: sess(), verdict: { kind: "gate", summary: "x" } });
  await h.svc.onBlock("s1", { shape: "menu", options: [{ label: "Yes", send: "1" }], tail: [] });
  expect(h.events.length).toBe(0);
  expect(h.state().autopilotStepCount).toBe(0);
});

test("disabled (repo off, no override) → no-op", async () => {
  const h = harness({
    session: sess({ autopilotEnabled: null }),
    repoEnabled: false,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("session override on beats repo off", async () => {
  const h = harness({
    session: sess({ autopilotEnabled: true }),
    repoEnabled: false,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.state().autopilotStepCount).toBe(1);
});

test("session override off beats repo on", async () => {
  const h = harness({
    session: sess({ autopilotEnabled: false }),
    repoEnabled: true,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("open PR → autopilot stands down (critic owns it)", async () => {
  const h = harness({ session: sess(), openPr: true, verdict: { kind: "gate", summary: "x" } });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("already paused → no re-classify", async () => {
  const h = harness({
    session: sess({ autopilotPaused: true }),
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("step at cap → pause instead of steering", async () => {
  const h = harness({
    session: sess({ autopilotStepCount: 10 }),
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotPaused).toBe(true);
});

test("steer that doesn't land → no step++", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "gate", summary: "x" },
    steerOk: false,
  });
  await h.svc.onBlock("s1", block());
  expect(h.state().autopilotStepCount).toBe(0);
});

test("finished + dead pane → resume then steer", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    paneAlive: false,
    resumeOk: true,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ resume: true });
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER });
});

test("onStatus running after pause clears pause + resets steps", async () => {
  const h = harness({ session: sess({ autopilotPaused: true, autopilotStepCount: 5 }) });
  h.svc.onStatus("s1", "running");
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().autopilotQuestion).toBeNull();
  expect(h.state().autopilotStepCount).toBe(0);
});

test("onStatus running when not paused is a no-op (doesn't reset the cap)", async () => {
  const h = harness({ session: sess({ autopilotPaused: false, autopilotStepCount: 5 }) });
  h.svc.onStatus("s1", "running");
  expect(h.state().autopilotStepCount).toBe(5);
});

test("onPrOpen resets steps + clears pause (handoff)", async () => {
  const h = harness({ session: sess({ autopilotPaused: true, autopilotStepCount: 7 }) });
  h.svc.onPrOpen("s1");
  expect(h.state().autopilotStepCount).toBe(0);
  expect(h.state().autopilotPaused).toBe(false);
});

test("onState fired after question verdict pause", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "question", summary: "Which auth provider?" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events).toContainEqual({ state: "s1" });
});

test("onState fired after onStatus clears a pause", () => {
  const h = harness({ session: sess({ autopilotPaused: true }) });
  h.svc.onStatus("s1", "running");
  expect(h.events).toContainEqual({ state: "s1" });
});

test("onState fired after onPrOpen handoff clear", () => {
  const h = harness({ session: sess({ autopilotPaused: true, autopilotStepCount: 3 }) });
  h.svc.onPrOpen("s1");
  expect(h.events).toContainEqual({ state: "s1" });
});

test("re-entrant onBlock during an in-flight classify spawns + steers only once", async () => {
  // The exact spot the plan was broken: a second event for the same session while the
  // first classify is still awaiting must be dropped by the `pending` guard.
  let release!: (v: AutopilotVerdict) => void;
  const inflight = new Promise<AutopilotVerdict>((r) => (release = r));
  let classifyCalls = 0;
  let cur = sess();
  const events: any[] = [];
  const svc = new AutopilotService({
    store: {
      get: () => cur,
      getRepoConfig: () => ({ autopilotEnabled: false }) as any,
      setAutopilotState: (_id: string, patch: any) => {
        cur = {
          ...cur,
          autopilotStepCount: patch.stepCount ?? cur.autopilotStepCount,
          autopilotPaused: patch.paused ?? cur.autopilotPaused,
          autopilotQuestion: patch.question === undefined ? cur.autopilotQuestion : patch.question,
        };
      },
    } as any,
    classify: () => {
      classifyCalls++;
      return inflight;
    },
    steer: (_id, t) => {
      events.push({ steer: t });
      return true;
    },
    resume: () => true,
    paneAlive: () => true,
    readTail: () => [],
    hasOpenPr: () => false,
    onPause: () => {},
    stepCap: 10,
  });
  const first = svc.onBlock("s1", block()); // enters, suspends on classify
  await svc.onBlock("s1", block()); // pending guard → no second classify
  release({ kind: "gate", summary: "x" });
  await first;
  expect(classifyCalls).toBe(1);
  expect(events.filter((e) => "steer" in e).length).toBe(1);
});
