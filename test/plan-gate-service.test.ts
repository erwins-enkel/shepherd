import { expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { PlanGateService } from "../src/plan-gate";
import { CodexRolloutResolver } from "../src/codex-activity";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

const CODEX_FIXTURE = join(import.meta.dir, "fixtures/codex-activity/rollout-role-exec.jsonl");

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

async function withAuth<T>(
  mode: typeof config.authMode,
  helper: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  try {
    return await fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

function harness(over: any = {}) {
  const started: any[] = [];
  const removed: string[] = [];
  const recordedSpawns: any[] = [];
  const completedSpawns: any[] = [];
  const overWithoutStore = { ...over };
  delete overWithoutStore.store;
  const store = {
    getPlanGate: () => null,
    putPlanGate(g: any) {
      (store as any).gate = g;
    },
    dropPlanGate() {},
    snapshotPlanGates: () => ({}),
    getRepoConfig: () => ({ planGateEnabled: true }),
    addSignal() {},
    setPlanPhase() {},
    get: () => ({ id: "s1", auto: false }),
    recordReviewerSpawn: (r: any) => recordedSpawns.push(r),
    completeReviewerSpawn: (id: any, u: any, at: any) => completedSpawns.push({ id, u, at }),
    listReviewerSpawns: () => [],
    ...(over.store ?? {}),
  };
  const deps: any = {
    store,
    herdr: {
      start: async (l: string, cwd: string, argv: string[], env?: Record<string, string>) => {
        started.push({ l, cwd, argv, env });
        return { terminalId: "t1" };
      },
      async stop() {},
      list: () => [],
    },
    worktreeExists: () => true,
    worktree: {
      createDetached: async () => ({ worktreePath: "/wt-detached", branch: "main" }),
      remove: (p: string) => removed.push(p),
      gitCommonDir: () => "/fake-git-common",
    },
    // no bwrap on test hosts: degrade to passthrough so existing argv assertions hold
    detectBackend: () => null,
    reply: async () => true,
    // Default: pane live (Claude idles at its prompt) → resumeThenSteer skips resume and delivers
    // via `reply`, preserving every pre-existing test's behavior. Codex-exit tests override paneAlive.
    paneAlive: () => true,
    resume: async () => ({}),
    deferSteer: () => false,
    async release() {},
    onChange() {},
    onReviewing() {},
    cap: 3,
    now: () => 1000,
    readPlan: () => "PLAN TEXT",
    readVerdict: () => null,
    baseSha: () => ({ sha: "abc", anchored: true, ahead: 0 }),
    anchorStaleness: () => ({ behind: 0, changedSince: [] }),
    // `store` is already merged above (base + over.store); exclude it here so the
    // deps-level spread doesn't re-overwrite it with the un-merged per-test partial.
    ...overWithoutStore,
  };
  return {
    deps,
    started,
    removed,
    recordedSpawns,
    completedSpawns,
    store,
    svc: new PlanGateService(deps),
  };
}

const planningSession = () => ({
  id: "s1",
  desig: "TASK-01",
  repoPath: "/r",
  baseBranch: "main",
  worktreePath: "/wt",
  prompt: "do X",
  planPhase: "planning",
});

test("consider spawns reviewer when a plan exists and is unreviewed", async () => {
  const h = harness();
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("started"); // relayed to the on-demand route as { status: "started" }
  expect(h.started.length).toBe(1);
  expect(h.started[0].argv[h.started[0].argv.length - 1]).toContain("PLAN TEXT");
  expect(h.svc.reviewingIds()).toEqual(["s1"]);
});
test("begin carries the reviewer env on the reviewing:true signal + reviewingInflight()", async () => {
  const reviewingEvents: any[] = [];
  const h = harness({
    env: () => ({ provider: "codex", model: "gpt-5.5", effort: null }),
    onReviewing: (id: string, r: boolean, env?: unknown) => reviewingEvents.push([id, r, env]),
  });
  await h.svc.consider({ ...planningSession(), effort: "high" } as any);
  // The start signal carries CLI + model + the resolved effort (env.effort null → session.effort).
  expect(reviewingEvents).toContainEqual([
    "s1",
    true,
    { provider: "codex", model: "gpt-5.5", effort: "high" },
  ]);
  // The inflight bootstrap snapshot exposes the same env for a mid-review reload.
  expect(h.svc.reviewingInflight()).toEqual([
    { id: "s1", provider: "codex", model: "gpt-5.5", effort: "high" },
  ]);
});

test("consider: env.effort overrides session.effort (issue #1418)", async () => {
  const h = harness({ env: () => ({ provider: "claude", model: null, effort: "high" }) });
  await h.svc.consider({ ...planningSession(), effort: "low" } as any);
  const argv = h.started[0].argv;
  expect(argv).toContain("--effort");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
});

test("consider: falls back to session.effort when env.effort is null/absent (issue #1418)", async () => {
  const h = harness();
  await h.svc.consider({ ...planningSession(), effort: "medium" } as any);
  const argv = h.started[0].argv;
  expect(argv).toContain("--effort");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("medium");
});

test("approved gate records the reviewer provider, model, and resolved effort", async () => {
  const h = harness({
    env: () => ({ provider: "codex", model: "gpt-5.5", effort: null }),
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
  });
  await h.svc.consider({ ...planningSession(), effort: "high" } as any);
  await h.svc.tick();
  expect(h.store.gate).toMatchObject({
    reviewerProvider: "codex",
    reviewerModel: "gpt-5.5",
    reviewerEffort: "high",
  });
  expect(h.recordedSpawns[0].reviewerProvider).toBe("codex");
  expect(h.recordedSpawns[0].model).toBe("gpt-5.5");
  expect(h.recordedSpawns[0].reviewerEffort).toBe("high");
});

test("plan-gate: subscription mode — no apiKeyHelper, no env 4th arg", async () => {
  await withAuth("subscription", "/ignored.sh", async () => {
    const h = harness();
    await h.svc.consider(planningSession() as any);
    const argv = h.started[0].argv;
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]).apiKeyHelper).toBeUndefined();
    expect(h.started[0].env).toBeUndefined();
  });
});

test("plan-gate: api-key mode (passthrough host) — apiKeyHelper + CLAUDE_CONFIG_DIR env", async () => {
  await withAuth("api-key", "/helper.sh", async () => {
    const h = harness();
    await h.svc.consider(planningSession() as any);
    const argv = h.started[0].argv;
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]).apiKeyHelper).toBe("/helper.sh");
    expect(Object.keys(h.started[0].env)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });
});

test("plan-gate: api-key without a configured key fails closed → 'error-auth', no spawn, reaped", async () => {
  await withAuth("api-key", null, async () => {
    const h = harness();
    const status = await h.svc.consider(planningSession() as any);
    expect(status).toBe("error-auth");
    expect(h.started.length).toBe(0);
    expect(h.removed).toEqual(["/wt-detached"]);
  });
});

test("consider reports plan-unavailable when a planning session needs review but the plan is unusable", async () => {
  const h = harness({ readPlan: () => null });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("plan-unavailable");
  expect(h.started.length).toBe(0);
});

test("consider treats empty plan text as plan-unavailable", async () => {
  const h = harness({ readPlan: () => "  \n\t " });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("plan-unavailable");
  expect(h.started.length).toBe(0);
});

test("consider no-ops when session is not in planning phase, before reading an unavailable plan", async () => {
  let reads = 0;
  const h = harness({
    readPlan: () => {
      reads += 1;
      return null;
    },
  });
  const status = await h.svc.consider({ ...planningSession(), planPhase: "executing" } as any);
  expect(status).toBe("skipped");
  expect(reads).toBe(0);
  expect(h.started.length).toBe(0);
});

test("consider no-ops while an existing plan review is in flight, before reading an unavailable plan", async () => {
  let plan = "PLAN TEXT";
  const h = harness({ readPlan: () => plan });
  expect(await h.svc.consider(planningSession() as any)).toBe("started");
  plan = "";
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(1);
});

test("consider no-ops while a plan review is starting, before reading an unavailable plan", async () => {
  let reads = 0;
  const h = harness({
    readPlan: () => {
      reads += 1;
      return null;
    },
  });
  (h.svc as any).starting.add("s1");
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped");
  expect(reads).toBe(0);
  expect(h.started.length).toBe(0);
});

test("consider no-ops when already approved, before reading an unavailable plan", async () => {
  let reads = 0;
  const h = harness({
    readPlan: () => {
      reads += 1;
      return null;
    },
    store: { getPlanGate: () => ({ planHash: "other", approved: true }) },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped");
  expect(reads).toBe(0);
  expect(h.started.length).toBe(0);
});

test("consider dedupes an unchanged plan hash", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: false }) } });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped"); // route reports "skipped" so the UI explains the no-op
  expect(h.started.length).toBe(0);
});
test("consider re-reviews an error verdict even when the plan hash is unchanged", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({
    store: { getPlanGate: () => ({ planHash: hash, approved: false, decision: "error" }) },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("started");
  expect(h.started.length).toBe(1); // an error verdict is retried, not deduped away
});
test("consider persists reviewer ownership before asking Herdr to start it", async () => {
  const events: string[] = [];
  const rows: any[] = [];
  const h = harness({
    store: {
      recordReviewerSpawn: (row: any) => {
        rows.push(row);
        events.push("record");
      },
    },
    herdr: {
      start: async () => {
        events.push("start");
        return { terminalId: "t1" };
      },
      async stop() {},
      list: () => [],
    },
  });

  expect(await h.svc.consider(planningSession() as any)).toBe("started");
  expect(events).toEqual(["record", "start"]);
  expect(rows[0]).toMatchObject({
    taskSessionId: "s1",
    kind: "plan_gate",
    worktreePath: "/wt-detached",
    spawnedAt: 1000,
  });
});
test("consider reports 'error-spawn' (not a dedupe) when the reviewer fails to spawn", async () => {
  const h = harness({
    herdr: {
      start: async () => {
        throw new Error("spawn boom");
      },
      async stop() {},
    },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("error-spawn"); // UI shows a failure note, not "plan unchanged"
  expect(h.started.length).toBe(0);
  expect(h.recordedSpawns.length).toBe(1); // ownership exists before the launch attempt
  expect(h.completedSpawns).toHaveLength(1); // confirmed launch failure closes the row
  expect(h.completedSpawns[0].id).toBe(h.recordedSpawns[0].reviewerSessionId);
  expect(h.completedSpawns[0].u.total).toBe(0);
  expect(h.removed).toEqual(["/wt-detached"]); // the detached worktree is reaped on failure
});

test("consider reports 'error-worktree' when the review worktree can't be created", async () => {
  const h = harness({
    worktree: {
      createDetached: async () => {
        throw new Error("wt boom");
      },
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("error-worktree");
  expect(h.started.length).toBe(0); // never reached the spawn
});
test("consider won't double-spawn while one is in flight", async () => {
  const h = harness();
  await Promise.all([
    h.svc.consider(planningSession() as any),
    h.svc.consider(planningSession() as any),
  ]);
  expect(h.started.length).toBe(1);
});

test("approve → stores approved gate, reaps worktree+terminal, reviewing off; auto session auto-released", async () => {
  const released: string[] = [];
  const reviewingEvents: any[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    onReviewing: (id: string, r: boolean) => reviewingEvents.push([id, r]),
    store: { get: () => ({ id: "s1", auto: true }) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.approved).toBe(true);
  expect(h.store.gate.decision).toBe("approved");
  expect(released).toEqual(["s1"]);
  expect(h.removed).toContain("/wt-detached");
  expect(reviewingEvents).toContainEqual(["s1", false]);
  expect(h.svc.reviewingIds()).toEqual([]);
});
test("approve on an interactive session does NOT auto-release", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: { get: () => ({ id: "s1", auto: false }) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.approved).toBe(true);
  expect(released).toEqual([]);
});
test("approve → autopilot override ON (non-drain) auto-releases", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: true, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual(["s1"]);
});
test("approve → autopilot override OFF does NOT auto-release", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: false, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: true }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual([]);
});
test("approve → autopilot inherited from repo default ON auto-releases", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: null, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: true }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual(["s1"]);
});
// TASK-413: enabling plan-gate for Codex makes this auto-release path reachable for Codex. Codex
// autopilot stands down on a NON-isolated session (resume --last would target a sibling in a shared
// cwd), so such a session is not hands-free — it must wait for the operator's Go, NOT auto-release.
test("approve → codex NON-isolated autopilot does NOT auto-release (stands down like spawn/autopilot)", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({
        id: "s1",
        auto: false,
        autopilotEnabled: true,
        agentProvider: "codex",
        isolated: false,
        repoPath: "/r",
      }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual([]);
});
test("approve → codex ISOLATED autopilot auto-releases (guard is isolation-specific)", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({
        id: "s1",
        auto: false,
        autopilotEnabled: true,
        agentProvider: "codex",
        isolated: true,
        repoPath: "/r",
      }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual(["s1"]);
});
test("approve → autopilot inherited from repo default OFF does NOT auto-release", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: null, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual([]);
});
test("request-changes → steers findings to the live agent, round++, not released, not approved", async () => {
  const steers: string[] = [];
  const h = harness({
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix A", "fix B"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(steers.length).toBe(1);
  expect(steers[0]).toContain("fix A");
  expect(steers[0]).toContain("fix B");
  expect(h.store.gate.decision).toBe("changes_requested");
  expect(h.store.gate.round).toBe(1);
  expect(h.store.gate.approved).toBe(false);
});
test("request-changes at cap → stops steering, emits stall signal", async () => {
  const steers: string[] = [];
  const signals: any[] = [];
  const h = harness({
    cap: 1,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["again"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      getPlanGate: () => ({ planHash: "x", approved: false, round: 1, findings: ["again"] }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(steers.length).toBe(0); // at cap → no steer
  expect(signals.some((s) => s.kind === "stall")).toBe(true);
});
test("request-changes sub-cap but the steer can't land → stall signal, round held", async () => {
  const signals: any[] = [];
  const h = harness({
    cap: 3,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    reply: () => false, // dead / unreachable pane — the steer never reaches the agent
    store: {
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(signals.some((s) => s.kind === "stall")).toBe(true); // escalates instead of going silent
  expect(h.store.gate.round).toBe(0); // round did not advance (nothing delivered)
});

// ── resume-before-steer: findings must reach an EXITED (Codex) planner ─────────
test("codex planner exited (pane dead) → resume THEN steer, findings land, round advances", async () => {
  const resumed: string[] = [];
  const steers: string[] = [];
  let alive = false; // Codex exits after writing the plan → pane is not a live agent
  const h = harness({
    cap: 5,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix A"],
    }),
    paneAlive: () => alive,
    resume: async (id: string) => {
      resumed.push(id);
      alive = true; // revived → now steerable
      return {};
    },
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(resumed).toEqual(["s1"]); // the exited pane was resumed FIRST
  expect(steers.length).toBe(1); // then the findings were steered into the revived agent
  expect(steers[0]).toContain("fix A");
  expect(h.store.gate.round).toBe(1); // delivered → round advanced (the plan can now be revised)
});
test("codex planner exited but resume refused (non-isolated) → no steer, round held, escalates", async () => {
  const steers: string[] = [];
  const signals: any[] = [];
  const h = harness({
    cap: 5,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    paneAlive: () => false, // pane exited
    resume: async () => null, // the wiring refuses a non-isolated Codex resume (sibling-corruption guard)
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: { addSignal: (s: any) => signals.push(s) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(steers.length).toBe(0); // resume refused → never steered into a dead pane
  expect(signals.some((s) => s.kind === "stall")).toBe(true); // escalated to the operator
  expect(h.store.gate.round).toBe(0); // round held
});
test("claude planner live at prompt → steer WITHOUT a needless resume", async () => {
  const resumed: string[] = [];
  const h = harness({
    cap: 5,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    paneAlive: () => true, // Claude idles live at its prompt
    resume: async (id: string) => {
      resumed.push(id);
      return {};
    },
    reply: () => true,
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(resumed).toEqual([]); // live pane → never resumed (byte-identical to pre-change behavior)
  expect(h.store.gate.round).toBe(1);
});
test("resume() reset during an in-flight review is not clobbered by finalize (live round wins)", async () => {
  // Begin a review while the gate is AT the cap (round 5); the reviewer captures priorRound=5.
  let liveGate: any = {
    planHash: "OLD", // differs from hash("PLAN TEXT") so consider() does not dedupe
    decision: "changes_requested",
    approved: false,
    round: 5,
    findings: ["x"],
  };
  const h = harness({
    cap: 5,
    readVerdict: () => ({ decision: "request-changes", summary: "no", body: "B", findings: ["x"] }),
    reply: () => true, // paneAlive default true → delivers directly
    store: { getPlanGate: () => liveGate },
  });
  await h.svc.consider(planningSession() as any); // f.priorRound = 5 captured here
  // Operator resume() mid-review resets the live round to 0.
  liveGate = { ...liveGate, round: 0, finalRoundPending: false, dismissed: false };
  await h.svc.tick(); // finalize
  // With the fix, finalize reads the LIVE round (0) → delivered → 1; the stale priorRound (5, at cap)
  // does not resurrect. Without the fix this would be 5 (held at cap → falsely stalled).
  expect(h.store.gate.round).toBe(1);
});

const lastPrompt = (h: ReturnType<typeof harness>): string => {
  const argv = h.started[0].argv;
  return argv[argv.length - 1];
};
const fakeForge = (getIssue?: any) => ({ getIssue });

test("begin() injects the originating issue body into the reviewer prompt (UNTRUSTED)", async () => {
  const h = harness({
    resolveForge: () => fakeForge(async () => ({ body: "ISSUE_BODY_XYZ" })),
  });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).toContain("ISSUE_BODY_XYZ");
  expect(lastPrompt(h)).toContain("ORIGINATING ISSUE");
});
test("no issue block when issueNumber is null", async () => {
  const h = harness({
    resolveForge: () => fakeForge(async () => ({ body: "ISSUE_BODY_XYZ" })),
  });
  await h.svc.consider({ ...planningSession(), issueNumber: null } as any);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
  expect(lastPrompt(h)).not.toContain("ISSUE_BODY_XYZ");
});
test("degrades cleanly when resolveForge is absent", async () => {
  const h = harness(); // no resolveForge dep
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1); // no throw
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("degrades cleanly when resolveForge returns null", async () => {
  const h = harness({ resolveForge: () => null });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("degrades cleanly when getIssue is absent on the forge", async () => {
  const h = harness({ resolveForge: () => fakeForge(undefined) });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("degrades cleanly when getIssue returns null", async () => {
  const h = harness({ resolveForge: () => fakeForge(async () => null) });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("getIssue throwing never blocks the review (no issue block, still spawns)", async () => {
  const h = harness({
    resolveForge: () =>
      fakeForge(async () => {
        throw new Error("gh boom");
      }),
  });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("forget() during the getIssue await aborts the spawn and reaps the worktree", async () => {
  // Suspend begin() inside the getIssue fetch, fire forget() (session archived) while it's
  // parked, then let the fetch resolve. begin() must re-check `starting`, NOT spawn, and reap
  // the detached worktree it already allocated.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    resolveForge: () =>
      fakeForge(async () => {
        await gate;
        return { body: "ISSUE_BODY_XYZ" };
      }),
  });
  const considering = h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  await Promise.resolve(); // let begin() advance into the parked getIssue await
  h.svc.forget("s1"); // archive mid-fetch → clears the `starting` tombstone
  release();
  await considering;
  expect(h.started.length).toBe(0); // never spawned the reviewer
  expect(h.removed).toEqual(["/wt-detached"]); // the detached worktree was reaped
  expect(h.svc.reviewingIds()).toEqual([]);
});

test("records the plan-gate reviewer spawn on begin()", async () => {
  const h = harness();
  await h.svc.consider(planningSession() as any);
  expect(h.recordedSpawns.length).toBe(1);
  expect(h.recordedSpawns[0]).toMatchObject({
    kind: "plan_gate",
    taskSessionId: "s1",
    worktreePath: "/wt-detached",
  });
  expect(h.recordedSpawns[0].reviewerSessionId).toBeTruthy();
});
test("completes the reviewer spawn's token total on finalize", async () => {
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    messageCount: 1,
    lastActivity: 0,
    byModel: {},
  };
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    readUsage: async () => usage,
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.completedSpawns.length).toBe(1);
  expect(h.completedSpawns[0].u.total).toBe(10);
  expect(h.completedSpawns[0].id).toBe(h.recordedSpawns[0].reviewerSessionId);
});
test("completes the reviewer spawn even with no usage (unresolved Codex rollout) → NULL totals, not 0", async () => {
  // A Codex reviewer whose rollout hasn't resolved yields null from readUsage. The row must still
  // be completed (completedAt set) so it isn't a silent gap — but with NULL token columns
  // (unknown, backfillable), NOT 0, which is reserved for a resolved-but-empty transcript. The row
  // completing with a null usage arg is exactly that contract (issue #1816).
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    readUsage: async () => null,
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.completedSpawns.length).toBe(1);
  expect(h.completedSpawns[0].u).toBeNull(); // NULL totals (unknown), not a zeroed SessionUsage
  expect(h.completedSpawns[0].id).toBe(h.recordedSpawns[0].reviewerSessionId);
});
test("codex reviewer with a resolved rollout books real token totals (not 0/NULL)", async () => {
  // The default readUsage resolves the Codex rollout (by launch-unique cwd = the reviewer worktree)
  // and parses its token_count — the totals that are booked as 0 today. Real resolver over the
  // fixture rollout (total_tokens = 52976).
  const codexResolver = new CodexRolloutResolver({
    listMetas: () => [
      { path: CODEX_FIXTURE, cwd: "/wt-detached", rolloutId: "id-x", source: "exec", mtimeMs: 1 },
    ],
    now: () => 0,
  });
  const h = harness({
    env: () => ({ provider: "codex", model: "gpt-5.6-sol", effort: null }),
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    codexResolver,
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.completedSpawns).toHaveLength(1);
  expect(h.completedSpawns[0].u?.total).toBe(52976);
});
test("timeout with no verdict → error gate, reaped, not released", async () => {
  let t = 1000;
  const h = harness({ readVerdict: () => null, now: () => t });
  await h.svc.consider(planningSession() as any); // startedAt = 1000
  t = 1000 + 11 * 60 * 1000; // exceed default 10m timeout
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("error");
  // The server-authored error summary is stored as a sentinel code (rendered per-locale in the UI),
  // never baked English prose in `summary` (#1628).
  expect(h.store.gate.summaryCode).toBe("no-verdict");
  expect(h.store.gate.summary).toBe("");
  expect(h.removed).toContain("/wt-detached");
});

test("an exited codex reviewer without a verdict fails before the file timeout", async () => {
  let t = 1000;
  const h = harness({
    env: () => ({ provider: "codex", model: "gpt-5.5", effort: null }),
    now: () => t,
    readVerdict: () => null,
    herdr: { start: async () => ({ terminalId: "t1" }), async stop() {}, list: () => [] },
  });
  await h.svc.consider(planningSession() as any);
  t += 5_000;
  await h.svc.tick();

  expect(h.store.gate.decision).toBe("error");
  expect(h.removed).toContain("/wt-detached");
});

test("approved verdict carries no summaryCode (reviewer text is the summary)", async () => {
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "looks good", body: "", findings: [] }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("approved");
  expect(h.store.gate.summaryCode).toBeNull();
  expect(h.store.gate.summary).toBe("looks good");
});

// ── FS membrane wrapping ─────────────────────────────────────────────────────────

test("plan-gate reviewer spawn is wrapped in bwrap when backend is present", async () => {
  const h = harness({
    detectBackend: () => "bwrap",
    membraneEnv: () => ({
      claudeDir: "/fake/.claude",
      home: "/fake/home",
      nodeBinReal: "/fake/bin/node",
    }),
    worktree: {
      createDetached: async () => ({ worktreePath: "/wt-detached", branch: "main" }),
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
  });
  await h.svc.consider(planningSession() as any);
  const argv = h.started[0]!.argv;
  expect(argv[0]).toBe("bwrap");
  // membrane uses isolated:true → worktree + gitCommonDir binds, not whole repo
  expect(argv).toContain("/wt-detached");
  expect(argv).toContain("/fake-git-common");
  // inner argv follows the "--" separator
  const sep = argv.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(argv[sep + 1]).not.toBe("bwrap"); // reviewer argv directly follows
  // plan text reaches the trailing positional inside the wrapper
  expect(argv.at(-1)).toContain("PLAN TEXT");
});

test("plan-gate reviewer spawn degrades to unwrapped when backend is null", async () => {
  const h = harness({ detectBackend: () => null });
  await h.svc.consider(planningSession() as any);
  const argv = h.started[0]!.argv;
  expect(argv[0]).not.toBe("bwrap"); // passthrough — identical to pre-sandbox behavior
});

// ── adoptOrphans: recover plan reviews orphaned by a restart ──────────────────
const orphanSpawn = (over: any = {}) => ({
  reviewerSessionId: "rev-1",
  taskSessionId: "s1",
  kind: "plan_gate",
  worktreePath: "/wt-detached",
  model: null,
  spawnedAt: 1000,
  completedAt: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
  ...over,
});

test("adoptOrphans re-adopts an orphaned review; next tick finalizes it from the on-disk verdict", async () => {
  const replied: string[] = [];
  const h = harness({
    now: () => 1000,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      getPlanGate: () => ({ round: 1, decision: "changes_requested" }),
      listReviewerSpawns: () => [orphanSpawn()],
    },
    readVerdict: () => ({
      decision: "request-changes",
      summary: "fix it",
      body: "B",
      findings: ["do A"],
    }),
    reply: (id: string) => {
      replied.push(id);
      return true;
    },
  });
  await h.svc.adoptOrphans();
  expect(h.svc.reviewingIds()).toEqual(["s1"]); // re-claimed into inflight
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("changes_requested");
  expect(h.store.gate.round).toBe(2); // priorRound (1) advanced once the steer landed
  expect(replied).toEqual(["s1"]); // findings steered back to the planning agent
  expect(h.removed).toContain("/wt-detached"); // reviewer worktree reaped
});

test("adoptOrphans restores durable reviewer environment metadata", async () => {
  const h = harness({
    now: () => 1000,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [
        orphanSpawn({ reviewerProvider: "codex", model: "gpt-5.5", reviewerEffort: "high" }),
      ],
    },
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
  });
  await h.svc.adoptOrphans();
  await h.svc.tick();
  expect(h.store.gate).toMatchObject({
    reviewerProvider: "codex",
    reviewerModel: "gpt-5.5",
    reviewerEffort: "high",
  });
});

test("adoptOrphans reconstructs legacy reviewer environment from durable model and session effort", async () => {
  const h = harness({
    now: () => 1000,
    store: {
      get: () => ({
        id: "s1",
        repoPath: "/r",
        worktreePath: "/wt",
        planPhase: "planning",
        effort: "medium",
      }),
      listReviewerSpawns: () => [
        orphanSpawn({ reviewerProvider: null, model: "opus", reviewerEffort: null }),
      ],
    },
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
  });
  await h.svc.adoptOrphans();
  await h.svc.tick();
  expect(h.store.gate).toMatchObject({
    reviewerProvider: "claude",
    reviewerModel: "opus",
    reviewerEffort: "medium",
  });
});

test("adoptOrphans skips a spawn whose worktree was already reaped (finalized)", async () => {
  const h = harness({
    worktreeExists: () => false,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [orphanSpawn()],
    },
  });
  await h.svc.adoptOrphans();
  expect(h.svc.reviewingIds()).toEqual([]);
});

test("adoptOrphans ignores completed, non-plan_gate, and non-planning spawns", async () => {
  const h = harness({
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "executing" }),
      listReviewerSpawns: () => [
        orphanSpawn({ completedAt: 5 }),
        orphanSpawn({ kind: "review" }),
        orphanSpawn(), // planPhase is "executing" above → skipped
      ],
    },
  });
  await h.svc.adoptOrphans();
  expect(h.svc.reviewingIds()).toEqual([]);
});

test("adopted orphan with no verdict, past timeout → error gate + stall (fail-closed)", async () => {
  const signals: any[] = [];
  let t = 1000;
  const h = harness({
    now: () => t,
    readVerdict: () => null,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [orphanSpawn()], // spawnedAt = 1000
      addSignal: (s: any) => signals.push(s),
    },
  });
  await h.svc.adoptOrphans();
  t = 1000 + 11 * 60 * 1000; // exceed the 10m timeout measured from spawnedAt
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("error");
  expect(signals.some((s) => s.kind === "stall")).toBe(true);
  expect(h.removed).toContain("/wt-detached");
});

// ── #631: per-run unique worktree path + GC of stale review worktrees ──────────

test("two reviews of the SAME session at the SAME sha get DISTINCT per-run slugs", async () => {
  // Capture the slug (4th arg) createDetached receives across two begin() runs for one session
  // at one base sha. They must differ AND each equal that run's reviewerSessionId — proving the
  // path is keyed on the per-RUN reviewer id, not the (identical) session id.
  const slugs: (string | undefined)[] = [];
  let plan = "PLAN A";
  const h = harness({
    readPlan: () => plan,
    worktree: {
      createDetached: async (_r: string, _b: string, _s: string, slug?: string) => {
        slugs.push(slug);
        return { worktreePath: `/wt-${slug}`, branch: "main" };
      },
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
  });
  const s1 = await h.svc.consider(planningSession() as any);
  expect(s1).toBe("started");
  // Free the first run's inflight slot, then change the plan text to defeat the unchanged-plan
  // dedupe so the second consider() drives a fresh begin() (same session, same base sha).
  h.svc.forget("s1");
  plan = "PLAN B";
  const s2 = await h.svc.consider(planningSession() as any);
  expect(s2).toBe("started");

  expect(slugs.length).toBe(2);
  expect(slugs[0]).not.toBe(slugs[1]); // distinct per run
  expect(slugs[0]).toBe(h.recordedSpawns[0].reviewerSessionId);
  expect(slugs[1]).toBe(h.recordedSpawns[1].reviewerSessionId);
});

test("forget() during the createDetached await aborts the spawn and reaps the worktree", async () => {
  // Park inside createDetached itself (the slow git fetch + worktree add window), fire forget()
  // while suspended, then resolve. begin()'s post-createDetached re-check must abort: never spawn,
  // and reap the worktree it allocated. Proves the createDetached window is covered by the re-check.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reaped: string[] = [];
  const h = harness({
    worktree: {
      createDetached: async (_r: string, _b: string, _s: string, slug?: string) => {
        await gate;
        return { worktreePath: `/wt-${slug}`, branch: "main" };
      },
      remove: (p: string) => reaped.push(p),
      gitCommonDir: () => "/fake-git-common",
    },
  });
  const considering = h.svc.consider(planningSession() as any);
  await Promise.resolve(); // let begin() advance into the parked createDetached await
  h.svc.forget("s1"); // archive mid-fetch → clears the `starting` tombstone
  release();
  await considering;
  expect(h.started.length).toBe(0); // never spawned the reviewer
  expect(reaped.length).toBe(1); // the detached worktree was reaped
  expect(reaped[0]).toContain("/wt-"); // the per-run path
  expect(h.svc.reviewingIds()).toEqual([]);
});

test("adoptOrphans adopts the NEWEST same-session orphan; GC reaps the older", async () => {
  const older = orphanSpawn({
    reviewerSessionId: "rev-old",
    worktreePath: "/wt-old",
    spawnedAt: 1000,
  });
  const newer = orphanSpawn({
    reviewerSessionId: "rev-new",
    worktreePath: "/wt-new",
    spawnedAt: 2000,
  });
  const h = harness({
    worktreeExists: () => true,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [older, newer], // ASC by spawnedAt
    },
  });
  await h.svc.adoptOrphans();
  // The newer (more recent verdict) is the one adopted into inflight.
  expect(h.svc.reviewingIds()).toEqual(["s1"]);
  expect(h.recordedSpawns).toEqual([]); // adoption doesn't re-record

  h.svc.gcStaleReviewWorktrees();
  expect(h.removed).toEqual(["/wt-old"]); // older reaped
  expect(h.removed).not.toContain("/wt-new"); // adopted (inflight) path preserved
});

test("gcStaleReviewWorktrees reaps only non-inflight plan_gate worktrees", async () => {
  const stale = orphanSpawn({ worktreePath: "/wt-stale" }); // plan_gate, not inflight → REMOVE
  const review = orphanSpawn({ kind: "review", worktreePath: "/wt-review" }); // NOT plan_gate → keep
  const h = harness({
    worktreeExists: () => true,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [stale, review],
    },
  });
  // No adoptOrphans() call → nothing inflight → the plan_gate orphan is ownerless.
  h.svc.gcStaleReviewWorktrees();
  expect(h.removed).toEqual(["/wt-stale"]);
  expect(h.removed).not.toContain("/wt-review");
});

// ── reapReviewer (gate-durability split, issue #809) ─────────────────────────

test("reapReviewer reaps terminal+worktree+inflight but does NOT drop the persisted gate", async () => {
  // Prove the split: reapReviewer does everything forget() does EXCEPT dropPlanGate.
  // After consider() sets up an inflight reviewer, reapReviewer() must:
  //   - reap the terminal and worktree
  //   - remove the inflight entry (reviewingIds becomes empty)
  //   - clear the starting tombstone
  //   - NOT call store.dropPlanGate
  // While forget() DOES call dropPlanGate.
  const dropped: string[] = [];
  const stopped: string[] = [];
  const h = harness({
    store: {
      dropPlanGate(id: string) {
        dropped.push(id);
      },
    },
    herdr: {
      start: async () => ({ terminalId: "t-rev" }),
      stop: async (id: string) => stopped.push(id),
      list: () => [],
    },
  });
  // Spin up an inflight reviewer.
  await h.svc.consider(planningSession() as any);
  expect(h.svc.reviewingIds()).toEqual(["s1"]);

  // reapReviewer: terminal reaped, worktree reaped, inflight cleared — gate row untouched.
  h.svc.reapReviewer("s1");
  expect(stopped).toContain("t-rev"); // terminal was stopped
  expect(h.removed).toContain("/wt-detached"); // worktree was reaped
  expect(h.svc.reviewingIds()).toEqual([]); // inflight entry cleared
  expect(dropped).toHaveLength(0); // gate row NOT dropped

  // forget(): builds on reapReviewer AND drops the gate row.
  // Set up fresh inflight for the forget() assertion.
  await h.svc.consider(planningSession() as any);
  h.svc.forget("s1");
  expect(dropped).toEqual(["s1"]); // gate row now dropped exactly once
});

test("gcStaleReviewWorktrees leaves an inflight plan_gate worktree alone", async () => {
  const adopted = orphanSpawn({ worktreePath: "/wt-detached" });
  const h = harness({
    worktreeExists: () => true,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [adopted],
    },
  });
  await h.svc.adoptOrphans(); // adopts it into inflight (path /wt-detached)
  h.svc.gcStaleReviewWorktrees();
  expect(h.removed).not.toContain("/wt-detached"); // inflight → preserved
});

test("adoptOrphans resolves the reviewer terminal by worktree cwd for reaping", async () => {
  const stopped: string[] = [];
  const h = harness({
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      listReviewerSpawns: () => [orphanSpawn()],
    },
    herdr: {
      start: async () => ({ terminalId: "t1" }),
      stop: async (id: string) => stopped.push(id),
      list: () => [{ cwd: "/wt-detached", terminalId: "rev-term-9" }],
    },
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
  });
  await h.svc.adoptOrphans();
  await h.svc.tick();
  expect(stopped).toContain("rev-term-9"); // reaped the resolved live reviewer terminal
});

test("inflightWorktrees: empty before any review starts", () => {
  const h = harness();
  expect(h.svc.inflightWorktrees()).toEqual([]);
});

test("inflightWorktrees: returns worktree path after consider() spawns a review", async () => {
  const h = harness();
  await h.svc.consider(planningSession() as any);
  expect(h.svc.inflightWorktrees()).toEqual(["/wt-detached"]);
});

// ── resume (operator "resume" for plan stalled at adversarial-review cap) ────

test("resume happy path: resets round to 0, fires onChange, re-steers findings, returns true", async () => {
  const cap = 3;
  const findings = ["address concern X", "clarify scope Y"];
  const gate: any = {
    sessionId: "s1",
    planHash: "h1",
    decision: "changes_requested",
    summary: "needs work",
    body: "## plan issues",
    findings,
    round: cap, // at cap — stalled
    cap,
    approved: false,
    plan: "do stuff",
    updatedAt: 1000,
  };
  const putCalls: any[] = [];
  const onChangeCalls: any[] = [];
  const replyCalls: string[] = [];
  const h = harness({
    store: { getPlanGate: () => gate, putPlanGate: (g: any) => putCalls.push(g) },
    onChange: (id: string, g: any) => onChangeCalls.push({ id, g }),
    reply: async (id: string, text: string) => {
      replyCalls.push(text);
      return true;
    },
  });
  const result = await h.svc.resume(planningSession() as any);
  // round reset to 0
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0].round).toBe(0);
  // other gate fields preserved
  expect(putCalls[0].findings).toEqual(findings);
  expect(putCalls[0].decision).toBe("changes_requested");
  // onChange fired with the reset gate
  expect(onChangeCalls).toHaveLength(1);
  expect(onChangeCalls[0].id).toBe("s1");
  expect(onChangeCalls[0].g.round).toBe(0);
  // reply called with the steer text containing the findings
  expect(replyCalls).toHaveLength(1);
  expect(replyCalls[0]).toContain("address concern X");
  expect(replyCalls[0]).toContain("clarify scope Y");
  // returns the reply boolean
  expect(result).toBe(true);
});

test("resume: reply returns false → resume returns false", async () => {
  const gate: any = {
    sessionId: "s1",
    planHash: "h1",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["fix X"],
    round: 3,
    cap: 3,
    approved: false,
    plan: "",
    updatedAt: 1000,
  };
  const h = harness({
    store: { getPlanGate: () => gate, putPlanGate: () => {} },
    reply: async () => false,
  });
  expect(await h.svc.resume(planningSession() as any)).toBe(false);
});

test("resume no-op: no gate → returns false, no putPlanGate/reply", async () => {
  const putCalls: any[] = [];
  const replyCalls: any[] = [];
  const h = harness({
    store: { getPlanGate: () => null, putPlanGate: (g: any) => putCalls.push(g) },
    reply: async (id: string, text: string) => {
      replyCalls.push(text);
      return true;
    },
  });
  const result = await h.svc.resume(planningSession() as any);
  expect(result).toBe(false);
  expect(putCalls).toHaveLength(0);
  expect(replyCalls).toHaveLength(0);
});

test("resume no-op: gate decision is 'approved' → returns false, no putPlanGate/reply", async () => {
  const gate: any = {
    sessionId: "s1",
    planHash: "h1",
    decision: "approved",
    summary: "",
    body: "",
    findings: [],
    round: 2,
    cap: 3,
    approved: true,
    plan: "",
    updatedAt: 1000,
  };
  const putCalls: any[] = [];
  const replyCalls: any[] = [];
  const h = harness({
    store: { getPlanGate: () => gate, putPlanGate: (g: any) => putCalls.push(g) },
    reply: async (id: string, text: string) => {
      replyCalls.push(text);
      return true;
    },
  });
  const result = await h.svc.resume(planningSession() as any);
  expect(result).toBe(false);
  expect(putCalls).toHaveLength(0);
  expect(replyCalls).toHaveLength(0);
});

test("resume no-op: gate decision is 'error' → returns false", async () => {
  const gate: any = {
    sessionId: "s1",
    planHash: "h1",
    decision: "error",
    summary: "",
    body: "",
    findings: [],
    round: 1,
    cap: 3,
    approved: false,
    plan: "",
    updatedAt: 1000,
  };
  const h = harness({ store: { getPlanGate: () => gate, putPlanGate: () => {} } });
  expect(await h.svc.resume(planningSession() as any)).toBe(false);
});

// ── finalRoundPending + dismissed (rework-stall classification) ────────────────

test("request-changes: final delivered round (round==cap) sets finalRoundPending", async () => {
  const h = harness({
    cap: 3,
    readVerdict: () => ({ decision: "request-changes", summary: "no", body: "B", findings: ["f"] }),
    reply: () => true,
    store: {
      getPlanGate: () => ({ planHash: "x", approved: false, round: 2, findings: ["f"] }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.round).toBe(3); // cap reached via the final delivered steer
  expect(h.store.gate.finalRoundPending).toBe(true);
});

test("request-changes: sub-cap round leaves finalRoundPending false", async () => {
  const h = harness({
    cap: 3,
    readVerdict: () => ({ decision: "request-changes", summary: "no", body: "B", findings: ["f"] }),
    reply: () => true,
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.round).toBe(1);
  expect(h.store.gate.finalRoundPending).toBeFalsy();
});

test("request-changes at cap (no steer) leaves finalRoundPending false → planStallStatus stalled", async () => {
  const h = harness({
    cap: 1,
    readVerdict: () => ({ decision: "request-changes", summary: "no", body: "B", findings: ["f"] }),
    reply: () => true,
    store: {
      getPlanGate: () => ({ planHash: "x", approved: false, round: 1, findings: ["f"] }),
      addSignal() {},
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.finalRoundPending).toBeFalsy();
});

test("dismiss: marks dismissed=true, clears finalRoundPending, keeps changes_requested", () => {
  const gate: any = {
    sessionId: "s1",
    planHash: "h1",
    decision: "changes_requested",
    summary: "x",
    body: "b",
    findings: ["f"],
    round: 3,
    cap: 3,
    approved: false,
    plan: "p",
    finalRoundPending: true,
    updatedAt: 1000,
  };
  const putCalls: any[] = [];
  const h = harness({
    store: { getPlanGate: () => gate, putPlanGate: (g: any) => putCalls.push(g) },
  });
  h.svc.dismiss(planningSession() as any);
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0].dismissed).toBe(true);
  expect(putCalls[0].finalRoundPending).toBe(false);
  expect(putCalls[0].decision).toBe("changes_requested");
  expect(putCalls[0].round).toBe(0);
});

test("resume: clears a prior dismissed flag", async () => {
  const gate: any = {
    sessionId: "s1",
    planHash: "h1",
    decision: "changes_requested",
    summary: "x",
    body: "b",
    findings: ["f"],
    round: 3,
    cap: 3,
    approved: false,
    plan: "p",
    dismissed: true,
    updatedAt: 1000,
  };
  const putCalls: any[] = [];
  const h = harness({
    store: { getPlanGate: () => gate, putPlanGate: (g: any) => putCalls.push(g) },
    reply: async () => true,
  });
  await h.svc.resume(planningSession() as any);
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0].dismissed).toBe(false);
});

// ── readPlanBlocks: blocks captured into the gate ──────────────────────────────

const questionBlock = () => ({
  type: "question-form" as const,
  id: "q1",
  questions: [
    { id: "q1a", prompt: "Which approach?", kind: "single" as const, options: ["A", "B"] },
  ],
});

const dataModelBlock = () => ({
  type: "data-model" as const,
  id: "dm1",
  entities: [{ id: "e1", name: "Task", fields: [{ name: "id", type: "string", pk: true }] }],
});

test("blocks captured into the gate: approve verdict carries the injected blocks", async () => {
  const blocks = [questionBlock(), dataModelBlock()];
  const h = harness({
    readPlanBlocks: () => blocks,
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    store: { get: () => ({ id: "s1", auto: true }) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.blocks).toHaveLength(2);
  expect(h.store.gate.blocks[0].type).toBe("question-form");
  expect(h.store.gate.blocks[1].type).toBe("data-model");
});

test("no sidecar → blockless gate (blocks is [])", async () => {
  const h = harness({
    readPlanBlocks: () => [],
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    store: { get: () => ({ id: "s1", auto: false }) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(Array.isArray(h.store.gate.blocks)).toBe(true);
  expect(h.store.gate.blocks).toHaveLength(0);
});

test("changes_requested verdict also carries blocks from readPlanBlocks", async () => {
  const blocks = [questionBlock()];
  const h = harness({
    readPlanBlocks: () => blocks,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "needs work",
      body: "B",
      findings: ["fix X"],
    }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.blocks).toHaveLength(1);
  expect(h.store.gate.blocks[0].type).toBe("question-form");
});

test("onActivity surfaces the running plan reviewer's latest tool-use while no verdict yet", async () => {
  const acts: { id: string; summary: string }[] = [];
  const h = harness({
    readVerdict: () => null, // still running — no verdict file yet
    readActivity: () => "read .shepherd-plan.md",
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(acts).toEqual([{ id: "s1", summary: "read .shepherd-plan.md" }]);
});

test("codex reviewer: onActivity surfaces the rollout's summary via the resolver", async () => {
  // The reviewer runs on codex, which writes no ~/.claude/projects JSONL. The default
  // readActivity must resolve its rollout (by launch-unique cwd = the reviewer worktree)
  // and read the same activity signal from there — else the banner shows "Starting review…"
  // forever. Uses the REAL resolver over a fake listMetas pointing at the fixture rollout.
  const acts: { id: string; summary: string }[] = [];
  const codexResolver = new CodexRolloutResolver({
    listMetas: () => [
      { path: CODEX_FIXTURE, cwd: "/wt-detached", rolloutId: "id-x", source: "exec", mtimeMs: 1 },
    ],
    now: () => 0,
  });
  const h = harness({
    env: () => ({ provider: "codex", model: "gpt-5.6-sol", effort: null }),
    readVerdict: () => null, // still running — no verdict file yet
    codexResolver,
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  // the fixture's newest tool-use is an apply_patch call → its summary, not "exec"
  expect(acts).toEqual([{ id: "s1", summary: "apply_patch" }]);
});

test("onActivity stays silent when the plan reviewer has no parseable activity yet", async () => {
  const acts: unknown[] = [];
  const h = harness({
    readVerdict: () => null,
    readActivity: () => null, // transcript missing / nothing parseable
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(acts).toEqual([]);
});

test("onActivity does not fire on the tick that finalizes the verdict", async () => {
  const acts: unknown[] = [];
  const h = harness({
    // verdict present → this tick finalizes rather than reporting activity
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    readActivity: () => "read .shepherd-plan.md",
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(acts).toEqual([]);
});

// ── force: the manual re-review seam (#don-offer-re-review) ────────────────────

test("force bypasses the unchanged-plan hash dedupe → a reviewer spawns", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: false }) } });
  const status = await h.svc.consider(planningSession() as any, { force: true });
  expect(status).toBe("started"); // no silent dedupe — the click re-reviews the same text
  expect(h.started.length).toBe(1);
});

test("unforced consider still dedupes an unchanged plan (regression: force defaults false)", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: false }) } });
  expect(await h.svc.consider(planningSession() as any)).toBe("skipped");
  expect(await h.svc.consider(planningSession() as any, { force: false })).toBe("skipped");
  expect(h.started.length).toBe(0); // the auto-path is bit-identical to today
});

test("force does NOT bypass an approved gate → skipped, no spawn", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: true }) } });
  const status = await h.svc.consider(planningSession() as any, { force: true });
  expect(status).toBe("skipped"); // approved is a hard precondition force does not lift
  expect(h.started.length).toBe(0);
});

test("force does NOT bypass a non-planning phase", async () => {
  const h = harness();
  const status = await h.svc.consider({ ...planningSession(), planPhase: "executing" } as any, {
    force: true,
  });
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(0);
});

test("force does NOT bypass a starting review", async () => {
  const h = harness();
  (h.svc as any).starting.add("s1");
  const status = await h.svc.consider(planningSession() as any, { force: true });
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(0);
});

test("force does NOT bypass an in-flight review", async () => {
  const h = harness();
  expect(await h.svc.consider(planningSession() as any)).toBe("started");
  const status = await h.svc.consider(planningSession() as any, { force: true });
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(1);
});

test("force does NOT bypass an empty/unusable plan", async () => {
  const h = harness({ readPlan: () => "  \n\t " });
  const status = await h.svc.consider(planningSession() as any, { force: true });
  expect(status).toBe("plan-unavailable");
  expect(h.started.length).toBe(0);
});

// ── force + answeredQuestionKeys carry-forward (#1332) ─────────────────────────

test("forced re-review of an unchanged plan preserves answeredQuestionKeys merged mid-review", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  // The live gate starts with no answers; the answer route merges keys into it AFTER begin() and
  // BEFORE finalize(). buildGate reads the LIVE gate (not a begin()-time snapshot), so the merge
  // must survive. `live` is mutable so we can simulate that mid-review merge.
  let live: any = { planHash: hash, approved: false, answeredQuestionKeys: [] };
  const h = harness({
    store: {
      getPlanGate: () => live,
      get: () => ({ id: "s1", auto: false }),
    },
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
  });
  expect(await h.svc.consider(planningSession() as any, { force: true })).toBe("started");
  live = { planHash: hash, approved: false, answeredQuestionKeys: ["q1 q1a"] }; // merged mid-review
  await h.svc.tick();
  expect(h.store.gate.answeredQuestionKeys).toEqual(["q1 q1a"]); // survived the re-review
});

test("a review of a CHANGED plan resets answeredQuestionKeys", async () => {
  const oldHash = await PlanGateService.hashPlan("OLD PLAN");
  const h = harness({
    readPlan: () => "NEW PLAN", // different text ⇒ different hash ⇒ not deduped
    store: {
      getPlanGate: () => ({
        planHash: oldHash,
        approved: false,
        answeredQuestionKeys: ["q1 q1a"],
      }),
      get: () => ({ id: "s1", auto: false }),
    },
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.answeredQuestionKeys).toEqual([]); // new question set ⇒ reset
});

// ── #1759: a sub-cap forced re-review DELIVERS and spends a rework round ───────
// It used to hold the round and steer nothing on an unchanged plan (the old "F3" hold). That froze
// `round` below the cap — which advances only on a DELIVERED steer — so the at-cap Resume CTA could
// never be reached and RE-REVIEW was guaranteed inert: the session had no exit.

test("#1759: sub-cap forced re-review of an unchanged plan steers the fresh findings and advances the round", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const steers: string[] = [];
  const signals: any[] = [];
  const h = harness({
    cap: 3,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix A"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      getPlanGate: () => ({
        planHash: hash,
        approved: false,
        round: 1,
        finalRoundPending: false,
        findings: ["fix A"],
      }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  expect(await h.svc.consider(planningSession() as any, { force: true })).toBe("started");
  await h.svc.tick();
  expect(steers.length).toBe(1); // the operator's click means "send these to the agent"
  expect(steers[0]).toContain("fix A"); // the fresh verdict's findings
  expect(h.store.gate.round).toBe(2); // priorRound(1) advanced — the click bought a real round
  expect(h.store.gate.finalRoundPending).toBe(false); // sub-cap
  expect(signals.length).toBe(0); // sub-cap delivered steer → no stall row
  expect(h.store.gate.decision).toBe("changes_requested");
});

test("#1759: sub-cap forced review of a CHANGED plan advances the round and steers", async () => {
  const oldHash = await PlanGateService.hashPlan("OLD PLAN");
  const steers: string[] = [];
  const h = harness({
    cap: 3,
    readPlan: () => "NEW PLAN",
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix A"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      getPlanGate: () => ({ planHash: oldHash, approved: false, round: 1, findings: ["fix A"] }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  expect(await h.svc.consider(planningSession() as any, { force: true })).toBe("started");
  await h.svc.tick();
  expect(steers.length).toBe(1); // a real revision steers
  expect(h.store.gate.round).toBe(2); // priorRound(1) advanced
});

test("#1759: forced re-review of an unchanged plan at cap-1 crosses the cap → the Resume CTA's gate shape", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const steers: string[] = [];
  const h = harness({
    cap: 3,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix A"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      getPlanGate: () => ({ planHash: hash, approved: false, round: 2, findings: ["fix A"] }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any, { force: true });
  await h.svc.tick();
  expect(steers.length).toBe(1);
  // The escape the issue says doesn't exist: repeated forced clicks now REACH the cap, and this is
  // the exact gate shape canShowPlanStallActions(), hold-row's `atCap` (R7 → quota → Resume) and
  // quotaBlockReason()'s plan arm each key off. Asserted here on the row; the three consumers are
  // unchanged and separately tested.
  expect(h.store.gate.decision).toBe("changes_requested");
  expect(h.store.gate.round).toBeGreaterThanOrEqual(h.store.gate.cap);
});

// ── force: stall-signal guards (learnings-corpus protection) ──────────────────

test("forced at-cap re-entry of an unchanged plan writes no stall row (guard #1)", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const steers: string[] = [];
  const signals: any[] = [];
  const h = harness({
    cap: 1,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["again"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      getPlanGate: () => ({ planHash: hash, approved: false, round: 1, findings: ["again"] }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any, { force: true });
  await h.svc.tick();
  expect(signals.length).toBe(0); // repeat-clickable at the cap must not spam the distiller
  expect(steers.length).toBe(0); // the at-cap hold: no steer once the budget is spent
  expect(h.store.gate.round).toBe(1);
});

test("#1759: consider() reports started-at-cap when the rework budget is already spent", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({
    cap: 2,
    store: {
      getPlanGate: () => ({
        planHash: hash,
        approved: false,
        decision: "changes_requested",
        round: 2,
        findings: ["again"],
      }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  // A REAL run (it can still approve), but its findings won't be re-steered — the trigger says so
  // instead of returning a bare "started" the UI can't tell from a round that landed.
  expect(await h.svc.consider(planningSession() as any, { force: true })).toBe("started-at-cap");
});

test("#1759: consider() reports started-at-cap for an ERROR gate at the cap (the hold ignores decision)", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({
    cap: 2,
    store: {
      // An `error` verdict CARRIES its round (buildGate) and stays re-reviewable (consider() never
      // dedups an error). If this re-review comes back `request-changes`, applyChangesRequested's
      // at-cap hold — which keys on `round >= cap` ALONE — suppresses the steer. The trigger must say
      // so, or an inert run reads as a landed round again.
      getPlanGate: () => ({
        planHash: hash,
        approved: false,
        decision: "error",
        round: 2,
        findings: [],
      }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  expect(await h.svc.consider(planningSession() as any)).toBe("started-at-cap");
});

test("#1759: consider() reports plain started while the rework budget remains", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({
    cap: 3,
    store: {
      getPlanGate: () => ({
        planHash: hash,
        approved: false,
        decision: "changes_requested",
        round: 1,
        findings: ["again"],
      }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  expect(await h.svc.consider(planningSession() as any, { force: true })).toBe("started");
});

test("#1759: forced at-cap re-review CLEARS a pending final round (planStallStatus final → stalled)", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const steers: string[] = [];
  const h = harness({
    cap: 2,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["again"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      // The cap-th steer landed and the agent is (nominally) revising: finalRoundPending is TRUE.
      getPlanGate: () => ({
        planHash: hash,
        approved: false,
        round: 2,
        finalRoundPending: true,
        findings: ["again"],
      }),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any, { force: true });
  await h.svc.tick();
  expect(steers.length).toBe(0); // at-cap hold — still no steer
  expect(h.store.gate.round).toBe(2); // round still held
  // The flag is RECOMPUTED, never carried: it means "the cap-th steer just landed", and no steer
  // landed on THIS verdict. So a forced at-cap re-review clears it, flipping planStallStatus from
  // "final" to "stalled" — the recovery menu surfaces at once instead of after
  // PLAN_FINAL_ROUND_TIMEOUT_MS. Uniform with every other at-cap re-review; pinned here so the
  // behaviour is enforced, not inherited from a seed that never set the flag.
  expect(h.store.gate.finalRoundPending).toBe(false);
});

test("forced CHANGED-plan crossing the cap writes exactly one stall row", async () => {
  const oldHash = await PlanGateService.hashPlan("OLD PLAN");
  const signals: any[] = [];
  const h = harness({
    cap: 3,
    readPlan: () => "NEW PLAN",
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    reply: () => true,
    store: {
      getPlanGate: () => ({ planHash: oldHash, approved: false, round: 2, findings: ["fix"] }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any, { force: true });
  await h.svc.tick();
  expect(signals.filter((s) => s.kind === "stall").length).toBe(1); // crossing signals once
  expect(h.store.gate.round).toBe(3); // priorRound(2) crossed the cap
});

test("forced CHANGED-plan re-entry already at the cap suppresses the stall row (guard #1)", async () => {
  const oldHash = await PlanGateService.hashPlan("OLD PLAN");
  const signals: any[] = [];
  const h = harness({
    cap: 2,
    readPlan: () => "NEW PLAN",
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    reply: () => true,
    store: {
      getPlanGate: () => ({ planHash: oldHash, approved: false, round: 3, findings: ["fix"] }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any, { force: true });
  await h.svc.tick();
  expect(signals.length).toBe(0); // forced re-entry already at the cap → suppressed
});

test("forced sub-cap review whose steer doesn't land writes no stall row but records the verdict", async () => {
  const oldHash = await PlanGateService.hashPlan("OLD PLAN");
  const signals: any[] = [];
  const h = harness({
    cap: 3,
    readPlan: () => "NEW PLAN",
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    reply: () => false, // dead / unreachable pane
    store: {
      getPlanGate: () => ({ planHash: oldHash, approved: false, round: 0, findings: ["fix"] }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any, { force: true });
  await h.svc.tick();
  expect(signals.length).toBe(0); // guard #2 suppresses the learnings row on a forced run
  expect(h.store.gate.decision).toBe("changes_requested"); // operator not stranded — verdict recorded
  expect(h.store.gate.round).toBe(0); // nothing delivered → no advance
});

// ── adoptOrphans: reap (not re-adopt) an approved orphan (invariant maintainer #2) ──

test("adoptOrphans reaps an approved orphan: stops terminal, completes spawn, removes worktree, no inflight", async () => {
  const stopped: string[] = [];
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    messageCount: 1,
    lastActivity: 0,
    byModel: {},
  };
  const h = harness({
    worktreeExists: () => true,
    store: {
      get: () => ({ id: "s1", repoPath: "/r", worktreePath: "/wt", planPhase: "planning" }),
      getPlanGate: () => ({ planHash: "h", approved: true }),
      listReviewerSpawns: () => [orphanSpawn()],
    },
    herdr: {
      start: async () => ({ terminalId: "t1" }),
      stop: async (id: string) => stopped.push(id),
      list: () => [{ cwd: "/wt-detached", terminalId: "rev-term-approved" }],
    },
    readUsage: async () => usage,
  });
  await h.svc.adoptOrphans();
  expect(h.svc.reviewingIds()).toEqual([]); // NOT re-adopted — approved ⇒ no reviewer in flight
  expect(stopped).toContain("rev-term-approved"); // reviewer terminal stopped
  expect(h.completedSpawns.length).toBe(1); // #502 spawn row completed (no NULL-totals leak)
  expect(h.completedSpawns[0].u.total).toBe(10);
  expect(h.removed).toContain("/wt-detached"); // disposable worktree removed
});

// ─── resolveFindings un-clamped steer-back guard (Task 6, issue #1586) ───────────────────────
// resolveSummary clamps the gate's HUD `summary` field to 100 chars; the empty-findings
// fallback used to steer that SAME clamped (possibly mid-word-truncated) value back into the
// coding agent. buildGate now feeds resolveFindings the un-clamped verdict summary instead —
// language-independent, fixes en and de alike.

test("code guard: request-changes + empty findings steers back the FULL un-clamped summary, while the gate's HUD summary stays clamped to 100", async () => {
  const longSummary = "S".repeat(180); // >100 chars — would previously arrive truncated
  const h = harness({
    readVerdict: () => ({
      decision: "request-changes",
      summary: longSummary,
      body: "B",
      findings: [],
    }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.summary).toBe(longSummary.slice(0, 100));
  expect(h.store.gate.summary.length).toBe(100); // HUD one-liner stays clamped
  expect(h.store.gate.findings).toEqual([longSummary]); // steer-back is the FULL, untruncated summary
  expect(h.store.gate.findings[0].length).toBeGreaterThan(100);
});

test("code guard: a normal (<=100 char) summary fallback is unaffected", async () => {
  const h = harness({
    readVerdict: () => ({
      decision: "request-changes",
      summary: "short one-liner",
      body: "B",
      findings: [],
    }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.summary).toBe("short one-liner");
  expect(h.store.gate.findings).toEqual(["short one-liner"]);
});

// ─── operator-language: per-spawn read, not frozen at construction (Task 6, issue #1586) ─────

test("operator-language: reviewer prompt reads operatorLanguage per spawn, not cached at construction", async () => {
  let lang: "en" | "de" = "en";
  let calls = 0;
  const h = harness({
    operatorLanguage: () => {
      calls++;
      return lang;
    },
  });
  const s1 = await h.svc.consider(planningSession() as any);
  expect(s1).toBe("started");
  expect(calls).toBe(1);
  expect(h.started[0].argv.at(-1)).not.toContain("German");

  // Free the inflight slot (mirrors the createDetached-slug test above) so a second begin() can
  // run on the SAME service instance, then flip the live setting and drive another spawn — a
  // construction-frozen value would never see this change.
  h.svc.forget("s1");
  lang = "de";
  const s2 = await h.svc.consider(planningSession() as any);
  expect(s2).toBe("started");
  expect(calls).toBe(2);
  expect(h.started[1].argv.at(-1)).toContain("German");
});

// ── Deterministic tab-baseline (#1852) ────────────────────────────────────────
//
// Repeated full reviewer lifecycles against a fake herdr that models the #1852 driver
// contract (stop() closes the tab recorded at start(), whether or not the reviewer still
// appears in any live list). Every finalization path must return the open-tab set to
// baseline — a path that skips teardown, or passes a dead handle, leaves a tab behind.

test("tab baseline: repeated plan reviews (approve + timeout + cancel) leave zero open tabs (#1852)", async () => {
  let t = 1_000;
  let n = 0;
  const openTabs = new Set<string>();
  const byTerminal = new Map<string, string>();
  let verdict: any = null;
  const h = harness({
    herdr: {
      start: async () => {
        const terminalId = `t${++n}`;
        byTerminal.set(terminalId, `tab-${n}`);
        openTabs.add(`tab-${n}`);
        return { terminalId };
      },
      stop: async (terminalId: string) => {
        const tab = byTerminal.get(terminalId);
        if (tab) openTabs.delete(tab);
      },
      list: () => [],
    },
    readVerdict: () => verdict,
    now: () => t,
    timeoutMs: 5_000,
  });

  for (let run = 1; run <= 2; run++) {
    // Approve lifecycle.
    verdict = { decision: "approve", summary: "ok", body: "B", findings: [] };
    await h.svc.consider(planningSession() as any);
    expect(openTabs.size).toBe(1);
    await h.svc.tick();
    expect(openTabs.size).toBe(0);

    // Timeout lifecycle: verdict never written, clock passes timeoutMs.
    verdict = null;
    await h.svc.consider(planningSession() as any);
    t += 6_000;
    await h.svc.tick();
    expect(openTabs.size).toBe(0);

    // Cancellation lifecycle: session archived mid-review.
    await h.svc.consider(planningSession() as any);
    h.svc.forget("s1");
    await Bun.sleep(0); // reapReviewer's stop is fire-and-forget — let it settle
    expect(openTabs.size).toBe(0);
  }
  expect(n).toBe(6); // six real spawns; all six tabs were closed
});

// ─── anchor resolution + staleness ordering ──────────────────────────────────────────────────

test("begin passes the session worktreePath to the anchor resolver", async () => {
  const seen: any[] = [];
  const h = harness({
    baseSha: (repoPath: string, base: string, worktreePath: string) => {
      seen.push([repoPath, base, worktreePath]);
      return { sha: "abc", anchored: true, ahead: 0 };
    },
  });
  await h.svc.consider(planningSession() as any);
  // The third argument is the whole point: without the planner's own worktree there is no
  // merge-base to anchor to, and the reviewer falls back to the drifted freshest origin/<base>.
  expect(seen).toEqual([["/r", "main", "/wt"]]);
});

test("anchorStaleness runs AFTER createDetached (its fetch is what makes the numbers real)", async () => {
  const order: string[] = [];
  const h = harness({
    worktree: {
      createDetached: async () => {
        order.push("createDetached");
        return { worktreePath: "/wt-detached", branch: "main" };
      },
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
    anchorStaleness: () => {
      order.push("anchorStaleness");
      return { behind: 0, changedSince: [] };
    },
  });
  await h.svc.consider(planningSession() as any);
  // Ordering is invisible in the returned numbers — only this assertion catches a regression that
  // measures against a pre-fetch origin/<base> and silently understates (often to zero).
  expect(order).toEqual(["createDetached", "anchorStaleness"]);
});

test("anchored=false suppresses the anchor claim AND skips staleness entirely", async () => {
  let stalenessCalls = 0;
  const h = harness({
    baseSha: () => ({ sha: "deadbeef", anchored: false, ahead: 0 }),
    anchorStaleness: () => {
      stalenessCalls++;
      return { behind: 9, changedSince: ["src/a.ts"] };
    },
  });
  await h.svc.consider(planningSession() as any);
  const prompt = h.started[0].argv.at(-1) as string;
  expect(prompt).toContain("could NOT be tied");
  expect(prompt).not.toContain("reads IDENTICALLY");
  // Measuring drift from an anchor that isn't the planner's tree would be meaningless.
  expect(stalenessCalls).toBe(0);
});

test("ahead>0 routes unresolvable refs to body; the staleness block reaches the prompt", async () => {
  const h = harness({
    baseSha: () => ({ sha: "abc1234", anchored: true, ahead: 2 }),
    anchorStaleness: () => ({ behind: 7, changedSince: ["src/a.ts"], more: 3 }),
  });
  await h.svc.consider(planningSession() as any);
  const prompt = h.started[0].argv.at(-1) as string;
  expect(prompt).toContain("2 commit(s) SINCE that merge-base");
  expect(prompt).not.toContain("IS therefore a finding");
  expect(prompt).toContain("7 commit(s) behind");
  expect(prompt).toContain("Anchor staleness (informational, non-blocking):");
});

test("the reviewer argv pins the same session id that keys the worktree path", async () => {
  const slugs: string[] = [];
  const h = harness({
    worktree: {
      createDetached: async (_r: string, _b: string, _s: string, slug: string) => {
        slugs.push(slug);
        return { worktreePath: "/wt-detached", branch: "main" };
      },
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
  });
  await h.svc.consider(planningSession() as any);
  // The prompt is now built after createDetached, so the id is minted up front and threaded into
  // reviewerArgv. If those ever diverge, the transcript/verdict lookups silently miss.
  const argv = h.started[0].argv as string[];
  const idIdx = argv.indexOf("--session-id");
  expect(idIdx).toBeGreaterThan(-1);
  expect(argv[idIdx + 1]).toBe(slugs[0]);
  expect(h.recordedSpawns[0].reviewerSessionId).toBe(slugs[0]);
});

// ─── findings are never mutated (both resolveFindings branches) ──────────────────────────────
// The strip is INBOUND-only. Findings travel to the planner verbatim — via steerFindings, via
// resume()'s re-steer, and via the next round's "re-raise it verbatim" instruction — so rewriting
// them would turn "the ref x.ts:12 points at the wrong function" into an un-addressable
// "the ref x.ts points at the wrong function" that the next round recycles, LENGTHENING the loop.

test("findings reach the gate byte-identical (parsed-array branch)", async () => {
  const h = harness({
    readVerdict: () => ({
      decision: "request-changes",
      summary: "s",
      body: "the body cites src/b.ts:77",
      findings: ["src/a.ts:412 clamps the wrong value", "second point"],
    }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.findings).toEqual(["src/a.ts:412 clamps the wrong value", "second point"]);
  expect(h.store.gate.body).toBe("the body cites src/b.ts:77");
});

test("findings reach the gate byte-identical (empty-findings rawSummary fallback branch)", async () => {
  // resolveFindings falls back to the UN-clamped raw summary when findings[] is empty. That value
  // is assembled separately from normalizeFindings, so a strip placed there would have missed it —
  // this branch is what invalidated an earlier design.
  const h = harness({
    readVerdict: () => ({
      decision: "request-changes",
      summary: "the plan's ref src/ui/mod.rs:1385-1388 is wrong",
      body: "B",
      findings: [],
    }),
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.findings).toEqual(["the plan's ref src/ui/mod.rs:1385-1388 is wrong"]);
  expect(h.store.gate.summary).toBe("the plan's ref src/ui/mod.rs:1385-1388 is wrong");
});

test("prior findings are re-raised into the next prompt verbatim, line numbers intact", async () => {
  const h = harness({
    store: {
      getPlanGate: () => ({
        sessionId: "s1",
        planHash: "OLD",
        decision: "changes_requested",
        approved: false,
        round: 1,
        findings: ["the ref src/old.ts:99 points at the wrong function"],
      }),
    },
  });
  await h.svc.consider(planningSession() as any);
  const prompt = lastPrompt(h);
  expect(prompt).toContain("the ref src/old.ts:99 points at the wrong function");
  // ...and the prompt must tell the reviewer that reproducing it is REQUIRED, so the new
  // "cite path + symbol, not line numbers" rule cannot be read as an order to rewrite it.
  expect(prompt).toContain("EXEMPTION: re-raising a prior finding verbatim is REQUIRED");
});
