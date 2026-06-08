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
    mergingSince: null,
    mergingTrainId: null,
    autopilotEnabled: true,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    auto: false,
    issueNumber: null,
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
    hasPr: () => opts.openPr ?? false,
    refreshPr: (id) => events.push({ refreshPr: id }),
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

test("any PR (open/merged/closed) → autopilot stands down", async () => {
  // hasPr is true for a PR in ANY state — open is the critic's territory, merged/closed mean
  // the pre-PR mission is over; autopilot must never steer such a session to open another PR.
  const h = harness({ session: sess(), openPr: true, verdict: { kind: "finished", summary: "x" } });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
  await h.svc.onDone("s1"); // even the finished-no-PR path stands down once a PR exists
  expect(h.events.some((e) => "steer" in e)).toBe(false);
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

test("onDone kicks a PR refresh before classifying (catch a just-opened PR)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "finished", summary: "x" },
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ refreshPr: "s1" });
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
    hasPr: () => false,
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

// ───────────────────────── CI-red recovery (onGit) ─────────────────────────
// The post-PR dead zone: once a PR is open the critic owns review, but it only runs
// on green CI (review.ts) and pre-PR autopilot has stood down (hasPr). A PR sitting on
// red CI is steered by nobody. onGit closes that gap: open + checks "failure" → drive
// the task agent to fix the failing checks (dedup per head, step-capped).
import { CI_FIX_STEER } from "../src/autopilot";
import type { GitState } from "../src/forge/types";

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "failure",
    headSha: "sha1",
    number: 7,
    deployConfigured: false,
    ...over,
  };
}

test("open PR + failing CI → CI-fix steer + step++", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git());
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("same failing head is nudged only once", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ headSha: "sha1" }));
  h.svc.onGit("s1", git({ headSha: "sha1" })); // next poll, same red head
  expect(h.events.filter((e) => "steer" in e).length).toBe(1);
  expect(h.state().autopilotStepCount).toBe(1);
});

test("a new failing head (agent pushed a fix that still fails) re-steers", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ headSha: "sha1" }));
  h.svc.onGit("s1", git({ headSha: "sha2" }));
  expect(h.events.filter((e) => "steer" in e).length).toBe(2);
  expect(h.state().autopilotStepCount).toBe(2);
});

test("green CI never triggers a CI-fix steer", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ checks: "success" }));
  expect(h.events.some((e) => "steer" in e)).toBe(false);
});

test("pending CI never triggers a CI-fix steer", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ checks: "pending" }));
  expect(h.events.some((e) => "steer" in e)).toBe(false);
});

test("CI-fix recovery is gated by autopilot enablement", () => {
  const h = harness({ session: sess({ autopilotEnabled: null }), repoEnabled: false });
  h.svc.onGit("s1", git());
  expect(h.events.length).toBe(0);
});

test("a paused session is not CI-steered (already handed to the operator)", () => {
  const h = harness({ session: sess({ autopilotPaused: true }), repoEnabled: true });
  h.svc.onGit("s1", git());
  expect(h.events.some((e) => "steer" in e)).toBe(false);
});

test("CI-fix recovery resumes a dead pane before steering", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true, paneAlive: false });
  h.svc.onGit("s1", git());
  expect(h.events).toContainEqual({ resume: true });
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
});

test("step cap stops CI-fix thrash and pauses to the operator", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  // The session starts at step 0; each distinct red head burns one step (the red CI skips the
  // onPrOpen handoff, so there's no budget reset). With stepCap 10, the 11th distinct failing
  // head surfaces (pauses) instead of steering.
  for (let i = 0; i <= 10; i++) h.svc.onGit("s1", git({ headSha: "sha" + i }));
  expect(h.events.filter((e) => "steer" in e).length).toBe(10);
  expect(h.state().autopilotPaused).toBe(true);
});

test("a green PR-open hands off to the critic (clears a stale pause + resets budget)", () => {
  const h = harness({ session: sess({ autopilotStepCount: 4 }), repoEnabled: true });
  h.svc.onGit("s1", git({ checks: "success" }));
  expect(h.state().autopilotStepCount).toBe(0);
});

test("a deliberate pause survives a PR-open handoff (in-memory openSeen lost on restart)", () => {
  // After a restart openSeen is empty, so the first poll of an already-open green PR re-enters
  // the handoff. An operator's pause (or a CI-fix cap pause whose CI since went green) must NOT
  // be silently cleared and the session re-engaged.
  const h = harness({
    session: sess({ autopilotPaused: true, autopilotStepCount: 7 }),
    repoEnabled: true,
  });
  h.svc.onGit("s1", git({ checks: "success" }));
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.state().autopilotStepCount).toBe(7);
});

test("handoff reset fires once per PR-open, not every poll (preserves CI-fix budget)", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ checks: "success", headSha: "sha1" })); // open transition → reset
  h.svc.onGit("s1", git({ checks: "failure", headSha: "sha1" })); // red → step 1
  h.svc.onGit("s1", git({ checks: "failure", headSha: "sha1" })); // same red head, no reset, no re-steer
  expect(h.state().autopilotStepCount).toBe(1);
});

test("PR closing/merging clears CI dedup so a reopened red head can re-steer", () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ headSha: "sha1" })); // steer 1
  h.svc.onGit("s1", git({ state: "merged", checks: "success" })); // clears dedup + openSeen
  h.svc.onGit("s1", git({ headSha: "sha1" })); // open again, same head → steer 2
  expect(h.events.filter((e) => "steer" in e).length).toBe(2);
});
