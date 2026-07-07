import { expect, test, beforeEach, afterEach } from "bun:test";
import { PlanGateService } from "../src/plan-gate";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

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
      start: (l: string, cwd: string, argv: string[], env?: Record<string, string>) => {
        started.push({ l, cwd, argv, env });
        return { terminalId: "t1" };
      },
      stop() {},
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
    reply: () => true,
    release() {},
    onChange() {},
    onReviewing() {},
    cap: 3,
    now: () => 1000,
    readPlan: () => "PLAN TEXT",
    readVerdict: () => null,
    baseSha: () => "abc",
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

test("plan-gate: api-key without a configured key fails closed → 'error', no spawn, reaped", async () => {
  await withAuth("api-key", null, async () => {
    const h = harness();
    const status = await h.svc.consider(planningSession() as any);
    expect(status).toBe("error");
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
test("consider reports 'error' (not a dedupe) when the reviewer fails to spawn", async () => {
  const h = harness({
    herdr: {
      start: () => {
        throw new Error("spawn boom");
      },
      stop() {},
    },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("error"); // UI shows a failure note, not "plan unchanged"
  expect(h.started.length).toBe(0);
  expect(h.removed).toEqual(["/wt-detached"]); // the detached worktree is reaped on failure
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
test("timeout with no verdict → error gate, reaped, not released", async () => {
  let t = 1000;
  const h = harness({ readVerdict: () => null, now: () => t });
  await h.svc.consider(planningSession() as any); // startedAt = 1000
  t = 1000 + 11 * 60 * 1000; // exceed default 10m timeout
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("error");
  expect(h.removed).toContain("/wt-detached");
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
      start: () => ({ terminalId: "t-rev" }),
      stop: (id: string) => stopped.push(id),
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
      start: () => ({ terminalId: "t1" }),
      stop: (id: string) => stopped.push(id),
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

test("resume happy path: resets round to 0, fires onChange, re-steers findings, returns true", () => {
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
    reply: (id: string, text: string) => {
      replyCalls.push(text);
      return true;
    },
  });
  const result = h.svc.resume(planningSession() as any);
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

test("resume: reply returns false → resume returns false", () => {
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
    reply: () => false,
  });
  expect(h.svc.resume(planningSession() as any)).toBe(false);
});

test("resume no-op: no gate → returns false, no putPlanGate/reply", () => {
  const putCalls: any[] = [];
  const replyCalls: any[] = [];
  const h = harness({
    store: { getPlanGate: () => null, putPlanGate: (g: any) => putCalls.push(g) },
    reply: (id: string, text: string) => {
      replyCalls.push(text);
      return true;
    },
  });
  const result = h.svc.resume(planningSession() as any);
  expect(result).toBe(false);
  expect(putCalls).toHaveLength(0);
  expect(replyCalls).toHaveLength(0);
});

test("resume no-op: gate decision is 'approved' → returns false, no putPlanGate/reply", () => {
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
    reply: (id: string, text: string) => {
      replyCalls.push(text);
      return true;
    },
  });
  const result = h.svc.resume(planningSession() as any);
  expect(result).toBe(false);
  expect(putCalls).toHaveLength(0);
  expect(replyCalls).toHaveLength(0);
});

test("resume no-op: gate decision is 'error' → returns false", () => {
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
  expect(h.svc.resume(planningSession() as any)).toBe(false);
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

test("resume: clears a prior dismissed flag", () => {
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
    reply: () => true,
  });
  h.svc.resume(planningSession() as any);
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
