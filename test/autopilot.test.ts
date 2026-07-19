import { test, expect, mock } from "bun:test";
import {
  AutopilotService,
  PROCEED_STEER,
  RESEARCH_PROCEED_STEER,
  openPrSteer,
  epicBaseDirective,
  CI_FIX_STEER,
  CI_CAP_MESSAGE,
  EMPTY_COMPLETION_STEER,
  EMPTY_COMPLETION_MESSAGE,
  rebaseSteer,
  REBASE_CAP_MESSAGE,
} from "../src/autopilot";
import { DRAFT_PR_NOTE } from "../src/service";

// The open-PR steer for sess()'s default base branch ("main"), no draft note.
const OPEN_PR_STEER_MAIN = openPrSteer(false, "main");
import type { AutopilotVerdict, Session, ReviewVerdict } from "../src/types";
import type { BlockReason } from "../src/blocked";
import type { GitState } from "../src/forge/types";
import { OWNERSHIP_TTL_MS } from "../src/automerge-core";

/** Drain the microtask queue to the end. considerCi (the onGit CI-fix path) fire-and-forgets
 *  driveSteer, which bumps the step only AFTER awaiting the now-async steer — two microtask hops
 *  past onGit's synchronous return. A macrotask boundary flushes all of them deterministically. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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
    effort: null,
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
    completionRepromptCount: 0,
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
    epicAuthoring: false,
    landingRepair: false,
    status: "blocked",
    lastState: "blocked",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    spawnTerminalId: null,
    spawnAccountDir: null,
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
  /** Pending MCP OAuth authorize URL returned by the pendingAuthUrl dep (default null = none). */
  pendingAuthUrl?: string | null;
  /** Optional deferSteer dep (SessionService.shouldDeferSteer); omit to test the optional-dep
   *  default (undefined → today's paneAlive-only behavior). */
  deferSteer?: (id: string) => boolean;
  resumeOk?: boolean;
  steerOk?: boolean;
  fullAuto?: boolean;
  /** Cached PR snapshot returned by the prGit dep (the tick / reEngageCi source). */
  prGit?: GitState | null;
  /** Whether the session's branch has a committed diff vs base (default true = work exists). */
  hasDiff?: boolean;
  /** Latest critic verdict returned by the getReview dep (the reEngageRebase review gate). */
  review?: ReviewVerdict | null;
  /** Repo criticEnabled flag (default true, matching getRepoConfig below). */
  criticEnabled?: boolean;
  /** Max rebase steers before reEngageRebase hands back (default 5). */
  rebaseCap?: number;
  /** Injected clock (default 0) so the conflict-ownership window is deterministic. */
  now?: number;
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
          criticEnabled: opts.criticEnabled ?? true,
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
          completionReprompt?: number;
        },
      ) => {
        cur = {
          ...cur,
          autopilotEnabled: patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled,
          autopilotStepCount: patch.stepCount ?? cur.autopilotStepCount,
          autopilotPaused: patch.paused ?? cur.autopilotPaused,
          autopilotComplete: patch.complete ?? cur.autopilotComplete,
          autopilotQuestion: patch.question === undefined ? cur.autopilotQuestion : patch.question,
          completionRepromptCount: patch.completionReprompt ?? cur.completionRepromptCount,
        };
      },
      setAutoMergeState: (
        _id: string,
        patch: {
          rebaseCount?: number;
          rebaseHead?: string | null;
          rebaseSteeredAt?: number | null;
        },
      ) => {
        setAutoMergeStateCalls.push({ id: _id, patch });
        cur = {
          ...cur,
          autoMergeRebaseCount: patch.rebaseCount ?? cur.autoMergeRebaseCount,
          autoMergeRebaseHead:
            patch.rebaseHead === undefined ? cur.autoMergeRebaseHead : patch.rebaseHead,
          autoMergeRebaseSteeredAt:
            patch.rebaseSteeredAt === undefined
              ? cur.autoMergeRebaseSteeredAt
              : patch.rebaseSteeredAt,
        };
      },
    } as any,
    classify: async () => {
      classifyCalls++;
      return opts.verdict ?? { kind: "unknown", summary: "" };
    },
    steer: async (_id, text) => {
      events.push({ steer: text });
      return opts.steerOk ?? true;
    },
    resume: () => {
      events.push({ resume: true });
      return opts.resumeOk ?? true;
    },
    paneAlive: () => opts.paneAlive ?? true,
    deferSteer: opts.deferSteer,
    readTail: () => ["finished, nothing else"],
    pendingAuthUrl: () => opts.pendingAuthUrl ?? null,
    hasPr: () => opts.openPr ?? false,
    hasDiff: async () => opts.hasDiff ?? true,
    openLocalPr: async (id) => {
      events.push({ openLocalPr: id });
    },
    prGit: () => opts.prGit ?? null,
    fullAuto: () => opts.fullAuto ?? false,
    getReview: () => opts.review ?? null,
    refreshPr: (id) => events.push({ refreshPr: id }),
    onPause: (id, q) => events.push({ pause: id, q }),
    onComplete: (id, summary) => events.push({ complete: id, summary }),
    onState: (id) => events.push({ state: id }),
    stepCap: 10,
    rebaseCap: opts.rebaseCap ?? 5,
    now: () => opts.now ?? 0,
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

test("openPrSteer requires local verification before commit/push/PR", () => {
  const steer = openPrSteer(false, "main");
  expect(steer).toContain("Before committing");
  expect(steer).toContain("lint/check/test");
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

test("finished + live pane but deferSteer true (herdr-restored account husk) → resume then steer", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    paneAlive: true, // pane IS live — only deferSteer forces the resume() detour (Locus B re-drive)
    deferSteer: () => true,
    resumeOk: true,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ resume: true });
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER_MAIN });
});

test("finished + live pane + deferSteer false → steers directly, no resume (unchanged)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    paneAlive: true,
    deferSteer: () => false,
  });
  await h.svc.onDone("s1");
  expect(h.events).not.toContainEqual({ resume: true });
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
    patch: { rebaseCount: 0, rebaseHead: null, rebaseSteeredAt: null },
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
  const steer = mock(async () => true);
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
  const steer = mock(async () => true);
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
  const steer = mock(async () => true);
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
    steer: async (_id, t) => {
      events.push({ steer: t });
      return true;
    },
    resume: () => true,
    paneAlive: () => true,
    readTail: () => [],
    pendingAuthUrl: () => null,
    hasPr: () => false,
    hasDiff: async () => true,
    openLocalPr: async () => {},
    prGit: () => null,
    fullAuto: () => false,
    getReview: () => null,
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
  await flush(); // driveSteer bumps a couple microtasks after the sync onGit returns
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
  await flush();
  h.svc.onGit("s1", git({ headSha: "sha2" }));
  await flush();
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
    await flush();
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
  await flush(); // let the (async) bump land before the next same-head poll
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

test("eligible() stands down a NON-isolated codex session (resume --last sibling guard)", async () => {
  // Codex autopilot only drives isolated sessions: a non-isolated pane's resume would run
  // `codex resume --last` against a shared cwd and could steer a sibling. Must not classify/steer.
  let classified = false;
  const h = harness({
    session: sess({ agentProvider: "codex", isolated: false, status: "done" }),
    repoEnabled: true,
    verdict: { kind: "finished", summary: "x" },
  });
  (h.svc as any).deps.classify = async () => {
    classified = true;
    return { kind: "finished", summary: "x" };
  };
  await h.svc.onDone("s1");
  expect(classified).toBe(false);
  expect(h.events.some((e) => "steer" in e)).toBe(false);
});

test("eligible() drives an ISOLATED codex session normally (positive control)", async () => {
  // Same as above but isolated: the guard does not fire, so onDone classifies + steers.
  const h = harness({
    session: sess({ agentProvider: "codex", isolated: true, status: "done" }),
    repoEnabled: true,
    verdict: { kind: "finished", summary: "done" },
  });
  await h.svc.onDone("s1");
  expect(h.classifyCount()).toBeGreaterThan(0);
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

// ───────────────────────── landingRepair guard ─────────────────────────
// A landingRepair session pushes directly to the epic integration branch and never opens a
// PR. The check runs BEFORE the hasPr early-return (unlike research/normal paths) so a repair
// session that erroneously opened a PR is still marked complete — never left hanging by the
// hasPr short-circuit.

test("landingRepair + finished verdict (no PR) → markComplete, no open-PR steer", async () => {
  const h = harness({
    session: sess({ landingRepair: true, status: "done" }),
    verdict: { kind: "finished", summary: "Repair pushed." },
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events).toContainEqual({ complete: "s1", summary: "Repair pushed." });
  expect(h.state().autopilotComplete).toBe(true);
  expect(h.state().autopilotPaused).toBe(false);
});

test("landingRepair + finished + PR already open → still markComplete (ordering regression guard)", async () => {
  // The load-bearing ordering: the landingRepair branch runs BEFORE hasPr's early-return in
  // dispatch(), so even if a PR slipped out, the repair session is still marked complete, not
  // left hanging. fullAuto:true is needed to get PAST the separate eligible() hasPr gate (which
  // stands non-full-auto sessions down before dispatch runs at all) so this test actually
  // exercises dispatch()'s internal ordering, not eligible()'s.
  const h = harness({
    session: sess({ landingRepair: true, status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    openPr: true,
    fullAuto: true,
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events).toContainEqual({ complete: "s1", summary: "done" });
  expect(h.state().autopilotComplete).toBe(true);
});

test("landingRepair + finished verdict with empty summary → COMPLETE_MESSAGE fallback", async () => {
  const h = harness({
    session: sess({ landingRepair: true, status: "done" }),
    verdict: { kind: "finished", summary: "" },
  });
  await h.svc.onDone("s1");
  const ev = h.events.find((e) => "complete" in e);
  expect(ev.summary).toContain("task complete");
});

// Negative control: guard must not bleed into normal (non-repair) sessions
test("non-landingRepair + finished + PR already open → early-return (no steer, no markComplete)", async () => {
  const h = harness({
    session: sess({ landingRepair: false, status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    openPr: true,
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events.some((e) => "complete" in e)).toBe(false);
  expect(h.state().autopilotComplete).toBe(false);
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
  await flush();
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

// ───────────────────── completion-verification gate (#1009) ─────────────────────
// For drain (auto:true) sessions, a `complete` verdict is only accepted when something
// actually happened — a committed diff vs base OR an associated PR. On empty: re-prompt
// the agent once, then route to needs-human. Attended sessions are exempt.

test("completion gate: diff exists → markComplete (no gate trip)", async () => {
  // auto:true + hasDiff:true + no PR → gate passes, markComplete fires
  const h = harness({
    session: sess({ auto: true, status: "done" }),
    verdict: { kind: "complete", summary: "All done." },
    repoEnabled: true,
    openPr: false,
    hasDiff: true,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ complete: "s1", summary: "All done." });
  expect(h.state().autopilotComplete).toBe(true);
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().completionRepromptCount).toBe(0);
});

test("completion gate: PR exists → markComplete (hasPr short-circuits before hasDiff)", async () => {
  // auto:true + openPr:true + hasDiff:false + fullAuto:true (keeps eligible past PR) →
  // hasPr short-circuit inside dispatch, markComplete fires, hasDiff never called
  const h = harness({
    session: sess({ auto: true, status: "done" }),
    verdict: { kind: "complete", summary: "PR already open." },
    repoEnabled: true,
    openPr: true,
    hasDiff: false,
    fullAuto: true,
  });
  let hasDiffCalled = false;
  (h.svc as any).deps.hasDiff = async () => {
    hasDiffCalled = true;
    return false;
  };
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ complete: "s1", summary: "PR already open." });
  expect(h.state().autopilotComplete).toBe(true);
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().completionRepromptCount).toBe(0);
  expect(hasDiffCalled).toBe(false); // hasPr short-circuits before hasDiff is called
});

test("completion gate: empty first time → steer EMPTY_COMPLETION_STEER, reprompt count 1", async () => {
  // auto:true + openPr:false + hasDiff:false + count:0 → re-prompt, NOT complete, NOT paused
  const h = harness({
    session: sess({ auto: true, status: "done", completionRepromptCount: 0 }),
    verdict: { kind: "complete", summary: "Nothing to do." },
    repoEnabled: true,
    openPr: false,
    hasDiff: false,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ steer: EMPTY_COMPLETION_STEER });
  expect(h.state().completionRepromptCount).toBe(1);
  expect(h.state().autopilotComplete).toBe(false);
  expect(h.state().autopilotPaused).toBe(false);
});

test("completion gate: empty second time → pause with EMPTY_COMPLETION_MESSAGE, no steer", async () => {
  // auto:true + openPr:false + hasDiff:false + count:1 → pause, no steer
  const h = harness({
    session: sess({ auto: true, status: "done", completionRepromptCount: 1 }),
    verdict: { kind: "complete", summary: "Nothing to do." },
    repoEnabled: true,
    openPr: false,
    hasDiff: false,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ pause: "s1", q: EMPTY_COMPLETION_MESSAGE });
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotComplete).toBe(false);
});

test("completion gate: attended session exempt (auto:false, hasDiff:false → still markComplete)", async () => {
  // Non-drain (auto:false): gate is skipped regardless of diff/PR state
  const h = harness({
    session: sess({ auto: false, status: "done" }),
    verdict: { kind: "complete", summary: "Created issue #99." },
    repoEnabled: true,
    openPr: false,
    hasDiff: false,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ complete: "s1", summary: "Created issue #99." });
  expect(h.state().autopilotComplete).toBe(true);
  expect(h.state().completionRepromptCount).toBe(0);
});

test("completion gate: counter resets on onStatus running", () => {
  // Operator re-engages a paused session → completionRepromptCount reset to 0
  const h = harness({
    session: sess({ autopilotPaused: true, completionRepromptCount: 1 }),
  });
  h.svc.onStatus("s1", "running");
  expect(h.state().completionRepromptCount).toBe(0);
});

test("completion gate: counter resets on onPrOpen", () => {
  // Critic handoff → completionRepromptCount reset to 0
  const h = harness({
    session: sess({ completionRepromptCount: 1 }),
  });
  h.svc.onPrOpen("s1");
  expect(h.state().completionRepromptCount).toBe(0);
});

// ───────────── rebase re-engagement (non-full-auto, review-passed, behind) ─────────────
// Gap closed: a non-full-auto autopilot session stands down at PR-open and the merge train
// never carries it, so when its PR falls behind base (or conflicts) after a passing review
// nobody steers a rebase. reEngageRebase steers one — deliberately stricter than the train's
// needsRebase on the review check (requires a clean head-matched critic sign-off), draft PRs
// excluded, bounded by rebaseCap (no per-head dedup, so the cap actually fires on a stuck head).
const REBASE_STEER_MAIN = rebaseSteer("main");

function review(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "sha1",
    patchId: "p1",
    decision: "commented",
    summary: "",
    body: "",
    findings: [],
    addressRound: 0,
    addressCap: 3,
    streakReviews: 0,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 0,
    seenNoteIds: [],
    updatedAt: 0,
    ...over,
  };
}

/** An open + green PR snapshot for the rebase tests (overrides the failure-default git()). */
function greenPr(over: Partial<GitState> = {}): GitState {
  return git({ checks: "success", headSha: "sha1", ...over });
}

const rebased = (h: { mergeStateCalls: any[] }, n: number) =>
  h.mergeStateCalls.some((c) => c.patch.rebaseCount === n);

test("rebase: behind + clean signoff + green → steers rebase + bumps rebaseCount", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    fullAuto: false,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ steer: REBASE_STEER_MAIN });
  expect(rebased(h, 1)).toBe(true);
});

test("rebase: conflict (mergeable=false) → steers", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ mergeable: false }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ steer: REBASE_STEER_MAIN });
});

test("rebase: draft PR behind → no-op (a rebase can't make a draft mergeable; DRAFT masks BEHIND)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ isDraft: true, mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: commented-with-findings verdict → no-op (avoids racing the auto-address loop)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review({ findings: ["fix the thing"] }),
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: critic on + no verdict → no-op (stricter than needsRebase, which rebases with null)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: null,
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: critic on + stale reviewHeadSha → no-op", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ headSha: "sha2", mergeStateStatus: "behind" }),
    review: review({ headSha: "sha1" }), // verdict applies to an old head
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: changes_requested verdict → no-op", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review({ decision: "changes_requested", findings: ["blocking"] }),
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: critic OFF + green + behind → steers (no review requirement)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    criticEnabled: false,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: null,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ steer: REBASE_STEER_MAIN });
});

test("rebase: full-auto session → no-op (the merge train owns it)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    fullAuto: true,
    verdict: { kind: "finished", summary: "" },
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: red CI → no-op (rebase path requires green; red is the CI-fix path's job)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ checks: "failure", mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: at cap → pause(REBASE_CAP_MESSAGE), no steer", async () => {
  const h = harness({
    session: sess({ status: "done", autoMergeRebaseCount: 5 }),
    openPr: true,
    rebaseCap: 5,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ pause: "s1", q: REBASE_CAP_MESSAGE });
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: no per-head dedup → re-steers each idle episode (marches to the cap)", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.onDone("s1"); // count 0 → 1, steer
  await h.svc.onDone("s1"); // count 1 → 2, steer again (same head, no dedup)
  expect(h.events.filter((e) => e.steer === REBASE_STEER_MAIN).length).toBe(2);
  expect(rebased(h, 2)).toBe(true);
});

test("rebase: PR mergeable+current again → resets rebaseCount, no steer", async () => {
  const h = harness({
    session: sess({ status: "done", autoMergeRebaseCount: 3 }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "clean", mergeable: true }),
    review: review(),
  });
  await h.svc.onDone("s1");
  expect(h.mergeStateCalls).toContainEqual({
    id: "s1",
    patch: { rebaseCount: 0, rebaseHead: null, rebaseSteeredAt: null },
  });
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

test("rebase: tick re-engages an idle behind PR", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.tick();
  expect(h.events).toContainEqual({ steer: REBASE_STEER_MAIN });
});

test("rebase: tick skips a running session (don't interrupt active work)", async () => {
  const h = harness({
    session: sess({ status: "running" }),
    openPr: true,
    prGit: greenPr({ mergeStateStatus: "behind" }),
    review: review(),
  });
  await h.svc.tick();
  expect(h.events.some((e) => e.steer === REBASE_STEER_MAIN)).toBe(false);
});

// ── MCP OAuth stand-down (human-only auth prompt) ───────────────────────────────────────
// An awaiting-input block carrying an authUrl is a human-only OAuth flow autopilot cannot
// complete, so it must stand down on every steer path and recover once the operator resumes.
const AUTH_URL_SD = "https://mcp.sentry.dev/oauth/authorize?response_type=code&client_id=x";
const authBlock = (): BlockReason => ({
  shape: "awaiting-input",
  options: [],
  tail: ["Open this URL in your browser"],
  authUrl: AUTH_URL_SD,
});

test("onBlock with an authUrl stands autopilot down — no steer, no classify", async () => {
  const h = harness({ session: sess(), verdict: { kind: "gate", summary: "start?" } });
  await h.svc.onBlock("s1", authBlock());
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.classifyCount()).toBe(0);
});

test("a later non-auth block clears the auth stand-down and steers normally", async () => {
  const h = harness({ session: sess(), verdict: { kind: "gate", summary: "start?" } });
  await h.svc.onBlock("s1", authBlock()); // stand down
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  await h.svc.onBlock("s1", block()); // null authUrl → clears, considers → gate → steer
  expect(h.events).toContainEqual({ steer: PROCEED_STEER });
});

test("onDone stands down on a pending auth URL — before classify, no complete/pause", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    pendingAuthUrl: AUTH_URL_SD,
  });
  await h.svc.onDone("s1");
  expect(h.classifyCount()).toBe(0);
  expect(h.events.some((e) => "steer" in e || "complete" in e || "pause" in e)).toBe(false);
});

test("post-classify re-check blocks a terminal verdict when the auth URL flushes during classify", async () => {
  // The block has no authUrl (onBlock's pre-guard clears any stand-down) so consider() runs
  // classify; the URL is present by the time it resolves (pendingAuthUrl set), so the
  // post-classify re-check must stand down BEFORE dispatch — classify ran but nothing steered.
  const h = harness({
    session: sess(),
    verdict: { kind: "finished", summary: "done" },
    pendingAuthUrl: AUTH_URL_SD,
  });
  await h.svc.onBlock("s1", block());
  expect(h.classifyCount()).toBe(1);
  expect(h.events.some((e) => "steer" in e || "complete" in e)).toBe(false);
});

test("reEngageCi respects the auth stand-down; onStatus(running) clears it", () => {
  const h = harness({
    session: sess({ status: "done" }),
    repoEnabled: true,
    fullAuto: true,
    prGit: git(), // open + failing CI
    pendingAuthUrl: null, // set authPending via the authUrl block below, not the dep
  });
  void h.svc.onBlock("s1", authBlock()); // sets the stand-down (add is synchronous)
  h.svc.tick();
  expect(h.events.some((e) => "steer" in e)).toBe(false); // reEngageCi stood down
  h.svc.onStatus("s1", "running"); // operator resumed → clears the stand-down
  h.svc.tick();
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
});

// ── Defects A/B/D on the autopilot side ─────────────────────────────────────────

/** An open, conflicting PR snapshot. `checks` defaults to "none" — Defect A's shape, where CI
 *  never ran because GitHub couldn't build the merge ref. */
function dirtyGit(over: Partial<GitState> = {}): GitState {
  return {
    state: "open",
    checks: "none",
    noCi: false,
    headSha: "sha1",
    number: 7,
    deployConfigured: false,
    mergeable: false,
    mergeStateStatus: "dirty",
    ...over,
  } as GitState;
}

test("A: an idle non-full-auto session with a conflicting PR + checks:none IS steered", async () => {
  const h = harness({
    session: sess({ status: "idle" }),
    repoEnabled: true,
    criticEnabled: false,
    prGit: dirtyGit(),
  });
  await h.svc.tick();
  await flush();
  expect(h.events.some((e) => typeof e.steer === "string")).toBe(true);
});

test("A: the conflict steer names the conflict and does NOT claim review passed", async () => {
  const h = harness({
    session: sess({ status: "idle" }),
    repoEnabled: true,
    criticEnabled: false,
    prGit: dirtyGit(),
  });
  await h.svc.tick();
  await flush();
  const steer = h.events.find((e) => typeof e.steer === "string")?.steer as string;
  expect(steer).toContain("merge conflicts");
  expect(steer).not.toContain("passed review");
});

test("B: a conflicting DRAFT is steered (the draft skip is waived on conflict)", async () => {
  const h = harness({
    session: sess({ status: "idle" }),
    repoEnabled: true,
    criticEnabled: false,
    prGit: dirtyGit({ isDraft: true, mergeable: null }),
  });
  await h.svc.tick();
  await flush();
  expect(h.events.some((e) => typeof e.steer === "string")).toBe(true);
});

test("D: reEngageRebase does NOT reset-and-bail on dirty + mergeable:null", async () => {
  // Previously `mergeable !== false` read this as conflict-free: counter cleared, no steer,
  // every tick — silently defeating the conflict path.
  const h = harness({
    session: sess({ status: "idle", autoMergeRebaseCount: 2 }),
    repoEnabled: true,
    criticEnabled: false,
    prGit: dirtyGit({ checks: "success", mergeable: null }),
  });
  await h.svc.tick();
  await flush();
  expect(h.mergeStateCalls).not.toContainEqual({
    id: "s1",
    patch: { rebaseCount: 0, rebaseHead: null, rebaseSteeredAt: null },
  });
  expect(h.events.some((e) => typeof e.steer === "string")).toBe(true);
});

// ── red + dirty: ownership stand-down, never orphaned, never mid-work ────────────

test("8(a): a RECENT steer stamp stands the CI-fix loop down (the train owns it)", async () => {
  const h = harness({
    session: sess({ status: "idle", autoMergeRebaseSteeredAt: 0, autoMergeRebaseCount: 1 }),
    repoEnabled: true,
    fullAuto: true,
    now: 1_000,
  });
  h.svc.onGit("s1", dirtyGit({ checks: "failure" }));
  await flush();
  expect(h.events).not.toContainEqual({ steer: CI_FIX_STEER });
});

test("8(d): a STALE stamp releases ownership — CI-fix resumes despite a non-zero count", async () => {
  // The counter is deliberately non-zero: the STAMP gates this, not the count.
  const h = harness({
    session: sess({ status: "idle", autoMergeRebaseSteeredAt: 0, autoMergeRebaseCount: 3 }),
    repoEnabled: true,
    fullAuto: true,
    now: OWNERSHIP_TTL_MS + 1,
  });
  h.svc.onGit("s1", dirtyGit({ checks: "failure" }));
  await flush();
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
});

test("8(f): eligibility decaying after a counted rebase still leaves the session acted on", async () => {
  // changes_requested makes the train decline; once ownership lapses the CI-fix loop must take
  // the session back rather than leaving it claimed by nobody.
  const h = harness({
    session: sess({ status: "idle", autoMergeRebaseSteeredAt: 0, autoMergeRebaseCount: 3 }),
    repoEnabled: true,
    fullAuto: true,
    criticEnabled: true,
    review: { decision: "changes_requested", findings: ["x"], headSha: "sha1" } as any,
    now: OWNERSHIP_TTL_MS + 1,
  });
  h.svc.onGit("s1", dirtyGit({ checks: "failure" }));
  await flush();
  expect(h.events).toContainEqual({ steer: CI_FIX_STEER });
});

test("8(g): a BUSY full-auto session is not CI-fix-steered mid-resolution, stale stamp or not", async () => {
  const h = harness({
    session: sess({ status: "running", autoMergeRebaseSteeredAt: 0, autoMergeRebaseCount: 1 }),
    repoEnabled: true,
    fullAuto: true,
    now: OWNERSHIP_TTL_MS * 10,
  });
  h.svc.onGit("s1", dirtyGit({ checks: "failure" }));
  await flush();
  expect(h.events).not.toContainEqual({ steer: CI_FIX_STEER });
});

test("rebaseSteeredAt is CONFLICT-ONLY: stamped on a conflict steer, absent on a behind-only one", async () => {
  // Both readers — rebaseAvailable (automerge-core) and conflictOwnedByRebaser — check the stamp
  // only under isDefiniteConflict, so writing it on the behind path would be write-only data
  // contradicting the field's contract in store.ts.
  const conflicting = harness({
    session: sess({ status: "idle" }),
    repoEnabled: true,
    criticEnabled: false,
    now: 5_000,
    prGit: dirtyGit({ checks: "success" }),
  });
  await conflicting.svc.tick();
  await flush();
  expect(conflicting.mergeStateCalls).toContainEqual({
    id: "s1",
    patch: { rebaseCount: 1, rebaseSteeredAt: 5_000 },
  });

  const behind = harness({
    session: sess({ status: "idle" }),
    repoEnabled: true,
    criticEnabled: false,
    now: 5_000,
    prGit: {
      state: "open",
      checks: "success",
      noCi: false,
      headSha: "sha1",
      number: 7,
      deployConfigured: false,
      mergeable: true,
      mergeStateStatus: "behind",
    } as GitState,
  });
  await behind.svc.tick();
  await flush();
  expect(behind.mergeStateCalls).toContainEqual({ id: "s1", patch: { rebaseCount: 1 } });
});

test("considerCi also stands down at rebaseCap (mirrors reEngageCi's gate)", async () => {
  // Once the train caps a conflicting session it stops refreshing rebaseSteeredAt, so ownership
  // lapses and the stand-down stops firing. Without a cap check here the event-driven path takes
  // a spurious CI-fix steer on an already-exhausted session.
  const h = harness({
    session: sess({
      status: "idle",
      autoMergeRebaseSteeredAt: 0,
      autoMergeRebaseCount: 5, // at the cap
    }),
    repoEnabled: true,
    fullAuto: true,
    rebaseCap: 5,
    now: OWNERSHIP_TTL_MS * 10, // stamp long stale → ownership lapsed
  });
  h.svc.onGit("s1", dirtyGit({ checks: "failure" }));
  await flush();
  expect(h.events).not.toContainEqual({ steer: CI_FIX_STEER });
  // And it does NOT pause — considerCi is a sync event handler; the pause is reEngageCi's job.
  expect(h.events.some((e) => e.pause === "s1")).toBe(false);
});
