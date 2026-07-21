import { expect, test, beforeEach, afterEach } from "bun:test";
import { HerdDigestService, dayKeyFor } from "../src/herd-digest";
import type { HerdSnapshots, MergeTrainState } from "../src/herd-digest";
import { SessionStore } from "../src/store";
import type { HerdDigest, RundownEpicItem, Session } from "../src/types";
import type { RoleEnvironment } from "../src/default-model";
import { config } from "../src/config";
import { RUNDOWN_EPICS_CAP, RUNDOWN_VERDICT_FILE } from "../src/rundown-core";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "x",
    prompt: "do the thing",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    claudeSessionId: "c1",
    model: null,
    effort: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase: null,
    research: false,
    epicAuthoring: false,
    landingRepair: false,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "running",
    lastState: "working",
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

const VALID_VERDICT_JSON = JSON.stringify({
  overnight: "PR #5 merged overnight.",
  decisions: [{ label: "Approve the plan for TASK-02", sessionId: "s2", pr: 7 }],
  ciRework: [{ label: "CI red on TASK-03", sessionId: "s3" }],
  train: "Train idle; 1 PR ready.",
  focusNext: [{ label: "Review the diff on TASK-01" }],
});

type FakeStore = {
  digests: Record<string, HerdDigest>;
  reviewerSpawns: any[];
  completedSpawns: any[];
  sessions: Session[];
  overnightDeltaResult: { mergedPrs: number[]; archivedSessions: { id: string; desig: string }[] };
  getHerdDigest: (dayKey: string) => HerdDigest | null;
  getLatestHerdDigest: () => HerdDigest | null;
  putHerdDigest: (d: HerdDigest) => void;
  generatingHerdDigests: () => HerdDigest[];
  overnightDelta: (sinceTs: number) => FakeStore["overnightDeltaResult"];
  recordReviewerSpawn: (r: any) => void;
  completeReviewerSpawn: (id: string, u: any, at: number) => void;
  list: (opts?: { activeOnly?: boolean }) => Session[];
};

function makeStore(sessions: Session[] = [], digests: HerdDigest[] = []): FakeStore {
  const map: Record<string, HerdDigest> = {};
  for (const d of digests) map[d.dayKey] = d;
  const store: FakeStore = {
    digests: map,
    reviewerSpawns: [],
    completedSpawns: [],
    sessions,
    overnightDeltaResult: { mergedPrs: [], archivedSessions: [] },
    getHerdDigest: (dayKey) => store.digests[dayKey] ?? null,
    getLatestHerdDigest: () => {
      const all = Object.values(store.digests);
      if (all.length === 0) return null;
      return all.reduce((a, b) => (b.spawnedAt > a.spawnedAt ? b : a));
    },
    putHerdDigest: (d) => {
      store.digests[d.dayKey] = d;
    },
    generatingHerdDigests: () =>
      Object.values(store.digests).filter((d) => d.state === "generating"),
    overnightDelta: () => store.overnightDeltaResult,
    recordReviewerSpawn: (r) => store.reviewerSpawns.push(r),
    completeReviewerSpawn: (id, u, at) => store.completedSpawns.push({ id, u, at }),
    list: () => store.sessions,
  };
  return store;
}

type FakePaneEntry = { cwd: string; terminalId: string };

type FakeHerdr = {
  started: { label: string; cwd: string; argv: string[]; env?: Record<string, string> }[];
  stopped: string[];
  livePanes: FakePaneEntry[];
  start: (
    label: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ) => Promise<{ terminalId: string }>;
  stop: (id: string) => Promise<void>;
  list: () => FakePaneEntry[];
};

function makeHerdr(livePanes: FakePaneEntry[] = []): FakeHerdr {
  const h: FakeHerdr = {
    started: [],
    stopped: [],
    livePanes,
    start: async (label, cwd, argv, env) => {
      const tid = `tid-${h.started.length + 1}`;
      h.started.push({ label, cwd, argv, env });
      h.livePanes.push({ cwd, terminalId: tid });
      return { terminalId: tid };
    },
    stop: async (id) => void h.stopped.push(id),
    list: () => h.livePanes,
  };
  return h;
}

const EMPTY_SNAPSHOTS: HerdSnapshots = { git: {}, reviews: {}, gates: {}, recaps: {} };

function buildSvc(opts: {
  store: FakeStore;
  herdr: FakeHerdr;
  isActive?: () => boolean;
  onChange?: (d: HerdDigest) => void;
  nowFn: () => number;
  snapshots?: () => HerdSnapshots;
  stalledSessionIds?: () => Set<string>;
  mergeTrainState?: () => MergeTrainState;
  backlogPriority?: () => Record<string, number>;
  landingReadyEpics?: () => Promise<RundownEpicItem[]>;
  hasOpenLandingEpics?: () => boolean;
  environment?: () => RoleEnvironment;
  verdict?: string | null;
  timeoutMs?: number;
  readUsage?: () => Promise<any>;
  cleanup?: (d: string) => void;
  makeTmpDir?: () => string;
}): HerdDigestService {
  let tmpIdx = 0;
  return new HerdDigestService({
    store: opts.store as any,
    herdr: opts.herdr as any,
    isActive: opts.isActive ?? (() => true),
    onChange: opts.onChange ?? (() => {}),
    snapshots: opts.snapshots ?? (() => EMPTY_SNAPSHOTS),
    stalledSessionIds: opts.stalledSessionIds,
    mergeTrainState: opts.mergeTrainState,
    backlogPriority: opts.backlogPriority,
    landingReadyEpics: opts.landingReadyEpics,
    hasOpenLandingEpics: opts.hasOpenLandingEpics,
    environment: opts.environment,
    now: opts.nowFn,
    timeoutMs: opts.timeoutMs ?? 300_000,
    readVerdict: () => (opts.verdict !== undefined ? opts.verdict : null),
    readUsage: opts.readUsage ?? (async () => null),
    makeTmpDir: opts.makeTmpDir ?? (() => `/tmp/rundown-test-${++tmpIdx}`),
    cleanup: opts.cleanup ?? (() => {}),
  });
}

const DAY1 = Date.UTC(2026, 5, 15, 12, 0, 0); // noon — far from any local-tz day boundary
const DAY2 = Date.UTC(2026, 5, 16, 12, 0, 0);

// ── daily single-flight ─────────────────────────────────────────────────────────

test("sweep: two calls same day → only ONE spawn; next day → a new spawn", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  let t = DAY1;
  const svc = buildSvc({ store, herdr, nowFn: () => t });

  await svc.sweep();
  expect(herdr.started.length).toBe(1);

  // Second sweep same day — a generating row now exists → no second spawn.
  await svc.sweep();
  expect(herdr.started.length).toBe(1);

  // Advance to next day → a fresh dayKey with no digest → spawns again.
  t = DAY2;
  await svc.sweep();
  expect(herdr.started.length).toBe(2);
});

// ── presence gate ─────────────────────────────────────────────────────────────

test("sweep: inactive operator → no spawn; active + no digest + non-empty → spawn", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  let active = false;
  const svc = buildSvc({ store, herdr, isActive: () => active, nowFn: () => DAY1 });

  await svc.sweep();
  expect(herdr.started.length).toBe(0);

  active = true;
  await svc.sweep();
  expect(herdr.started.length).toBe(1);
});

// ── empty-herd guard ──────────────────────────────────────────────────────────

test("sweep: no active sessions → no spawn", async () => {
  const store = makeStore([]); // empty herd
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1 });

  await svc.sweep();
  expect(herdr.started.length).toBe(0);
});

// ── in-flight guard ─────────────────────────────────────────────────────────────

test("generate: a generating row for today → returns 'in-flight', no second spawn", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1 });

  expect(await svc.generate()).toBe("started");
  expect(herdr.started.length).toBe(1);

  expect(await svc.generate()).toBe("in-flight");
  expect(herdr.started.length).toBe(1);
});

// ── tick finalize on verdict present ─────────────────────────────────────────────

test("tick: generating row + valid verdict → 'ready' with parsed fields + onChange + reaped", async () => {
  const dayKey = dayKeyFor(DAY1);
  const row: HerdDigest = {
    dayKey,
    state: "generating",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: { s1: ["in-flight"] },
    spawnSessionId: "sp1",
    cwd: "/tmp/rundown-x",
    model: "sonnet",
    spawnedAt: DAY1,
    generatedAt: null,
    updatedAt: DAY1,
  };
  const store = makeStore([], [row]);
  const herdr = makeHerdr([{ cwd: "/tmp/rundown-x", terminalId: "t99" }]);
  const cleaned: string[] = [];
  const changes: HerdDigest[] = [];
  const fakeUsage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    total: 3,
    messageCount: 1,
    lastActivity: null,
    byModel: {},
    fullRecaches: 0,
    sidechainCount: 0,
  };

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1 + 60_000,
    verdict: VALID_VERDICT_JSON,
    readUsage: async () => fakeUsage,
    onChange: (d) => changes.push(d),
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();

  const d = store.getHerdDigest(dayKey);
  expect(d?.state).toBe("ready");
  expect(d?.overnight).toBe("PR #5 merged overnight.");
  expect(d?.decisions[0]?.label).toBe("Approve the plan for TASK-02");
  expect(d?.decisions[0]?.pr).toBe(7);
  expect(d?.ciRework[0]?.sessionId).toBe("s3");
  expect(d?.train).toBe("Train idle; 1 PR ready.");
  expect(d?.focusNext[0]?.label).toBe("Review the diff on TASK-01");
  // fingerprint preserved across finalize
  expect(d?.attentionFingerprint).toEqual({ s1: ["in-flight"] });
  expect(changes.length).toBe(1);
  expect(store.completedSpawns[0]?.id).toBe("sp1");
  expect(herdr.stopped).toContain("t99");
  expect(cleaned).toContain("/tmp/rundown-x");
});

// ── tick finalize on timeout ─────────────────────────────────────────────────────

test("tick: generating row, no verdict, past timeout → 'failed' (not ready, not empty success)", async () => {
  const dayKey = dayKeyFor(DAY1);
  const row: HerdDigest = {
    dayKey,
    state: "generating",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: {},
    spawnSessionId: "sp2",
    cwd: "/tmp/rundown-timeout",
    model: "sonnet",
    spawnedAt: DAY1,
    generatedAt: null,
    updatedAt: DAY1,
  };
  const store = makeStore([], [row]);
  const herdr = makeHerdr([{ cwd: "/tmp/rundown-timeout", terminalId: "t-to" }]);
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1 + 400_000, // > 300_000 timeout
    timeoutMs: 300_000,
    verdict: null,
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  const d = store.getHerdDigest(dayKey);
  expect(d?.state).toBe("failed");
  expect(d?.generatedAt).toBe(DAY1 + 400_000);
  expect(herdr.stopped).toContain("t-to");
  expect(cleaned).toContain("/tmp/rundown-timeout");
});

// #1852: a rundown helper that exits cleanly before finalize has vanished from `agent list`,
// so the old cwd re-lookup returned "" and stop("") silently no-oped, leaking the tab. The
// finalizer must stop the terminalId recorded at spawn (mirrors the recap regression).
test("tick finalize after the agent exited: stops the spawn-recorded terminal, not the cwd re-lookup (#1852)", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  const cleaned: string[] = [];
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    verdict: VALID_VERDICT_JSON,
    cleanup: (d) => cleaned.push(d),
  });

  expect(await svc.generate()).toBe("started"); // records tid-1 as the run's teardown handle
  herdr.livePanes.length = 0; // the helper exits: gone from agent list, husk tab remains

  await svc.tick(); // verdict present → finalize

  expect(store.getHerdDigest(dayKeyFor(DAY1))?.state).toBe("ready");
  expect(herdr.stopped).toEqual(["tid-1"]); // the spawn handle — never "" (the silent no-op)
  expect(cleaned.length).toBe(1);
});

test("tick: generating row, unparseable verdict → 'failed'", async () => {
  const dayKey = dayKeyFor(DAY1);
  const row: HerdDigest = {
    dayKey,
    state: "generating",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: {},
    spawnSessionId: "sp3",
    cwd: "/tmp/rundown-garbage",
    model: "sonnet",
    spawnedAt: DAY1,
    generatedAt: null,
    updatedAt: DAY1,
  };
  const store = makeStore([], [row]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1 + 1_000,
    verdict: "this is not json",
  });

  await svc.tick();
  expect(store.getHerdDigest(dayKey)?.state).toBe("failed");
});

// ── regenerate ──────────────────────────────────────────────────────────────────

test("regenerate: forces a new generation even when today's digest is ready", async () => {
  const dayKey = dayKeyFor(DAY1);
  const ready: HerdDigest = {
    dayKey,
    state: "ready",
    overnight: "old",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: {},
    spawnSessionId: "old-sp",
    cwd: "/tmp/old",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 500,
    updatedAt: DAY1 - 500,
  };
  const store = makeStore([makeSession()], [ready]);
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1, makeTmpDir: () => "/tmp/rundown-regen" });

  const result = await svc.regenerate();
  expect(result).toBe("started");
  expect(herdr.started.length).toBe(1);
  const d = store.getHerdDigest(dayKey);
  expect(d?.state).toBe("generating");
  expect(d?.cwd).toBe("/tmp/rundown-regen");
});

test("regenerate: forced over an in-flight (generating) row → reaps OLD pane+tmpdir, spawns replacement", async () => {
  const dayKey = dayKeyFor(DAY1);
  const generating: HerdDigest = {
    dayKey,
    state: "generating",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: {},
    spawnSessionId: "old-sp",
    cwd: "/tmp/rundown-old-inflight",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: null,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([makeSession()], [generating]);
  // Register the OLD spawn's live pane so resolveTerminal finds it.
  const herdr = makeHerdr([{ cwd: "/tmp/rundown-old-inflight", terminalId: "old-tid" }]);
  const cleaned: string[] = [];
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    makeTmpDir: () => "/tmp/rundown-new-inflight",
    cleanup: (d) => cleaned.push(d),
  });

  const result = await svc.regenerate();
  expect(result).toBe("started");

  // OLD pane stopped + OLD tmpdir cleaned (orphan reaped, not leaked).
  expect(herdr.stopped).toContain("old-tid");
  expect(cleaned).toContain("/tmp/rundown-old-inflight");

  // A replacement spawn launched and overwrote the row with the NEW cwd/spawn.
  expect(herdr.started.length).toBe(1);
  expect(herdr.started[0]!.cwd).toBe("/tmp/rundown-new-inflight");
  const d = store.getHerdDigest(dayKey);
  expect(d?.state).toBe("generating");
  expect(d?.cwd).toBe("/tmp/rundown-new-inflight");
  expect(d?.spawnSessionId).not.toBe("old-sp");
});

// ── argv shape (variadic-allowedTools trap) ──────────────────────────────────────

test("argv: --model sonnet, --permission-mode AFTER --allowedTools, prompt last", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1 });

  await svc.generate();
  const argv = herdr.started[0]!.argv;

  expect(herdr.started[0]!.label).toBe("rundown");

  const modelIdx = argv.indexOf("--model");
  expect(argv[modelIdx + 1]).toBe("sonnet");

  const allowedIdx = argv.indexOf("--allowedTools");
  const permIdx = argv.indexOf("--permission-mode");
  expect(allowedIdx).toBeGreaterThan(-1);
  expect(permIdx).toBeGreaterThan(allowedIdx); // permission-mode must follow variadic allowedTools
  expect(argv[allowedIdx + 1]).toBe("Write");
  expect(argv[permIdx + 1]).toBe("dontAsk");

  // prompt is the final token (after dontAsk), and not a flag.
  const last = argv[argv.length - 1]!;
  expect(last.startsWith("--")).toBe(false);
  expect(last).toContain("what needs a human right now");
});

const PROVIDER_DRIVERS = ["sweep", "regenerate"] as const;
const PROVIDER_ENVS = [
  { provider: "claude", model: "sonnet", effort: "low" },
  { provider: "codex", model: "gpt-5.5", effort: "high" },
] as const satisfies readonly RoleEnvironment[];

for (const driver of PROVIDER_DRIVERS) {
  for (const environment of PROVIDER_ENVS) {
    test(`${driver}: ${environment.provider} uses its CLI and attributes the resolved environment`, async () => {
      const store = makeStore([makeSession()]);
      const herdr = makeHerdr();
      const svc = buildSvc({
        store,
        herdr,
        nowFn: () => DAY1,
        environment: () => environment,
      });

      await svc[driver]();

      const argv = herdr.started[0]!.argv;
      const prompt = argv.at(-1)!;
      expect(prompt).toContain(RUNDOWN_VERDICT_FILE);
      if (environment.provider === "claude") {
        expect(argv[0]).toBe("claude");
        expect(argv[argv.indexOf("--model") + 1]).toBe(environment.model);
        expect(argv[argv.indexOf("--effort") + 1]).toBe(environment.effort);
        expect(argv.indexOf("--permission-mode")).toBeGreaterThan(argv.indexOf("--allowedTools"));
      } else {
        expect(argv.slice(0, 4)).toEqual(["codex", "exec", "--sandbox", "workspace-write"]);
        expect(argv[argv.indexOf("-m") + 1]).toBe(environment.model);
        expect(argv).toContain(`model_reasoning_effort=${environment.effort}`);
        expect(argv).not.toContain("--allowedTools");
      }

      const reviewerSpawn = store.reviewerSpawns[0];
      expect(typeof reviewerSpawn?.reviewerSessionId).toBe("string");
      expect(reviewerSpawn).toMatchObject({
        taskSessionId: "",
        kind: "rundown",
        reviewerProvider: environment.provider,
        model: environment.model,
        reviewerEffort: environment.effort,
      });
      const digest = store.getHerdDigest(dayKeyFor(DAY1));
      expect(digest?.spawnSessionId).toBe(reviewerSpawn?.reviewerSessionId);
      expect(digest?.model).toBe(environment.model);
    });
  }
}

test("generate resolves the environment again for a later regenerate", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  let environment: RoleEnvironment = { provider: "claude", model: "sonnet", effort: "low" };
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1, environment: () => environment });

  expect(await svc.generate()).toBe("started");
  environment = { provider: "codex", model: "gpt-5.5", effort: "medium" };
  expect(await svc.regenerate()).toBe("started");

  expect(herdr.started.map((spawn) => spawn.argv[0])).toEqual(["claude", "codex"]);
  expect(store.reviewerSpawns.map((spawn) => spawn.reviewerProvider)).toEqual(["claude", "codex"]);
  expect(store.reviewerSpawns[1]).toMatchObject({
    model: "gpt-5.5",
    reviewerEffort: "medium",
  });
});

test("generate does not apply the Claude API-key fail-closed gate to Codex", async () => {
  const previousMode = config.authMode;
  const previousHelper = config.authApiKeyHelperPath;
  config.authMode = "api-key";
  config.authApiKeyHelperPath = null;
  try {
    const store = makeStore([makeSession()]);
    const herdr = makeHerdr();
    const svc = buildSvc({
      store,
      herdr,
      nowFn: () => DAY1,
      environment: () => ({ provider: "codex", model: "gpt-5.5", effort: "low" }),
    });

    expect(await svc.generate()).toBe("started");
    expect(herdr.started[0]!.argv[0]).toBe("codex");
    expect(herdr.started[0]!.env).toBeUndefined();
  } finally {
    config.authMode = previousMode;
    config.authApiKeyHelperPath = previousHelper;
  }
});

// ── empty-herd short-circuit in generate (no active sessions) ─────────────────────

test("generate: completely empty herd → 'empty', no spawn", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1 });

  expect(await svc.generate()).toBe("empty");
  expect(herdr.started.length).toBe(0);
});

// ── all-clear herd (active but no attention signals) still spawns ─────────────────

test("generate: active sessions with attention signals → spawns; reviewerSpawn kind=rundown", async () => {
  const store = makeStore([makeSession({ status: "running" })]);
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => DAY1 });

  expect(await svc.generate()).toBe("started");
  expect(store.reviewerSpawns.length).toBe(1);
  expect(store.reviewerSpawns[0]!.kind).toBe("rundown");
  expect(store.reviewerSpawns[0]!.taskSessionId).toBe("");
});

// ── currentAttentionFingerprint ──────────────────────────────────────────────────

test("currentAttentionFingerprint: classifies live caches; folds in stall + train state", () => {
  const blocked = makeSession({ id: "s1", status: "blocked" });
  const running = makeSession({ id: "s2", status: "running" });
  const stalledSess = makeSession({ id: "s3", status: "running" });
  const store = makeStore([blocked, running, stalledSess]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    snapshots: () => ({
      git: { s2: { checks: "failure" } as any },
      reviews: {},
      gates: {},
      recaps: {},
    }),
    stalledSessionIds: () => new Set(["s3"]),
    mergeTrainState: () => ({ queuedPrs: [], bySession: {} }),
  });

  const fp = svc.currentAttentionFingerprint();
  expect(fp.s1).toContain("blocked-decision");
  expect(fp.s2).toContain("ci-red"); // git.checks=failure
  expect(fp.s3).toContain("stalled"); // injected stall set
});

test("currentAttentionFingerprint: drift vs a stored digest is measurable via fingerprintDiffCount", async () => {
  const { fingerprintDiffCount } = await import("../src/rundown-core");
  const s2 = makeSession({ id: "s2", status: "running" });
  const store = makeStore([s2]);
  const herdr = makeHerdr();
  // Stored snapshot: s2 was merely in-flight.
  const stored = { s2: ["in-flight"] };
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    // Now s2 has gone CI-red.
    snapshots: () => ({
      git: { s2: { checks: "failure" } as any },
      reviews: {},
      gates: {},
      recaps: {},
    }),
  });
  const current = svc.currentAttentionFingerprint();
  expect(fingerprintDiffCount(stored, current)).toBeGreaterThan(0);
  // Identical → 0.
  expect(fingerprintDiffCount(current, current)).toBe(0);
});

test("generate: backlogPriority is threaded into the assembled prompt as backlogRank", async () => {
  const store = makeStore([makeSession({ id: "s1", repoPath: "/r", status: "running" })]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    backlogPriority: () => ({ "/r": 0 }),
  });
  expect(await svc.generate()).toBe("started");
  const prompt = herdr.started[0]!.argv.at(-1)!;
  // The emitted session for /r must carry its rank-0 priority in the herd-state JSON.
  expect(prompt).toContain('"backlogRank": 0');
});

// ── #1045: epics-to-land surfacing + intraday reconcile ──────────────────────────

const sampleEpic = (over: Partial<RundownEpicItem> = {}): RundownEpicItem => ({
  repo: "/repo/a",
  parent: 7,
  title: "Epic A",
  landingPr: 99,
  stranded: false,
  ...over,
});

test("generate: empty herd BUT a landing-ready epic → spawns, row carries epicsToLand", async () => {
  const store = makeStore([]); // no live sessions
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true,
    landingReadyEpics: async () => [sampleEpic()],
  });

  expect(await svc.generate()).toBe("started");
  expect(herdr.started.length).toBe(1);
  const row = store.getHerdDigest(dayKeyFor(DAY1));
  expect(row?.epicsToLand).toEqual([sampleEpic()]);
});

test("generate: empty herd + open-but-NOT-ready epic → 'empty', no spawn, no row", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true, // sweep pre-filter would pass...
    landingReadyEpics: async () => [], // ...but nothing is actually ready
  });

  expect(await svc.generate()).toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getHerdDigest(dayKeyFor(DAY1))).toBeNull();
});

test("sweep: empty herd + hasOpenLandingEpics → calls generate (spawns for ready epic)", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true,
    landingReadyEpics: async () => [sampleEpic()],
  });
  await svc.sweep();
  expect(herdr.started.length).toBe(1);
});

test("sweep: empty herd + NO open epics → pre-filter skips, no spawn (no forge probe)", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  let probed = false;
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => false,
    landingReadyEpics: async () => {
      probed = true;
      return [];
    },
  });
  await svc.sweep();
  expect(herdr.started.length).toBe(0);
  expect(probed).toBe(false); // generate() never called → no forge probe
});

test("regenerate: truly empty (no sessions, no ready epics) → 'empty', writes no row", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => false,
    landingReadyEpics: async () => [],
  });
  expect(await svc.regenerate()).toBe("empty");
  expect(store.getHerdDigest(dayKeyFor(DAY1))).toBeNull();
  expect(herdr.started.length).toBe(0);
});

test("finalize: epicsToLand on generating row carries through to ready", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const verdict = JSON.stringify({
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
  });
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true,
    landingReadyEpics: async () => [sampleEpic()],
    verdict,
  });
  await svc.generate();
  await svc.tick(); // finalize the generating row
  const row = store.getHerdDigest(dayKeyFor(DAY1));
  expect(row?.state).toBe("ready");
  expect(row?.epicsToLand).toEqual([sampleEpic()]); // survived finalize
});

test("reconcileEpics: red→green flip updates today's ready row + emits", async () => {
  const dayKey = dayKeyFor(DAY1);
  const ready: HerdDigest = {
    dayKey,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [], // epic was NOT ready when generated
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([], [ready]);
  const herdr = makeHerdr();
  const changes: HerdDigest[] = [];
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    onChange: (d) => changes.push(d),
    landingReadyEpics: async () => [sampleEpic()], // now ready
  });

  await svc.reconcileEpics();
  const row = store.getHerdDigest(dayKey);
  expect(row?.epicsToLand).toEqual([sampleEpic()]);
  expect(changes.at(-1)?.epicsToLand).toEqual([sampleEpic()]);
});

test("reconcileEpics: a FAILED digest is kept live too (epic landed → drops)", async () => {
  const dayKey = dayKeyFor(DAY1);
  const failed: HerdDigest = {
    dayKey,
    state: "failed",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [sampleEpic()], // epic was ready when the (failed) digest spawned
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([], [failed]);
  const herdr = makeHerdr();
  const changes: HerdDigest[] = [];
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    onChange: (d) => changes.push(d),
    landingReadyEpics: async () => [], // epic has since landed → no longer ready
  });

  await svc.reconcileEpics();
  expect(store.getHerdDigest(dayKey)?.epicsToLand).toEqual([]);
  expect(store.getHerdDigest(dayKey)?.state).toBe("failed"); // state preserved
  expect(changes.at(-1)?.epicsToLand).toEqual([]);
});

test("reconcileEpics: unchanged set → no-op (no emit)", async () => {
  const dayKey = dayKeyFor(DAY1);
  const ready: HerdDigest = {
    dayKey,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [sampleEpic()],
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([], [ready]);
  const herdr = makeHerdr();
  const changes: HerdDigest[] = [];
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    onChange: (d) => changes.push(d),
    landingReadyEpics: async () => [sampleEpic()], // identical
  });
  await svc.reconcileEpics();
  expect(changes.length).toBe(0);
});

// Mirrors the exact object literal src/index.ts's landingReadyEpics() emits for a plain ready
// (non-stranded, non-CI-failing) epic in its `readyItems` .map() — keep in sync with that map.
const READY_LIVE_SHAPE: RundownEpicItem = {
  repo: "/repo/a",
  parent: 7,
  title: "Epic A",
  landingPr: 99,
  stranded: false,
  ciFailing: false,
};

test("reconcileEpics: real store round-trip is idempotent for a ready epic (regression)", async () => {
  // Uses the REAL SessionStore (not the in-memory FakeStore) so the digest's epicsToLand goes
  // through the actual JSON column + hydrateEpics() round-trip on read — that round-trip is where
  // the regression lived: hydrateEpics() unconditionally forces a `ciFailing` boolean onto every
  // hydrated item, so a stored/hydrated ready epic must already carry `ciFailing: false` or every
  // tick's JSON.stringify comparison against the live (un-hydrated) landingReadyEpics() output
  // mismatches and reconcileEpics() fires a spurious putHerdDigest + onChange broadcast.
  const dayKey = dayKeyFor(DAY1);
  const store = new SessionStore(":memory:");
  store.putHerdDigest({
    dayKey,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    // The exact shape frozen into epicsToLand at spawn time (landingReadyEpics() output).
    epicsToLand: [READY_LIVE_SHAPE],
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  });

  const changes: HerdDigest[] = [];
  const svc = new HerdDigestService({
    store,
    herdr: makeHerdr() as any,
    isActive: () => true,
    onChange: (d) => changes.push(d),
    snapshots: () => EMPTY_SNAPSHOTS,
    environment: () => ({ provider: "claude", model: "sonnet", effort: "low" }),
    now: () => DAY1,
    timeoutMs: 300_000,
    readVerdict: () => null,
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/rundown-test-regression",
    cleanup: () => {},
    // Nothing changed since spawn: the epic is still open + ready, same shape landingReadyEpics()
    // emits live on this tick (NOT hydrated — exactly like the real index.ts wiring).
    landingReadyEpics: async () => [READY_LIVE_SHAPE],
  });

  await svc.reconcileEpics();
  // Nothing actually changed → must be a no-op: no rewrite, no WS broadcast.
  expect(changes.length).toBe(0);
});

// Mirrors the exact object literal src/index.ts's landingReadyEpics() emits for a paused epic in
// its `pausedItems` .map() — keep in sync with that map.
const PAUSED_LIVE_SHAPE: RundownEpicItem = {
  repo: "/repo/a",
  parent: 7,
  title: "Epic A",
  landingPr: 99,
  stranded: false,
  ciFailing: false,
  pausedReason: "cap",
};

test("reconcileEpics: real store round-trip is idempotent for a paused epic (regression)", async () => {
  // Same class as the ready-epic regression above, but for the PAUSED case (#1666): hydrateEpics()
  // never read `pausedReason`, so a stored/hydrated paused epic dropped it and every tick's
  // JSON.stringify comparison against the live (un-hydrated) landingReadyEpics() output mismatched —
  // firing a spurious putHerdDigest + onChange broadcast for as long as any paused landing PR sat.
  const dayKey = dayKeyFor(DAY1);
  const store = new SessionStore(":memory:");
  store.putHerdDigest({
    dayKey,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    // The exact shape frozen into epicsToLand at spawn time (landingReadyEpics() output).
    epicsToLand: [PAUSED_LIVE_SHAPE],
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  });

  const changes: HerdDigest[] = [];
  const svc = new HerdDigestService({
    store,
    herdr: makeHerdr() as any,
    isActive: () => true,
    onChange: (d) => changes.push(d),
    snapshots: () => EMPTY_SNAPSHOTS,
    environment: () => ({ provider: "claude", model: "sonnet", effort: "low" }),
    now: () => DAY1,
    timeoutMs: 300_000,
    readVerdict: () => null,
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/rundown-test-paused-regression",
    cleanup: () => {},
    // Still paused with the same reason, same shape landingReadyEpics() emits live (NOT hydrated).
    landingReadyEpics: async () => [PAUSED_LIVE_SHAPE],
  });

  await svc.reconcileEpics();
  // Nothing actually changed → must be a no-op: no rewrite, no WS broadcast.
  expect(changes.length).toBe(0);
});

test("reconcileEpics: landed/lost readiness shrinks the set", async () => {
  const dayKey = dayKeyFor(DAY1);
  const ready: HerdDigest = {
    dayKey,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [sampleEpic()],
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([], [ready]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    landingReadyEpics: async () => [], // epic landed → no longer ready
  });
  await svc.reconcileEpics();
  expect(store.getHerdDigest(dayKey)?.epicsToLand).toEqual([]);
});

test("reconcileEpics: only today's ready digest (stale day ignored)", async () => {
  const staleDay = dayKeyFor(DAY1);
  const stale: HerdDigest = {
    dayKey: staleDay,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([], [stale]);
  const herdr = makeHerdr();
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY2, // "today" is DAY2; the ready row is from DAY1
    landingReadyEpics: async () => [sampleEpic()],
  });
  await svc.reconcileEpics();
  expect(store.getHerdDigest(staleDay)?.epicsToLand).toEqual([]); // untouched
});

test("reconcileEpics: caps the intraday list to RUNDOWN_EPICS_CAP", async () => {
  const dayKey = dayKeyFor(DAY1);
  const ready: HerdDigest = {
    dayKey,
    state: "ready",
    overnight: "",
    decisions: [],
    ciRework: [],
    train: "",
    focusNext: [],
    epicsToLand: [],
    attentionFingerprint: {},
    spawnSessionId: "spawn-1",
    cwd: "/tmp/x",
    model: "sonnet",
    spawnedAt: DAY1 - 1000,
    generatedAt: DAY1 - 1000,
    updatedAt: DAY1 - 1000,
  };
  const store = makeStore([], [ready]);
  const herdr = makeHerdr();
  const many = Array.from({ length: RUNDOWN_EPICS_CAP + 8 }, (_, i) => sampleEpic({ parent: i }));
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    landingReadyEpics: async () => many,
  });
  await svc.reconcileEpics();
  expect(store.getHerdDigest(dayKey)?.epicsToLand.length).toBe(RUNDOWN_EPICS_CAP);
});

// ── #1071: paused landing-rebase epics surfaced as Tier-1 ────────────────────

test("generate: paused epic (cap) → spawns, row carries epicsToLand with pausedReason", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const pausedEpic = sampleEpic({ pausedReason: "cap" });
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true,
    landingReadyEpics: async () => [pausedEpic],
  });

  expect(await svc.generate()).toBe("started");
  const row = store.getHerdDigest(dayKeyFor(DAY1));
  expect(row?.epicsToLand).toEqual([pausedEpic]);
  expect(row?.epicsToLand.at(0)?.pausedReason).toBe("cap");
});

test("generate: paused epic (driver) → spawns, epicsToLand carries driver reason", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const driverEpic = sampleEpic({ parent: 9, pausedReason: "driver" });
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true,
    landingReadyEpics: async () => [driverEpic],
  });

  expect(await svc.generate()).toBe("started");
  const row = store.getHerdDigest(dayKeyFor(DAY1));
  expect(row?.epicsToLand.at(0)?.pausedReason).toBe("driver");
});

test("generate: null pausedReason (ready) → epicsToLand has no pausedReason field", async () => {
  const store = makeStore([]);
  const herdr = makeHerdr();
  const readyEpic = sampleEpic(); // no pausedReason
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    hasOpenLandingEpics: () => true,
    landingReadyEpics: async () => [readyEpic],
  });

  expect(await svc.generate()).toBe("started");
  const row = store.getHerdDigest(dayKeyFor(DAY1));
  expect(row?.epicsToLand.at(0)?.pausedReason).toBeUndefined();
});

// #1852 critic follow-up: mirrors the recap race regression — the spawn-handle map is
// keyed by the RUN's mkdtemp-unique cwd, not the dayKey, so an old finalizer parked on
// an await can never stop + unmap a forced replacement's live terminal.
test("an old finalizer racing a forced regenerate never stops the replacement run (#1852)", async () => {
  const store = makeStore([makeSession()]);
  const herdr = makeHerdr();
  let raced = false;
  let svcRef: HerdDigestService | null = null;
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => DAY1,
    verdict: VALID_VERDICT_JSON,
    readUsage: async () => {
      if (!raced && svcRef) {
        raced = true;
        await svcRef.regenerate();
      }
      return null;
    },
  });
  svcRef = svc;

  expect(await svc.generate()).toBe("started"); // run A (tid-1)

  await svc.tick(); // finalize A; mid-finalize the hook force-regenerates → run B (tid-2)

  expect(herdr.started.length).toBe(2);
  expect(herdr.stopped).toEqual(["tid-1"]); // A's own terminal — NEVER the replacement's

  await svc.tick(); // the replacement finalizes normally off its own retained handle
  expect(herdr.stopped).toEqual(["tid-1", "tid-2"]);
  expect(store.getHerdDigest(dayKeyFor(DAY1))?.state).toBe("ready");
});
