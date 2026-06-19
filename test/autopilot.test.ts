import { test, expect, mock } from "bun:test";
import {
  AutopilotService,
  PROCEED_STEER,
  RESEARCH_PROCEED_STEER,
  openPrSteer,
  epicBaseDirective,
  CI_FIX_STEER,
  CI_CAP_MESSAGE,
} from "../src/autopilot";
import { DRAFT_PR_NOTE } from "../src/service";

// The open-PR steer for sess()'s default base branch ("main"), no draft note.
const OPEN_PR_STEER_MAIN = openPrSteer(false, "main");
import type { AutopilotVerdict, Session } from "../src/types";
import type { BlockReason } from "../src/blocked";
import type { GitState } from "../src/forge/types";

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
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: true,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    status: "blocked",
    lastState: "blocked",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
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
  repoDraftMode?: boolean;
  repoMode?: "forge" | "lightweight";
  openPr?: boolean;
  paneAlive?: boolean;
  resumeOk?: boolean;
  steerOk?: boolean;
  fullAuto?: boolean;
  /** Cached PR snapshot returned by the prGit dep (the tick / reEngageCi source). */
  prGit?: GitState | null;
}) {
  let cur = opts.session;
  const events: any[] = [];
  const setAutoMergeStateCalls: any[] = [];
  let classifyCalls = 0;
  const svc = new AutopilotService({
    store: {
      get: () => cur,
      list: () => [cur],
      getRepoConfig: () =>
        ({
          criticEnabled: true,
          autoAddressEnabled: false,
          learningsEnabled: true,
          autopilotEnabled: opts.repoEnabled ?? false,
          draftMode: opts.repoDraftMode ?? false,
          repoMode: opts.repoMode ?? "forge",
        }) as any,
      setAutopilotState: (
        _id: string,
        patch: {
          enabled?: boolean | null;
          stepCount?: number;
          paused?: boolean;
          complete?: boolean;
          question?: string | null;
        },
      ) => {
        cur = {
          ...cur,
          autopilotEnabled: patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled,
          autopilotStepCount: patch.stepCount ?? cur.autopilotStepCount,
          autopilotPaused: patch.paused ?? cur.autopilotPaused,
          autopilotComplete: patch.complete ?? cur.autopilotComplete,
          autopilotQuestion: patch.question === undefined ? cur.autopilotQuestion : patch.question,
        };
      },
      setAutoMergeState: (
        _id: string,
        patch: { rebaseCount?: number; rebaseHead?: string | null },
      ) => {
        setAutoMergeStateCalls.push({ id: _id, patch });
        cur = {
          ...cur,
          autoMergeRebaseCount: patch.rebaseCount ?? cur.autoMergeRebaseCount,
          autoMergeRebaseHead:
            patch.rebaseHead === undefined ? cur.autoMergeRebaseHead : patch.rebaseHead,
        };
      },
    } as any,
    classify: async () => {
      classifyCalls++;
      return opts.verdict ?? { kind: "unknown", summary: "" };
    },
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
    openLocalPr: async (id) => {
      events.push({ openLocalPr: id });
    },
    prGit: () => opts.prGit ?? null,
    fullAuto: () => opts.fullAuto ?? false,
    refreshPr: (id) => events.push({ refreshPr: id }),
    onPause: (id, q) => events.push({ pause: id, q }),
    onComplete: (id, summary) => events.push({ complete: id, summary }),
    onState: (id) => events.push({ state: id }),
    stepCap: 10,
  });
  return {
    svc,
    events,
    state: () => cur,
    mergeStateCalls: setAutoMergeStateCalls,
    classifyCount: () => classifyCalls,
  };
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
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER_MAIN });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("finished verdict in lightweight repo → openLocalPr, no gh-pr-create steer", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "finished", summary: "done, no PR" },
    repoMode: "lightweight",
  });
  await h.svc.onBlock("s1", block(["I'm done."]));
  expect(h.events).toContainEqual({ openLocalPr: "s1" });
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  // no PTY steer landed → step count unchanged (server-side barrier, not a steer)
  expect(h.state().autopilotStepCount).toBe(0);
});

test("finished verdict in forge repo → openPrSteer, never openLocalPr", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "finished", summary: "done, no PR" },
    repoMode: "forge",
  });
  await h.svc.onBlock("s1", block(["I'm done."]));
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER_MAIN });
  expect(h.events.some((e) => "openLocalPr" in e)).toBe(false);
});

test("openPrSteer carries an explicit --base for the session's base branch", () => {
  expect(openPrSteer(false, "epic/9-x")).toContain("gh pr create --base epic/9-x");
  expect(openPrSteer(false, "main")).toContain("gh pr create --base main");
});

test("openPrSteer(false, ...) omits the draft note", () => {
  expect(openPrSteer(false, "main")).not.toContain(DRAFT_PR_NOTE);
});

test("openPrSteer(true, ...) appends the draft note", () => {
  const steer = openPrSteer(true, "main");
  expect(steer).toContain("gh pr create --base main");
  expect(steer).toContain(DRAFT_PR_NOTE);
});

test("epicBaseDirective names the integration branch + --base", () => {
  const d = epicBaseDirective("epic/9-x");
  expect(d).toContain("gh pr create --base epic/9-x");
  expect(d).toContain("epic/9-x");
});

test("finished verdict + draftMode=true → open-PR steer includes draft note", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "finished", summary: "done" },
    repoDraftMode: true,
  });
  await h.svc.onBlock("s1", block(["I'm done."]));
  const steerEv = h.events.find((e) => "steer" in e);
  expect(steerEv).toBeDefined();
  expect(steerEv.steer).toContain(DRAFT_PR_NOTE);
});

test("finished verdict + draftMode=false → open-PR steer equals OPEN_PR_STEER_MAIN", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "finished", summary: "done" },
    repoDraftMode: false,
  });
  await h.svc.onBlock("s1", block(["I'm done."]));
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER_MAIN });
});

test("complete verdict → markComplete + onComplete, no steer, not paused", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "complete", summary: "Created issue #345." },
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events).toContainEqual({ complete: "s1", summary: "Created issue #345." });
  expect(h.state().autopilotComplete).toBe(true);
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().autopilotQuestion).toBe("Created issue #345.");
});

test("complete verdict with empty summary → COMPLETE_MESSAGE fallback", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "complete", summary: "" },
  });
  await h.svc.onDone("s1");
  const ev = h.events.find((e) => "complete" in e);
  expect(ev.summary).toContain("task complete");
  expect(h.state().autopilotComplete).toBe(true);
});

test("already complete → no re-classify (terminal)", async () => {
  const h = harness({
    session: sess({ autopilotComplete: true }),
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e || "complete" in e)).toBe(false);
});

test("onStatus running after complete clears it + resets steps", async () => {
  const h = harness({ session: sess({ autopilotComplete: true, autopilotStepCount: 4 }) });
  h.svc.onStatus("s1", "running");
  expect(h.state().autopilotComplete).toBe(false);
  expect(h.state().autopilotQuestion).toBeNull();
  expect(h.state().autopilotStepCount).toBe(0);
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

test("merge-train driver (override off, repo on) is never classified or steered", async () => {
  // A merge-train driver is created with autopilotEnabled:false even though the repo
  // default is on — neither a finished turn nor a steerable block may steer it elsewhere.
  const h = harness({
    session: sess({ autopilotEnabled: false }),
    repoEnabled: true,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onDone("s1");
  await h.svc.onBlock("s1", block(["I'm done."]));
  // The disabled driver is never classified and never steered (onDone may emit a benign
  // refreshPr kick, so assert on the classifier + steer rather than zero events).
  expect(h.classifyCount()).toBe(0);
  expect(h.events.some((e) => "steer" in e)).toBe(false);
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
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER_MAIN });
});

test("onStatus running after pause clears pause + resets steps", async () => {
  const h = harness({ session: sess({ autopilotPaused: true, autopilotStepCount: 5 }) });
  h.svc.onStatus("s1", "running");
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().autopilotQuestion).toBeNull();
  expect(h.state().autopilotStepCount).toBe(0);
});

test("onStatus running after pause resets autoMergeRebaseCount (operator intervention)", () => {
  const h = harness({
    session: sess({ autopilotPaused: true, autopilotStepCount: 3, autoMergeRebaseCount: 4 }),
  });
  h.svc.onStatus("s1", "running");
  expect(h.mergeStateCalls).toContainEqual({
    id: "s1",
    patch: { rebaseCount: 0, rebaseHead: null },
  });
  expect(h.state().autoMergeRebaseCount).toBe(0);
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

test("full-auto: stays eligible after PR exists (keeps unblocking gates)", async () => {
  const steer = mock(() => true);
  const ap = harness({
    session: sess(),
    openPr: true,
    fullAuto: true,
    verdict: { kind: "gate", summary: "" },
    steerOk: true,
  });
  // Swap out the steer so we can count calls directly
  (ap.svc as any).deps.steer = steer;
  await ap.svc.onBlock("s1", { shape: "yes-no", options: [], tail: [] } as any);
  expect(steer.mock.calls.length).toBe(1);
});

test("non-full-auto: still stands down once a PR exists", async () => {
  const steer = mock(() => true);
  const ap = harness({
    session: sess(),
    openPr: true,
    fullAuto: false,
    verdict: { kind: "gate", summary: "" },
    steerOk: true,
  });
  (ap.svc as any).deps.steer = steer;
  await ap.svc.onBlock("s1", { shape: "yes-no", options: [], tail: [] } as any);
  expect(steer.mock.calls.length).toBe(0);
});

test("full-auto: a 'finished' verdict with a PR does NOT re-steer open-a-PR", async () => {
  const steer = mock(() => true);
  const ap = harness({
    session: sess({ status: "done" }),
    openPr: true,
    fullAuto: true,
    verdict: { kind: "finished", summary: "" },
    steerOk: true,
  });
  (ap.svc as any).deps.steer = steer;
  await ap.svc.onDone("s1");
  expect(steer.mock.calls.length).toBe(0);
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
    openLocalPr: async () => {},
    prGit: () => null,
    fullAuto: () => false,
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

test("open PR + failing CI → CI-fix steer + step++", async () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git());
  await Promise.resolve(); // driveSteer bumps one microtask after the sync onGit returns
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("same failing head is nudged only once", async () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ headSha: "sha1" }));
  await Promise.resolve();
  h.svc.onGit("s1", git({ headSha: "sha1" })); // next poll, same red head
  await Promise.resolve();
  expect(h.events.filter((e) => "steer" in e).length).toBe(1);
  expect(h.state().autopilotStepCount).toBe(1);
});

test("a new failing head (agent pushed a fix that still fails) re-steers", async () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ headSha: "sha1" }));
  await Promise.resolve();
  h.svc.onGit("s1", git({ headSha: "sha2" }));
  await Promise.resolve();
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

test("CI-fix recovery resumes a dead pane before steering", async () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true, paneAlive: false });
  h.svc.onGit("s1", git());
  // driveSteer awaits the (now async) resume on the dead-pane path; flush that microtask
  // so the fire-and-forget steer lands before asserting.
  await Promise.resolve();
  expect(h.events).toContainEqual({ resume: true });
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
});

test("step cap stops CI-fix thrash and pauses to the operator", async () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  // The session starts at step 0; each distinct red head burns one step (the red CI skips the
  // onPrOpen handoff, so there's no budget reset). With stepCap 10, the 11th distinct failing
  // head surfaces (pauses) instead of steering. Flush after each poll so the (async) bump from
  // poll N is visible to the cap check at poll N+1 — the production polls are seconds apart.
  for (let i = 0; i <= 10; i++) {
    h.svc.onGit("s1", git({ headSha: "sha" + i }));
    await Promise.resolve();
  }
  expect(h.events.filter((e) => "steer" in e).length).toBe(10);
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.events).toContainEqual({ pause: "s1", q: CI_CAP_MESSAGE });
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

test("handoff reset fires once per PR-open, not every poll (preserves CI-fix budget)", async () => {
  const h = harness({ session: sess({ status: "running" }), repoEnabled: true });
  h.svc.onGit("s1", git({ checks: "success", headSha: "sha1" })); // open transition → reset
  h.svc.onGit("s1", git({ checks: "failure", headSha: "sha1" })); // red → step 1
  await Promise.resolve(); // let the (async) bump land before the next same-head poll
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

test("eligible() returns null while planPhase === 'planning' (autopilot suppressed)", async () => {
  // A grilling/planning session: autopilot enabled, not paused/complete, no PR. The plan gate
  // owns it until released into execution — autopilot must NOT classify its stop or steer it.
  let classified = false;
  const h = harness({
    session: sess({ planPhase: "planning", status: "done" }),
    repoEnabled: true,
    verdict: { kind: "finished", summary: "x" },
  });
  (h.svc as any).deps.classify = async () => {
    classified = true;
    return { kind: "finished", summary: "x" };
  };
  await h.svc.onDone("s1");
  expect(classified).toBe(false); // never classified
  expect(h.events.some((e) => "steer" in e)).toBe(false); // never steered
});

// ───────────────── tick() idle re-engagement (the silent-hang fix) ─────────────────
// onGit/considerCi fires only on a red-CI STATE CHANGE; the PR poller emits no `session:git`
// for an UNCHANGED red head, so an idle full-auto agent sitting on the same red PR is reached
// by NOBODY there. The recurring tick() owns that case — it reads the cached PR (prGit) directly,
// re-engages each idle poll, and ultimately caps + hands back.

/** A stuck-red full-auto idle session: autopilot on, full-auto, cached open+red PR. */
function stuckRed(over: Partial<Session> = {}) {
  return harness({
    session: sess({ status: "done", ...over }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git(), // open + failure
  });
}

test("real-trigger regression: repeated tick() re-engages an idle red PR, then caps + notifies", () => {
  const h = stuckRed();
  // Each tick re-engages (step++ + CI-fix steer) — NO onGit needed (the gitStateChanged gate
  // never re-emits for the unchanged red head). Drive ticks until the step budget (cap 10) trips.
  for (let i = 0; i < 10; i++) h.svc.tick();
  expect(h.events.filter((e) => "steer" in e && e.steer === CI_FIX_STEER).length).toBe(10);
  expect(h.state().autopilotStepCount).toBe(10);
  expect(h.state().autopilotPaused).toBe(false);
  // The 11th tick is at the cap → pause + push (onPause), no further steer.
  h.svc.tick();
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.events).toContainEqual({ pause: "s1", q: CI_CAP_MESSAGE });
  expect(h.events.filter((e) => "steer" in e).length).toBe(10); // no steer on the cap tick
});

test("idle gate: tick() does not steer a running session", () => {
  const h = stuckRed({ status: "running" });
  h.svc.tick();
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotStepCount).toBe(0);
});

test("idle gate: tick() does not steer a blocked session", () => {
  const h = stuckRed({ status: "blocked" });
  h.svc.tick();
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotStepCount).toBe(0);
});

test("onDone guard: stuck-red full-auto re-engages and does NOT classify", async () => {
  const h = stuckRed();
  await h.svc.onDone("s1");
  expect(h.classifyCount()).toBe(0); // never reached the LLM classifier
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("pending guard: tick() does not re-engage while a classify is mid-flight", async () => {
  // A `done`/idle session is exactly the status held while onDone→consider→classify() awaits the
  // LLM. Without the `pending` guard a tick would steer CI_FIX_STEER + bump over that in-flight
  // classify, racing its dispatch. The guard makes reEngageCi bail so the classify's own dispatch acts.
  const h = stuckRed();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (h.svc as any).deps.classify = async (): Promise<AutopilotVerdict> => {
    await gate;
    return { kind: "complete", summary: "done" };
  };
  const inflight = h.svc.onBlock("s1", block()); // consider() adds `pending`, then awaits classify
  await Promise.resolve(); // yield so onBlock reaches the classify await with `pending` set
  h.svc.tick(); // `pending` set → reEngageCi bails → no CI steer, no bump
  expect(h.events.some((e) => "steer" in e && e.steer === CI_FIX_STEER)).toBe(false);
  expect(h.state().autopilotStepCount).toBe(0);
  release();
  await inflight; // let the gated classify settle so no promise dangles
});

test("guaranteed hand-back on a dead pane: failed resume still bumps toward the cap", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git(),
    paneAlive: false,
    resumeOk: false, // resume fails → steer never lands
  });
  // The bump happens BEFORE the (failing) steer, so each tick counts toward the cap regardless.
  for (let i = 0; i < 10; i++) h.svc.tick();
  await Promise.resolve(); // flush the fire-and-forget sendSteer microtasks
  expect(h.state().autopilotStepCount).toBe(10);
  expect(h.events.some((e) => "steer" in e)).toBe(false); // resume failed → nothing steered
  h.svc.tick(); // at cap → pause
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.events).toContainEqual({ pause: "s1", q: CI_CAP_MESSAGE });
});

test("negative: tick() ignores a session with no PR (prGit null)", () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: true,
    prGit: null,
  });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores a green PR", () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git({ checks: "success" }),
  });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores a pending PR", () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git({ checks: "pending" }),
  });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores a closed PR even when red", () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git({ state: "closed" }),
  });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores a paused session", () => {
  const h = stuckRed({ autopilotPaused: true });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores a complete session", () => {
  const h = stuckRed({ autopilotComplete: true });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores an autopilot-disabled session", () => {
  const h = harness({
    session: sess({ status: "done", autopilotEnabled: false }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git(),
  });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores a non-full-auto session (post-PR CI loop is full-auto only)", () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: false,
    prGit: git(),
  });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

test("negative: tick() ignores an archived session", () => {
  const h = stuckRed({ status: "archived" });
  h.svc.tick();
  expect(h.events.length).toBe(0);
});

// ───────────────────────── research guard ─────────────────────────
// A research session (research: true) in an autopilot-enabled repo is reached by dispatch()
// via the normal onBlock/onDone paths. The guard bars both PR-language steer paths while
// leaving the complete path and non-research behavior untouched.

test("research + finished verdict (no PR) → markComplete, no open-PR steer", async () => {
  const h = harness({
    session: sess({ research: true, status: "done" }),
    verdict: { kind: "finished", summary: "Research done." },
  });
  await h.svc.onDone("s1");
  // No steer event at all — not even a non-PR steer
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  // markComplete fired
  expect(h.events).toContainEqual({ complete: "s1", summary: "Research done." });
  expect(h.state().autopilotComplete).toBe(true);
  expect(h.state().autopilotPaused).toBe(false);
});

test("research + gate verdict → RESEARCH_PROCEED_STEER sent, not PROCEED_STEER", async () => {
  const h = harness({
    session: sess({ research: true }),
    verdict: { kind: "gate", summary: "asking to proceed" },
  });
  await h.svc.onBlock("s1", block());
  const steerEv = h.events.find((e) => "steer" in e);
  expect(steerEv).toBeDefined();
  expect(steerEv.steer).toBe(RESEARCH_PROCEED_STEER);
  expect(steerEv.steer).not.toContain("pull request");
  expect(steerEv.steer).not.toBe(PROCEED_STEER);
  expect(h.state().autopilotStepCount).toBe(1);
});

test("research + complete verdict → markComplete (clean-done preserved)", async () => {
  const h = harness({
    session: sess({ research: true, status: "done" }),
    verdict: { kind: "complete", summary: "Research report filed." },
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events).toContainEqual({ complete: "s1", summary: "Research report filed." });
  expect(h.state().autopilotComplete).toBe(true);
});

test("research + finished + PR already open → early-return (no steer, no markComplete)", async () => {
  const h = harness({
    session: sess({ research: true, status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    openPr: true,
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events.some((e) => "complete" in e)).toBe(false);
  expect(h.state().autopilotComplete).toBe(false);
});

// Negative controls: guard must not bleed into normal sessions
test("non-research + finished verdict → still gets open-PR steer", async () => {
  const h = harness({
    session: sess({ research: false }),
    verdict: { kind: "finished", summary: "done" },
  });
  await h.svc.onBlock("s1", block(["I'm done."]));
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER_MAIN });
  expect(h.events.some((e) => "complete" in e)).toBe(false);
});

test("non-research + gate verdict → still gets PROCEED_STEER, not RESEARCH_PROCEED_STEER", async () => {
  const h = harness({
    session: sess({ research: false }),
    verdict: { kind: "gate", summary: "asking to proceed" },
  });
  await h.svc.onBlock("s1", block());
  const steerEv = h.events.find((e) => "steer" in e);
  expect(steerEv).toBeDefined();
  expect(steerEv.steer).toBe(PROCEED_STEER);
  expect(steerEv.steer).not.toBe(RESEARCH_PROCEED_STEER);
});

// ───────────── merge-train stand-down (don't double-steer the train's rebase) ─────────────
// While a session is merge-train-marked (mergingSince !== null) the train owns it and steers its
// own rebase. Autopilot's CI-fix loop (considerCi + reEngageCi) must stand down so two controllers
// don't steer one agent at once. The gate/classify path stays alive (a procedural prompt must not
// stall the rebase). The mark is the canonical "in a train" signal (pr-poller.ts:223), kept fresh
// by the 60s sweepStaleMerging.

test("merge-train: onGit/considerCi suppressed while marked (no CI steer, no bump)", async () => {
  const h = harness({
    session: sess({ status: "running", mergingSince: Date.now(), mergingTrainId: "train-1" }),
    repoEnabled: true,
  });
  h.svc.onGit("s1", git()); // open + red
  await Promise.resolve();
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotStepCount).toBe(0);
});

test("merge-train: tick/reEngageCi suppressed while marked (no steer)", () => {
  const h = stuckRed({ mergingSince: Date.now(), mergingTrainId: "train-1" });
  h.svc.tick();
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotStepCount).toBe(0);
});

test("merge-train: onDone short-circuits BEFORE classify (no steer, no terminal state)", async () => {
  // The critical regression guard: a marked, idle, open+red FULL-AUTO session whose onDone fires
  // must claim ownership (reEngageCi returns true) so onDone returns BEFORE consider()/classify().
  // If reEngageCi returned false, the LLM classifier could mark this session complete/paused — a
  // terminal state that would survive the mark clearing and wedge the CI-fix loop shut forever.
  const h = stuckRed({ mergingSince: Date.now(), mergingTrainId: "train-1" });
  await h.svc.onDone("s1");
  expect(h.classifyCount()).toBe(0); // (c) classify never invoked → reEngageCi returned true
  expect(h.events.some((e) => "steer" in e)).toBe(false); // (a) no CI-fix steer
  expect(h.state().autopilotComplete).toBe(false); // (b) not wedged terminal
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().autopilotStepCount).toBe(0); // no bump
});

test("merge-train: CI-fix resumes once the mark clears (guard is the only suppressor)", async () => {
  // Same session as the suppressed case but with mergingSince null → the CI-fix steer fires again,
  // proving the mark was the only thing holding the loop down and nothing wedged it terminal.
  const h = harness({
    session: sess({ status: "running", mergingSince: null }),
    repoEnabled: true,
  });
  h.svc.onGit("s1", git());
  await Promise.resolve();
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("merge-train: gate/classify path is NOT suppressed by the mark (CI-fix-only scope)", async () => {
  // A marked session that hits a procedural gate still gets its PROCEED_STEER — the stand-down is
  // scoped to the CI-fix loop, not the gate-unblock path the train's rebase depends on.
  const h = harness({
    session: sess({ mergingSince: Date.now(), mergingTrainId: "train-1" }),
    repoEnabled: true,
    verdict: { kind: "gate", summary: "asking to start" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events).toContainEqual({ steer: PROCEED_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});
