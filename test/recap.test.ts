import { expect, test, beforeEach, afterEach } from "bun:test";
import { RecapService } from "../src/recap";
import type { VerdictRead } from "../src/json-tolerant";
import type { DiffResult, Recap, Session } from "../src/types";
import type { ActivityEntry } from "../src/activity";
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
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "idle",
    lastState: "idle",
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

function makeRecap(over: Partial<Recap> = {}): Recap {
  return {
    sessionId: "s1",
    state: "generating",
    headSha: "sha-a",
    base: "",
    verdict: null,
    headline: "",
    body: "",
    openItems: [],
    changedFiles: [],
    spawnSessionId: "spawn-1",
    cwd: "/tmp/recap-s1",
    model: "sonnet",
    spawnedAt: 1000,
    generatedAt: null,
    updatedAt: 1000,
    ...over,
  };
}

const VALID_VERDICT_JSON = {
  verdict: "ready",
  headline: "All done",
  body: "## Summary\nFixed the bug.",
  openItems: ["Write more tests"],
};

type FakeStore = {
  recaps: Record<string, Recap>;
  generatingRows: Recap[];
  reviewerSpawns: any[];
  completedSpawns: any[];
  sessions: Session[];
  pendingDiffs: Record<string, any[]>;
  getRecap: (id: string) => Recap | null;
  putRecap: (r: Recap) => void;
  snapshotRecaps: () => Record<string, Recap>;
  generatingRecaps: () => Recap[];
  dropRecap: (id: string) => void;
  getReview: (id: string) => null;
  recordReviewerSpawn: (r: any) => void;
  completeReviewerSpawn: (id: string, u: any, at: number) => void;
  listReviewerSpawns: () => any[];
  list: (opts?: { activeOnly?: boolean }) => Session[];
  setRecapPendingDiff: (sessionId: string, files: any[]) => void;
  get: (id: string) => Session | undefined;
};

function makeStore(sessions: Session[] = [], recaps: Recap[] = []): FakeStore {
  const recapMap: Record<string, Recap> = {};
  for (const r of recaps) recapMap[r.sessionId] = r;

  const store: FakeStore = {
    recaps: recapMap,
    generatingRows: recaps.filter((r) => r.state === "generating"),
    reviewerSpawns: [] as any[],
    completedSpawns: [] as any[],
    sessions,
    pendingDiffs: {},
    getRecap: (id) => store.recaps[id] ?? null,
    putRecap: (r) => {
      store.recaps[r.sessionId] = r;
      store.generatingRows = Object.values(store.recaps).filter((x) => x.state === "generating");
    },
    snapshotRecaps: () => ({ ...store.recaps }),
    generatingRecaps: () =>
      store.generatingRows.map((r) => ({
        ...r,
        pendingDiff: store.pendingDiffs[r.sessionId] ?? [],
      })),
    dropRecap: (id) => {
      delete store.recaps[id];
      store.generatingRows = store.generatingRows.filter((r) => r.sessionId !== id);
    },
    getReview: () => null,
    recordReviewerSpawn: (r: any) => store.reviewerSpawns.push(r),
    completeReviewerSpawn: (id: string, u: any, at: number) =>
      store.completedSpawns.push({ id, u, at }),
    listReviewerSpawns: () => store.reviewerSpawns,
    list: () => store.sessions,
    setRecapPendingDiff: (sessionId, files) => {
      store.pendingDiffs[sessionId] = files;
    },
    get: (id) => store.sessions.find((s) => s.id === id),
  };
  return store;
}

type FakePaneEntry = { cwd: string; terminalId: string; agentStatus?: string; paneId?: string };

type FakeHerdr = {
  started: { label: string; cwd: string; argv: string[]; env?: Record<string, string> }[];
  stopped: string[];
  livePanes: FakePaneEntry[];
  /** Per-pane procs override: paneId → procs. Falls back to defaultProcs. */
  procsOverride: Map<string, string[]>;
  /** Default procs for any pane not in procsOverride (default ['zsh'] = shell-only husk). */
  defaultProcs: string[];
  start: (
    label: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ) => Promise<{ terminalId: string }>;
  stop: (id: string) => Promise<void>;
  list: () => FakePaneEntry[];
  paneForegroundProcs: (paneId: string) => Promise<string[]>;
};

function makeHerdr(livePanes: FakePaneEntry[] = [], defaultProcs: string[] = ["zsh"]): FakeHerdr {
  const h: FakeHerdr = {
    started: [],
    stopped: [],
    livePanes,
    procsOverride: new Map(),
    defaultProcs,
    start: async (label, cwd, argv, env) => {
      const tid = `tid-${h.started.length + 1}`;
      h.started.push({ label, cwd, argv, env });
      h.livePanes.push({ cwd, terminalId: tid });
      return { terminalId: tid };
    },
    stop: async (id) => void h.stopped.push(id),
    list: () => h.livePanes,
    paneForegroundProcs: async (paneId: string) => h.procsOverride.get(paneId) ?? h.defaultProcs,
  };
  return h;
}

const NON_EMPTY_DIFF: DiffResult = {
  base: "main",
  baseRef: "origin/main",
  head: "shepherd/x",
  fetchFailed: false as const,
  truncated: false as const,
  files: [
    {
      path: "src/foo.ts",
      status: "modified" as const,
      additions: 5,
      deletions: 2,
      binary: false as const,
      hunks: [],
    },
  ],
};

const EMPTY_DIFF: DiffResult = {
  base: "main",
  baseRef: "origin/main",
  head: "shepherd/x",
  fetchFailed: false as const,
  truncated: false as const,
  files: [],
};

function buildSvc(opts: {
  store: FakeStore;
  herdr: FakeHerdr;
  onChange?: (id: string, recap: Recap | null) => void;
  env?: () => { provider: "claude" | "codex"; model: string | null; effort?: string | null };
  nowFn: () => number;
  headSha?: string;
  diff?: typeof NON_EMPTY_DIFF | typeof EMPTY_DIFF;
  /** Convenience: a parsed (strict) verdict object — wrapped as { status:"parsed", repaired:false }.
   *  Omit → { status:"absent" }. Use `verdictRead` for the repaired/unparseable statuses. */
  verdictJson?: unknown;
  verdictRead?: VerdictRead<unknown>;
  /**
   * A raw function override for readVerdict — called on EVERY tick instead of returning the
   * static `verdictRead`/`verdictJson` value. Use when you need stateful behavior (e.g.
   * throw-on-first-call, then succeed on second call).
   */
  readVerdictFn?: () => VerdictRead<unknown>;
  idleThresholdMs?: number;
  timeoutMs?: number;
  cleanup?: (d: string) => void;
  makeTmpDir?: () => string;
  readUsage?: () => Promise<any>;
  resolveBase?: (s: Session) => Promise<{ base: string; resolved: boolean }>;
  computeDiff?: (worktreePath: string, base: string, branch: string | null) => Promise<any>;
  currentBranch?: (worktreePath: string) => Promise<string | null>;
  headContainedInBase?: (
    worktreePath: string,
    baseRef: string,
  ) => Promise<"contained" | "not-contained" | "unknown">;
  landedWorkEvidence?: () => any;
}): RecapService {
  let tmpIdx = 0;
  return new RecapService({
    store: opts.store as any,
    herdr: opts.herdr as any,
    onChange: opts.onChange ?? (() => {}),
    env: opts.env ?? (() => ({ provider: "claude", model: "sonnet" })),
    now: opts.nowFn,
    idleThresholdMs: opts.idleThresholdMs ?? 120_000,
    timeoutMs: opts.timeoutMs ?? 300_000,
    headSha: async () => opts.headSha ?? "sha-head",
    resolveBase: opts.resolveBase,
    computeDiff: opts.computeDiff ?? (async () => (opts.diff ?? NON_EMPTY_DIFF) as any),
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: opts.readVerdictFn
      ? opts.readVerdictFn
      : (): VerdictRead<unknown> =>
          opts.verdictRead ??
          (opts.verdictJson !== undefined
            ? { status: "parsed", value: opts.verdictJson, repaired: false }
            : { status: "absent" }),
    readUsage: opts.readUsage ?? (async () => null),
    currentBranch: opts.currentBranch,
    headContainedInBase: opts.headContainedInBase,
    landedWorkEvidence: opts.landedWorkEvidence,
    makeTmpDir: opts.makeTmpDir ?? (() => `/tmp/recap-test-${++tmpIdx}`),
    cleanup: opts.cleanup ?? (() => {}),
  });
}

// ── sweep tests ───────────────────────────────────────────────────────────────

test("sweep: under threshold → no spawn", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let t = 50_000;
  const svc = buildSvc({ store, herdr, nowFn: () => t, idleThresholdMs: 120_000 });

  // First sweep: stamp set at 50_000; idleMs=0 → not settled
  await svc.sweep();
  expect(herdr.started.length).toBe(0);

  // Second sweep at 100_000: idleMs=50_000 < 120_000 → still not settled
  t = 100_000;
  await svc.sweep();
  expect(herdr.started.length).toBe(0);
});

test("sweep: status running → no spawn, clears debounce", async () => {
  const s = makeSession({ status: "running" });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  const svc = buildSvc({ store, herdr, nowFn: () => 300_000 });
  await svc.sweep();
  expect(herdr.started.length).toBe(0);
});

test("sweep: auto:true (drain) settled → no spawn", async () => {
  const s = makeSession({ status: "idle", auto: true });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let t = 100_000;
  const svc = buildSvc({ store, herdr, nowFn: () => t, idleThresholdMs: 120_000 });

  await svc.sweep(); // stamp set
  t = 300_000; // idleMs = 200_000 >= 120_000, but auto=true → skip
  await svc.sweep();
  expect(herdr.started.length).toBe(0);
});

test("sweep: attended settled + non-empty diff + no existing recap → spawns once", async () => {
  const s = makeSession({ status: "idle", auto: false });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let t = 100_000;
  const svc = buildSvc({ store, herdr, nowFn: () => t, idleThresholdMs: 120_000 });

  await svc.sweep(); // stamp set at 100_000
  expect(herdr.started.length).toBe(0);

  t = 230_000; // idleMs=130_000 >= 120_000 → generate
  await svc.sweep();
  expect(herdr.started.length).toBe(1);
  expect(herdr.started[0]!.label).toBe("recap TASK-01");
  expect(store.getRecap("s1")?.state).toBe("generating");
  expect(store.reviewerSpawns.length).toBe(1);
  expect(store.reviewerSpawns[0]!.kind).toBe("recap");
  expect(store.reviewerSpawns[0]!.taskSessionId).toBe("s1");
});

test("sweep idempotency: second sweep in same idle episode → no second spawn", async () => {
  const s = makeSession({ status: "idle", auto: false });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let t = 100_000;
  const svc = buildSvc({ store, herdr, nowFn: () => t, idleThresholdMs: 120_000 });

  await svc.sweep(); // stamp
  t = 230_000;
  await svc.sweep(); // fires
  expect(herdr.started.length).toBe(1);

  await svc.sweep(); // should NOT fire again
  expect(herdr.started.length).toBe(1);
});

test("sweep: empty diff → state 'empty', no spawn, onChange(id, null)", async () => {
  const s = makeSession({ status: "idle", auto: false });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  const changes: Array<[string, Recap | null]> = [];
  let t = 100_000;

  const svc = buildSvc({
    store,
    herdr,
    onChange: (id, recap) => changes.push([id, recap]),
    nowFn: () => t,
    idleThresholdMs: 120_000,
    diff: EMPTY_DIFF,
  });

  await svc.sweep(); // stamp
  t = 230_000;
  await svc.sweep(); // fire → empty diff

  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
  const lastChange = changes[changes.length - 1];
  expect(lastChange).toBeDefined();
  expect(lastChange![0]).toBe("s1");
  expect(lastChange![1]).toBeNull();
});

test("sweep: existing READY recap at headA; session re-activates then re-settles at headB → new spawn", async () => {
  const s = makeSession({ status: "idle", auto: false });
  const existingRecap = makeRecap({
    state: "ready",
    headSha: "sha-a",
    verdict: "ready",
    headline: "done",
    generatedAt: 500,
  });
  const store = makeStore([s], [existingRecap]);
  const herdr = makeHerdr();
  let t = 100_000;
  let currentHead = "sha-a";

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => t,
    idleThresholdMs: 120_000,
    headSha: undefined, // override via workaround
  });
  // Build with injectable headSha
  const svc2 = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => t,
    idleThresholdMs: 120_000,
    timeoutMs: 300_000,
    headSha: async () => currentHead,
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-headb",
    cleanup: () => {},
  });

  // First episode: settle at sha-a → existing recap matches, needsRecap = false
  await svc2.sweep(); // stamp
  t = 230_000;
  await svc2.sweep(); // fire → skip (headSha same as existing)
  expect(herdr.started.length).toBe(0);

  // Re-activate → clears debounce
  store.sessions[0] = makeSession({ status: "running" });
  await svc2.sweep();

  // New commit + re-settle
  currentHead = "sha-b";
  store.sessions[0] = makeSession({ status: "idle" });
  t = 300_000;
  await svc2.sweep(); // stamp
  t = 430_000;
  await svc2.sweep(); // fire → needsRecap(existingRecap, "sha-b") = true
  expect(herdr.started.length).toBe(1);
  void svc; // suppress unused var
});

// ── tick tests ────────────────────────────────────────────────────────────────

test("tick: generating row + valid verdict → state 'ready' + usage + stop + cleanup", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-s1",
    spawnSessionId: "sp1",
    spawnedAt: 100_000,
  });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-s1", terminalId: "t99" }]);
  const cleaned: string[] = [];
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
    nowFn: () => 200_000,
    timeoutMs: 300_000,
    verdictJson: VALID_VERDICT_JSON,
    readUsage: async () => fakeUsage,
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();

  const r = store.getRecap("s1");
  expect(r?.state).toBe("ready");
  expect(r?.verdict).toBe("ready");
  expect(r?.headline).toBe("All done");
  expect(r?.body).toContain("Fixed the bug");
  expect(r?.openItems).toEqual(["Write more tests"]);
  expect(store.completedSpawns.length).toBe(1);
  expect(store.completedSpawns[0]!.id).toBe("sp1");
  expect(herdr.stopped).toContain("t99");
  expect(cleaned).toContain("/tmp/recap-s1");
});

// TASK-561 follow-up: the #822 failsafe still left recap generation failing on retry. A chatty
// agent wraps the JSON in prose, jsonrepair rescues it into an ARRAY (["Here is the recap:", {…}]),
// and the OLD finalize → parseRecapVerdict rejected arrays → `failed`. The fix unwraps the recap
// object from that array, so the full tick→finalize path now finalizes `ready` end-to-end.
test("TASK-561 tick: prose-wrapped (jsonrepair array) verdict → state 'ready', not 'failed'", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-prose", spawnedAt: 100_000 });
  const store = makeStore([], [rec]);
  // Production: strict JSON.parse FAILS on prose-wrapped output, so the read is recovered via
  // jsonrepair (repaired:true) into the array shape — and a repaired parse is gated on the spawn
  // having finished (decideVerdictAction). Model that exactly: agent idle (finished) at the cwd.
  const herdr = makeHerdr([
    { cwd: "/tmp/recap-prose", terminalId: "t-prose", agentStatus: "idle" },
  ]);
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    timeoutMs: 300_000,
    // The array shape jsonrepair produces from prose-wrapped output, surfaced through the real
    // repaired-gated read path (repaired:true + finished spawn → finalize); the array recovery
    // itself lives in parseRecapVerdict.
    verdictRead: {
      status: "parsed",
      repaired: true,
      value: [
        "Here is the session recap:",
        {
          verdict: "needs-attention", // also exercises hyphen→underscore normalization
          headline: "Lightweight repo mode",
          body: 'Operator clicks "Open for merge".',
          openItems: ["Document the mode"],
          blocks: [{ type: "rich-text", id: "b1", markdown: "Local-only git." }],
        },
        "Let me know if you need anything else.",
      ],
    },
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();

  const r = store.getRecap("s1");
  expect(r?.state).toBe("ready");
  expect(r?.verdict).toBe("needs_attention");
  expect(r?.headline).toBe("Lightweight repo mode");
  expect(r?.body).toContain('"Open for merge"');
  expect(r?.openItems).toEqual(["Document the mode"]);
  expect(r?.blocks).toHaveLength(1);
  expect(cleaned).toContain("/tmp/recap-prose");
});

test("tick timeout: generating row, no verdict, past timeout → state 'failed', reaped", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-timeout",
    spawnSessionId: "sp2",
    spawnedAt: 1_000,
  });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-timeout", terminalId: "t-timeout" }]);
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 400_000, // spawnedAt=1_000, timeout=300_000 → timedOut
    timeoutMs: 300_000,
    verdictJson: null,
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("failed");
  expect(herdr.stopped).toContain("t-timeout");
  expect(cleaned).toContain("/tmp/recap-timeout");
});

test("tick no verdict logs Codex recap spawn context without prompt text", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-codex-timeout",
    spawnSessionId: "sp-codex",
    model: "gpt-5.3-codex",
    spawnedAt: 1_000,
  });
  const store = makeStore([], [rec]);
  store.reviewerSpawns.push({
    reviewerSessionId: "sp-codex",
    taskSessionId: "s1",
    kind: "recap",
    worktreePath: "/tmp/recap-codex-timeout",
    reviewerProvider: "codex",
    model: "gpt-5.3-codex",
    reviewerEffort: "high",
    spawnedAt: 1_000,
  });
  const herdr = makeHerdr([{ cwd: "/tmp/recap-codex-timeout", terminalId: "t-codex" }]);
  const warnings: string[] = [];
  const prevWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const svc = buildSvc({
      store,
      herdr,
      nowFn: () => 400_000,
      timeoutMs: 300_000,
      verdictRead: { status: "absent" },
    });

    await svc.tick();
  } finally {
    console.warn = prevWarn;
  }

  const msg = warnings.join("\n");
  expect(msg).toContain("spawn=sp-codex");
  expect(msg).toContain("cwd=/tmp/recap-codex-timeout");
  expect(msg).toContain("model=gpt-5.3-codex");
  expect(msg).toContain("provider=codex");
  expect(msg).toContain("effort=high");
  expect(msg).toContain("pane=present");
  expect(msg).not.toContain("do the thing");
});

test("tick unparseable: garbage verdict → state 'failed'", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-garbage", spawnedAt: 100_000 });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr();
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    timeoutMs: 300_000,
    verdictJson: { verdict: "not-a-valid-verdict", headline: 42 }, // invalid
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("failed");
  expect(cleaned).toContain("/tmp/recap-garbage");
});

// ── #822 fail-fast gate ──────────────────────────────────────────────────────
// A present-but-unparseable verdict whose spawn has FINISHED finalizes `failed` immediately,
// well before the 5-minute timeout (the bug: it used to wait out the full timeoutMs).
test("#822 tick fail-fast: unparseable + finished spawn → 'failed' before timeout", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-ff", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  // default ['zsh'] husk → isSpawnAlive=false → finished=true → fail-fast on unparseable.
  const herdr = makeHerdr([{ cwd: "/tmp/recap-ff", terminalId: "t-ff", agentStatus: "idle" }]);
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 5_000, // only 4s elapsed — NOWHERE near timeoutMs=300_000
    timeoutMs: 300_000,
    verdictRead: { status: "unparseable" },
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("failed"); // failed fast, not after 5 min
  expect(herdr.stopped).toContain("t-ff");
  expect(cleaned).toContain("/tmp/recap-ff");
});

// A repaired parse while the spawn is STILL WORKING must NOT be finalized — it could be a truncated
// partial write that jsonrepair closed up. Keep waiting; a later tick catches the complete write.
test("#822 tick gate: repaired + still-working → stays generating (not finalized)", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-rw", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-rw", terminalId: "t-rw", agentStatus: "working" }]);
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 5_000, // not timed out
    timeoutMs: 300_000,
    // a repaired-but-valid recap shape — would finalize 'ready' if the gate let it through.
    verdictRead: { status: "parsed", repaired: true, value: VALID_VERDICT_JSON },
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("generating"); // gated: still waiting
  expect(herdr.stopped).not.toContain("t-rw");
  expect(cleaned).not.toContain("/tmp/recap-rw");
});

// `absent` is the issue's out-of-scope "agent wrote nothing" class: even with a finished spawn it
// must NOT fail-fast — only the hard timeout finalizes a never-written file.
test("#822 tick gate: absent + finished spawn (not timed out) → stays generating", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-abs", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-abs", terminalId: "t-abs", agentStatus: "done" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 5_000, // not timed out
    timeoutMs: 300_000,
    verdictRead: { status: "absent" },
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("generating"); // not fail-fasted
  expect(herdr.stopped).not.toContain("t-abs");
});

// ── TASK-1021 process-liveness regressions (recap mirror) ───────────────────
// Mirrors the review regressions: a live-but-idle recap spawn must not be finalized-null;
// a genuine husk (shell-only) must still fast-fail. isSpawnAlive uses paneForegroundProcs.

test("[TASK-1021] recap: live-but-idle spawn past grace → stays generating, NOT finalized-null", async () => {
  // spawnedAt=1_000; nowFn returns 91_000 → elapsed=90s > STARTUP_GRACE_MS (60s)
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-live", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  // idle but with live procs → isSpawnAlive returns true → finished=false → wait
  const herdr = makeHerdr(
    [{ cwd: "/tmp/recap-live", terminalId: "t-live", paneId: "p-live", agentStatus: "idle" }],
    ["claude", "node-MainThread"], // defaultProcs: live critic
  );

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 91_000, // elapsed = 91000 - 1000 = 90s > STARTUP_GRACE_MS
    timeoutMs: 300_000,
    verdictRead: { status: "absent" },
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("generating"); // NOT finalized
  expect(herdr.stopped).not.toContain("t-live");
});

test("recap: husk (shell-only) past grace → finalize-null failed (fast-fail preserved)", async () => {
  // spawnedAt=1_000; nowFn returns 91_000 → elapsed=90s > STARTUP_GRACE_MS (60s)
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-husk", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  // shell-only pane → isSpawnAlive returns false → finished=true → finalize-null
  const herdr = makeHerdr(
    [{ cwd: "/tmp/recap-husk", terminalId: "t-husk", paneId: "p-husk", agentStatus: "idle" }],
    ["zsh"], // defaultProcs: shell-only husk
  );
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 91_000, // elapsed = 91000 - 1000 = 90s > STARTUP_GRACE_MS
    timeoutMs: 300_000,
    verdictRead: { status: "absent" },
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("failed"); // finalize-null: fast-fail preserved
  expect(herdr.stopped).toContain("t-husk");
  expect(cleaned).toContain("/tmp/recap-husk");
});

// Overlapping-ticks regression: second concurrent tick must not double-finalize the same entry.
test("recap overlapping ticks: second tick skips entry claimed by first tick", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-overlap", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr(); // no panes → not in list → dead → finished=true; strict parse finalizes
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    timeoutMs: 300_000,
    verdictJson: VALID_VERDICT_JSON, // strict parse → finalize-value regardless of spawnFinished
    cleanup: (d) => cleaned.push(d),
  });

  // Fire two ticks concurrently: tick1 claims finalizing before its first await; tick2 skips.
  const tick1 = svc.tick();
  const tick2 = svc.tick();
  await Promise.all([tick1, tick2]);
  // Exactly one finalize: state is 'ready' (not 'failed'), cleanup called once
  expect(store.getRecap("s1")?.state).toBe("ready");
  expect(cleaned.filter((d) => d === "/tmp/recap-overlap")).toHaveLength(1);
});

// Throw-after-claim regression: if readVerdict throws after the finalizing Set.add(),
// the flag must be released so the next tick retries (no wedge/leak).
test("recap throw-after-claim: finalizing flag released on readVerdict throw → next tick succeeds", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-throw", spawnedAt: 1_000 });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr();
  let callCount = 0;

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    timeoutMs: 300_000,
    readVerdictFn: () => {
      callCount++;
      if (callCount === 1) throw new Error("transient read error");
      return { status: "parsed", value: VALID_VERDICT_JSON, repaired: false };
    },
  });

  // First tick: readVerdict throws → flag released, stays generating
  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("generating"); // not finalized
  // Second tick: succeeds → finalizes
  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("ready");
});

test("tick restart-safety: generating row in DB, no in-memory state → finalizes", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-restart",
    spawnedAt: 100_000,
  });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr();
  const cleaned: string[] = [];

  // Fresh service — no prior state
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    timeoutMs: 300_000,
    verdictJson: VALID_VERDICT_JSON,
    cleanup: (d) => cleaned.push(d),
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("ready");
  expect(cleaned).toContain("/tmp/recap-restart");
});

// ── regenerate tests ──────────────────────────────────────────────────────────

test("regenerate: forces spawn even for auto:true (drain)", async () => {
  const s = makeSession({ auto: true, status: "done" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    makeTmpDir: () => "/tmp/recap-auto",
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("started");
  expect(herdr.started.length).toBe(1);
  expect(store.getRecap("s1")?.state).toBe("generating");
});

// ── api-key auth-mode wiring ────────────────────────────────────────────────

test("generate: subscription mode — --settings unchanged + no env 4th arg", async () => {
  await withAuth("subscription", "/ignored.sh", async () => {
    const s = makeSession({ status: "idle" });
    const herdr = makeHerdr();
    const svc = buildSvc({
      store: makeStore([s]),
      herdr,
      nowFn: () => 1,
      makeTmpDir: () => "/tmp/r",
    });
    await svc.regenerate(s);
    const argv = herdr.started[0]!.argv;
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true });
    expect(herdr.started[0]!.env).toBeUndefined();
  });
});

test("generate: codex provider spawns headless `codex exec` (no claude flags)", async () => {
  const s = makeSession({ status: "idle" });
  const herdr = makeHerdr();
  const store = makeStore([s]);
  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 1,
    makeTmpDir: () => "/tmp/r",
    env: () => ({ provider: "codex", model: "gpt-5.5", effort: "high" }),
  });
  await svc.regenerate(s);
  const argv = herdr.started[0]!.argv;
  expect(argv.slice(0, 6)).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.5",
  ]);
  expect(argv).not.toContain("--settings");
  expect(argv).not.toContain("--allowedTools");
  expect(argv).not.toContain("--permission-mode");
  expect(argv[argv.length - 1]).toContain("`.shepherd-recap.json`");
  expect(store.reviewerSpawns[0]).toMatchObject({
    kind: "recap",
    reviewerProvider: "codex",
    reviewerEffort: "high",
  });
});

test("generate: threads env.effort into the recap argv (issue #1418)", async () => {
  const s = makeSession({ status: "idle" });
  const herdr = makeHerdr();
  const svc = buildSvc({
    store: makeStore([s]),
    herdr,
    nowFn: () => 1,
    makeTmpDir: () => "/tmp/r",
    env: () => ({ provider: "claude", model: "sonnet", effort: "high" }),
  });
  await svc.regenerate(s);
  const argv = herdr.started[0]!.argv;
  expect(argv).toContain("--effort");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
});

test("generate: emits no --effort when env.effort is null/absent (issue #1418)", async () => {
  const s = makeSession({ status: "idle" });
  const herdr = makeHerdr();
  const svc = buildSvc({
    store: makeStore([s]),
    herdr,
    nowFn: () => 1,
    makeTmpDir: () => "/tmp/r",
  });
  await svc.regenerate(s);
  expect(herdr.started[0]!.argv).not.toContain("--effort");
});

test("generate: api-key mode — apiKeyHelper in --settings + CLAUDE_CONFIG_DIR env", async () => {
  await withAuth("api-key", "/helper.sh", async () => {
    const s = makeSession({ status: "idle" });
    const herdr = makeHerdr();
    const svc = buildSvc({
      store: makeStore([s]),
      herdr,
      nowFn: () => 1,
      makeTmpDir: () => "/tmp/r",
    });
    await svc.regenerate(s);
    const argv = herdr.started[0]!.argv;
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.apiKeyHelper).toBe("/helper.sh");
    expect(Object.keys(herdr.started[0]!.env!)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });
});

// ─── operator-language: per-spawn read, not frozen at construction (Task 5, issue #1586) ────

test("generate: reads operatorLanguage per spawn, not cached at construction", async () => {
  const s = makeSession({ status: "idle" });
  const herdr = makeHerdr();
  const store = makeStore([s]);
  let lang: "en" | "de" = "en";
  let callCount = 0;

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    operatorLanguage: () => {
      callCount++;
      return lang;
    },
    now: () => 1,
    timeoutMs: 300_000,
    headSha: async () => "sha-head",
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    makeTmpDir: () => "/tmp/r1",
    cleanup: () => {},
  });

  // First generation, still "en": getter invoked, prompt carries no German marker.
  await svc.regenerate(s);
  expect(callCount).toBe(1);
  const firstPrompt = herdr.started[0]!.argv.at(-1)!;
  expect(firstPrompt).not.toContain("German");

  // Flip the live setting, then drive a second generation on the SAME service instance —
  // a construction-frozen value would never see this change.
  lang = "de";
  const svc2 = svc; // same instance, reused deliberately
  await svc2.regenerate(s);
  expect(callCount).toBe(2);
  const secondPrompt = herdr.started[1]!.argv.at(-1)!;
  expect(secondPrompt).toContain("German");
});

test("generate: api-key without a configured key fails closed → 'error', no spawn", async () => {
  await withAuth("api-key", null, async () => {
    const s = makeSession({ status: "idle" });
    const herdr = makeHerdr();
    const svc = buildSvc({
      store: makeStore([s]),
      herdr,
      nowFn: () => 1,
      makeTmpDir: () => "/tmp/r",
    });
    expect(await svc.regenerate(s)).toBe("error");
    expect(herdr.started.length).toBe(0);
  });
});

test("regenerate: replaces an existing ready row", async () => {
  const s = makeSession({ status: "idle" });
  const existingRecap = makeRecap({
    state: "ready",
    headSha: "sha-old",
    verdict: "ready",
    headline: "old",
    generatedAt: 500,
  });
  const store = makeStore([s], [existingRecap]);
  const herdr = makeHerdr();
  const cleaned: string[] = [];

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => "sha-new",
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-regen",
    cleanup: (d) => cleaned.push(d),
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("started");
  expect(herdr.started.length).toBe(1);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("generating");
  expect(r?.headSha).toBe("sha-new");
});

test("regenerate: empty diff returns 'empty'", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    makeTmpDir: () => "/tmp/recap-empty2",
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
});

test("generate/regenerate: herdr.start throws → returns 'error', no row, tmpdir cleaned", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const cleaned: string[] = [];

  // herdr that throws on start
  const herdr: FakeHerdr = {
    started: [],
    stopped: [],
    livePanes: [],
    procsOverride: new Map(),
    defaultProcs: ["zsh"],
    start: async () => {
      throw new Error("herdr start failed");
    },
    stop: async (id) => void herdr.stopped.push(id),
    list: () => herdr.livePanes,
    paneForegroundProcs: async (paneId: string) =>
      herdr.procsOverride.get(paneId) ?? herdr.defaultProcs,
  };

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    cleanup: (d) => cleaned.push(d),
    makeTmpDir: () => "/tmp/recap-error-test",
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("error");
  expect(store.getRecap("s1")).toBeNull();
  expect(cleaned).toContain("/tmp/recap-error-test");
});

test("in-flight guard: second generate call for same session mid-await does not double-spawn", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  // Use a promise to stall computeDiff so we can fire the second generate while first is awaiting
  let resolveDiff!: (v: typeof NON_EMPTY_DIFF) => void;
  const diffPromise = new Promise<typeof NON_EMPTY_DIFF>((res) => {
    resolveDiff = res;
  });

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => "sha-head",
    computeDiff: async () => diffPromise as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-inflight",
    cleanup: () => {},
  });

  // Start first generate — will stall at computeDiff
  const p1 = svc.generate(s);

  // Immediately fire second generate for same session — should return "started" without spawning
  const p2 = svc.generate(s);

  // Now resolve the diff so the first call can complete
  resolveDiff(NON_EMPTY_DIFF);

  const [r1, r2] = await Promise.all([p1, p2]);

  // First call should have spawned, second should have been blocked by the guard
  expect(r1).toBe("started");
  expect(r2).toBe("started"); // guard returns "started" immediately
  expect(herdr.started.length).toBe(1); // only ONE spawn happened
});

// ── changedFiles capture ────────────────────────────────────────────────────────

test("generate: non-empty diff → generating row captures changedFiles", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    makeTmpDir: () => "/tmp/recap-changed",
  });

  const result = await svc.generate(s);
  expect(result).toBe("started");
  const r = store.getRecap("s1");
  expect(r?.state).toBe("generating");
  expect(r?.changedFiles).toEqual(["src/foo.ts"]); // from NON_EMPTY_DIFF
});

test("generate: empty diff → empty row has changedFiles = []", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    makeTmpDir: () => "/tmp/recap-changed-empty",
  });

  const result = await svc.generate(s);
  expect(result).toBe("empty");
  const r = store.getRecap("s1");
  expect(r?.state).toBe("empty");
  expect(r?.changedFiles).toEqual([]);
});

test("generate: empty diff + contained head without landed evidence stays empty", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "contained",
  });

  await expect(svc.generate(s)).resolves.toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
});

test("generate: empty diff + contained head with landed evidence starts visible recap", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "contained",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12" }),
  });

  await expect(svc.generate(s)).resolves.toBe("started");
  expect(herdr.started.length).toBe(1);
  expect(herdr.started[0]!.argv.at(-1)).toContain("already contained in the resolved base");
  expect(herdr.started[0]!.argv.at(-1)).toContain("merged PR #12");
  expect(store.getRecap("s1")?.state).toBe("generating");
});

test("generate: empty diff + landed evidence + fetch failure becomes visible failed diagnostic", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: { ...EMPTY_DIFF, fetchFailed: true },
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "contained",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12", pr: 12 }),
  });

  await expect(svc.generate(s)).resolves.toBe("error");
  expect(herdr.started.length).toBe(0);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("failed");
  // Coded skip (#1628): no baked English prose — the UI renders per-locale from code + typed params
  // (evidence kind + PR number, never the English `summary`).
  expect(r?.body).toBe("");
  expect(r?.skip).toEqual({
    code: "base-refresh-failed",
    params: { evidenceKind: "merged_pr", evidencePr: 12 },
  });
});

test("generate: empty diff + fetch failure without landed evidence stays empty", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: { ...EMPTY_DIFF, fetchFailed: true },
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "contained",
  });

  await expect(svc.generate(s)).resolves.toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
});

test("generate: empty diff + branch mismatch becomes visible metadata failure", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/other",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12" }),
  });

  await expect(svc.generate(s)).resolves.toBe("error");
  expect(herdr.started.length).toBe(0);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("failed");
  // Coded skip (#1628): branch identifiers pass through as typed params, no baked prose.
  expect(r?.body).toBe("");
  expect(r?.skip).toEqual({
    code: "metadata-mismatch",
    params: { branch: "shepherd/x", current: "shepherd/other" },
  });
});

test("generate: empty diff + not-contained ancestry without evidence stays empty", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "not-contained",
  });

  await expect(svc.generate(s)).resolves.toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
});

test("generate: empty diff + unknown ancestry with landed evidence becomes visible failed diagnostic", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "unknown",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12" }),
  });

  await expect(svc.generate(s)).resolves.toBe("error");
  expect(herdr.started.length).toBe(0);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("failed");
  // Coded skip (#1628): merged_pr evidence WITHOUT a pr number → no evidencePr param (UI renders
  // "merged PR", never "#undefined"); baseRef passes through.
  expect(r?.body).toBe("");
  expect(r?.skip).toEqual({
    code: "ancestry-check-failed",
    params: { evidenceKind: "merged_pr", baseRef: "origin/main" },
  });
});

test("generate: empty diff + not-contained ancestry with evidence → empty-diff-contradicted skip", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "not-contained",
    landedWorkEvidence: () => ({ kind: "review", summary: "PR review recorded for this head" }),
  });

  await expect(svc.generate(s)).resolves.toBe("error");
  expect(herdr.started.length).toBe(0);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("failed");
  // The fourth skip code; `review` evidence carries no PR number.
  expect(r?.body).toBe("");
  expect(r?.skip).toEqual({
    code: "empty-diff-contradicted",
    params: { evidenceKind: "review", baseRef: "origin/main" },
  });
});

test("generate: empty diff + unknown ancestry without evidence stays empty", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => "shepherd/x",
    headContainedInBase: async () => "unknown",
  });

  await expect(svc.generate(s)).resolves.toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
});

test("generate: empty diff + null current branch without evidence stays empty", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => null,
    headContainedInBase: async () => "contained",
  });

  await expect(svc.generate(s)).resolves.toBe("empty");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.state).toBe("empty");
});

test("generate: empty diff + null current branch with landed evidence can start recap", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => null,
    headContainedInBase: async () => "contained",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12" }),
  });

  await expect(svc.generate(s)).resolves.toBe("started");
  expect(herdr.started.length).toBe(1);
  expect(store.getRecap("s1")?.state).toBe("generating");
});

test("generate: empty diff + null current branch + landed evidence + fetch failure fails as stale base", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: { ...EMPTY_DIFF, fetchFailed: true },
    currentBranch: async () => null,
    headContainedInBase: async () => "contained",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12" }),
  });

  await expect(svc.generate(s)).resolves.toBe("error");
  expect(herdr.started.length).toBe(0);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("failed");
  expect(r?.body).toBe("");
  expect(r?.skip).toEqual({
    code: "base-refresh-failed",
    params: { evidenceKind: "merged_pr" },
  });
});

test("generate: empty diff + null current branch + landed evidence + unknown ancestry fails as uncertain", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    diff: EMPTY_DIFF,
    currentBranch: async () => null,
    headContainedInBase: async () => "unknown",
    landedWorkEvidence: () => ({ kind: "merged_pr", summary: "merged PR #12" }),
  });

  await expect(svc.generate(s)).resolves.toBe("error");
  expect(herdr.started.length).toBe(0);
  const r = store.getRecap("s1");
  expect(r?.state).toBe("failed");
  expect(r?.body).toBe("");
  expect(r?.skip).toEqual({
    code: "ancestry-check-failed",
    params: { evidenceKind: "merged_pr", baseRef: "origin/main" },
  });
});

// ── considerForArchive tests ──────────────────────────────────────────────────────

test("considerForArchive: existing recap at current head → 'skip', no spawn", async () => {
  const s = makeSession({ status: "done" });
  const existingRecap = makeRecap({ state: "ready", headSha: "sha-head", verdict: "ready" });
  const store = makeStore([s], [existingRecap]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    headSha: "sha-head",
  });

  const result = await svc.considerForArchive(s);
  expect(result).toBe("skip");
  expect(herdr.started.length).toBe(0);
});

test("considerForArchive: no existing recap → generates", async () => {
  const s = makeSession({ status: "done" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    headSha: "sha-head",
    makeTmpDir: () => "/tmp/recap-archive-gen",
  });

  const result = await svc.considerForArchive(s);
  expect(result).toBe("started");
  expect(herdr.started.length).toBe(1);
  expect(store.getRecap("s1")?.state).toBe("generating");
});

test("considerForArchive: auto:true (drain) with no recap → generates (NOT skipped)", async () => {
  const s = makeSession({ status: "done", auto: true });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    headSha: "sha-head",
    makeTmpDir: () => "/tmp/recap-archive-auto",
  });

  const result = await svc.considerForArchive(s);
  expect(result).toBe("started"); // key difference from considerSession: auto is NOT skipped
  expect(herdr.started.length).toBe(1);
  expect(store.getRecap("s1")?.state).toBe("generating");
});

test("considerForArchive: headSha throws → 'error', no throw, no spawn", async () => {
  const s = makeSession({ status: "done" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => {
      throw new Error("worktree gone");
    },
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-archive-err",
    cleanup: () => {},
  });

  const result = await svc.considerForArchive(s);
  expect(result).toBe("error");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")).toBeNull();
});

// ── onArchived tests ──────────────────────────────────────────────────────────────

test("onArchived: keeps in-flight generating row (no reap, no drop)", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-onarchived",
    spawnSessionId: "sp-oa",
  });
  const store = makeStore([], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-onarchived", terminalId: "t-oa" }]);
  const cleaned: string[] = [];

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    cleanup: (d) => cleaned.push(d),
  });

  svc.onArchived("s1");

  // Row persists for the Done lens; spawn allowed to finish (no stop, no cleanup, no drop).
  expect(store.getRecap("s1")).not.toBeNull();
  expect(store.getRecap("s1")?.state).toBe("generating");
  expect(herdr.stopped).not.toContain("t-oa");
  expect(cleaned).not.toContain("/tmp/recap-onarchived");
});

test("onArchived: clears debounce so a later re-stamp is clean", async () => {
  const s = makeSession({ status: "idle", auto: false });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let t = 100_000;
  const svc = buildSvc({ store, herdr, nowFn: () => t, idleThresholdMs: 120_000 });

  await svc.sweep(); // stamp set at 100_000
  svc.onArchived("s1"); // clears the debounce entry

  // Re-stamp: a single settled sweep right after the clear should NOT fire (needs a
  // fresh debounce window), proving the entry was cleared (no stale stamp survived).
  t = 110_000;
  await svc.sweep(); // re-stamp at 110_000, idleMs=0 → no spawn
  expect(herdr.started.length).toBe(0);

  t = 240_000; // idleMs from 110_000 = 130_000 >= threshold → now fires
  await svc.sweep();
  expect(herdr.started.length).toBe(1);
});

// ── git/diff failure self-heals to "error" (must NOT throw out of bare-void sweep) ──

test("generate: computeDiff rejection → 'error', no throw, no row", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  const cleaned: string[] = [];

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => "sha-head",
    computeDiff: async () => {
      throw new Error("git diff exceeded maxBuffer");
    },
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-diff-fail",
    cleanup: (d) => cleaned.push(d),
  });

  const result = await svc.generate(s); // must resolve, not reject
  expect(result).toBe("error");
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")).toBeNull(); // no row left → a later settle can retry
});

test("regenerate: headSha rejection → 'error', no throw", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => {
      throw new Error("rev-parse failed");
    },
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-head-fail",
    cleanup: () => {},
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("error");
  expect(herdr.started.length).toBe(0);
});

test("considerSession: headSha failure leaves fired=false so next sweep retries", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let t = 0;
  let failHead = true;

  const svc = new RecapService({
    store: store as any,
    herdr: herdr as any,
    onChange: () => {},
    env: () => ({ provider: "claude", model: "sonnet" }),
    now: () => t,
    idleThresholdMs: 120_000,
    timeoutMs: 300_000,
    headSha: async () => {
      if (failHead) throw new Error("transient git failure");
      return "sha-head";
    },
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: (): VerdictRead<unknown> => ({ status: "absent" }),
    readUsage: async () => null,
    makeTmpDir: () => "/tmp/recap-retry",
    cleanup: () => {},
  });

  t = 0;
  await svc.sweep(); // stamp set
  t = 200_000;
  await svc.sweep(); // settled → headSha throws → no spawn, fired stays false
  expect(herdr.started.length).toBe(0);

  failHead = false;
  t = 400_000;
  await svc.sweep(); // retries headSha (fired was not burned) → spawns
  expect(herdr.started.length).toBe(1);
});

// ── visual block grounding (Task 4) ──────────────────────────────────────────

const VERDICT_WITH_BLOCKS = {
  verdict: "ready",
  headline: "All done",
  body: "## Summary\nFixed it.",
  openItems: [],
  blocks: [
    { type: "diff", id: "d1", path: "src/foo.ts", summary: "updated foo" },
    {
      type: "file-tree",
      id: "ft1",
      entries: [
        { path: "src/foo.ts", change: "modified" },
        { path: "invented.ts", change: "added" }, // not in diff → dropped by reconcile
      ],
    },
    { type: "callout", id: "c1", tone: "info", markdown: "note" },
  ],
};

test("generate: stashes pendingDiff after spawn", async () => {
  const s = makeSession({ status: "idle" });
  const store = makeStore([s]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    makeTmpDir: () => "/tmp/recap-stash",
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("started");
  // setRecapPendingDiff called with the diff's files (non-empty)
  expect(store.pendingDiffs["s1"]).toEqual(NON_EMPTY_DIFF.files);
});

test("finalize: joins + persists grounded blocks (carrier present)", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-ground",
    spawnSessionId: "sp1",
    spawnedAt: 100_000,
    changedFiles: ["src/foo.ts"],
  });
  const store = makeStore([], [rec]);
  // Simulate carrier stashed by generate
  store.pendingDiffs["s1"] = NON_EMPTY_DIFF.files;

  const herdr = makeHerdr([{ cwd: "/tmp/recap-ground", terminalId: "t1" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    verdictJson: VERDICT_WITH_BLOCKS,
    cleanup: () => {},
  });

  await svc.tick();

  const r = store.getRecap("s1");
  expect(r?.state).toBe("ready");
  const blocks = r?.blocks ?? [];
  // diff block joined with real file
  const diffBlk = blocks.find((b) => b.type === "diff");
  expect(diffBlk).toBeDefined();
  if (diffBlk?.type === "diff") expect(diffBlk.file).toBeDefined();
  // file-tree reconciled: invented.ts dropped, src/foo.ts kept
  const ftBlk = blocks.find((b) => b.type === "file-tree");
  expect(ftBlk).toBeDefined();
  if (ftBlk?.type === "file-tree") {
    expect(ftBlk.entries.every((e) => e.path !== "invented.ts")).toBe(true);
    expect(ftBlk.entries.some((e) => e.path === "src/foo.ts")).toBe(true);
  }
  // callout present
  expect(blocks.some((b) => b.type === "callout")).toBe(true);
});

test("finalize: broadcast NO-LEAK — onChange receives no pendingDiff key", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-noleak",
    spawnSessionId: "sp2",
    spawnedAt: 100_000,
    changedFiles: ["src/foo.ts"],
  });
  const store = makeStore([], [rec]);
  store.pendingDiffs["s1"] = NON_EMPTY_DIFF.files;
  const herdr = makeHerdr([{ cwd: "/tmp/recap-noleak", terminalId: "t2" }]);

  let broadcastRow: Recap | null = null;
  const svc = buildSvc({
    store,
    herdr,
    onChange: (_id, r) => {
      broadcastRow = r;
    },
    nowFn: () => 200_000,
    verdictJson: VERDICT_WITH_BLOCKS,
    cleanup: () => {},
  });

  await svc.tick();

  expect(broadcastRow).not.toBeNull();
  const broadcastRowNonNull = broadcastRow!;
  expect("pendingDiff" in (broadcastRowNonNull as unknown as object)).toBe(false);
  const persisted = store.getRecap("s1");
  expect(persisted).not.toBeNull();
  expect("pendingDiff" in (persisted as object)).toBe(false);
});

test("finalize: carrier cleared on ready path", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-clear-ready",
    spawnSessionId: "sp3",
    spawnedAt: 100_000,
    changedFiles: ["src/foo.ts"],
  });
  const store = makeStore([], [rec]);
  store.pendingDiffs["s1"] = NON_EMPTY_DIFF.files;
  const herdr = makeHerdr([{ cwd: "/tmp/recap-clear-ready", terminalId: "t3" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    verdictJson: VERDICT_WITH_BLOCKS,
    cleanup: () => {},
  });

  await svc.tick();
  expect(store.pendingDiffs["s1"]).toEqual([]);
});

test("finalize: carrier cleared on failed path", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-clear-fail",
    spawnSessionId: "sp4",
    spawnedAt: 100_000,
    changedFiles: ["src/foo.ts"],
  });
  const store = makeStore([], [rec]);
  store.pendingDiffs["s1"] = NON_EMPTY_DIFF.files;
  const herdr = makeHerdr([{ cwd: "/tmp/recap-clear-fail", terminalId: "t4" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    verdictJson: { verdict: "not-valid", headline: 42 }, // unparseable
    cleanup: () => {},
  });

  await svc.tick();
  expect(store.getRecap("s1")?.state).toBe("failed");
  expect(store.pendingDiffs["s1"]).toEqual([]);
});

test("finalize: manual steps injected as a checklist block on the ready path (#1059)", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-ms-ready", spawnedAt: 100_000 });
  const session = makeSession({
    manualSteps: [
      { id: "ms1", text: "Set FLAG=1 in prod", postMerge: false },
      { id: "ms2", text: "rotate webhook secret", postMerge: true },
    ],
  });
  const store = makeStore([session], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-ms-ready", terminalId: "tm1" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    verdictJson: { verdict: "ready", headline: "ok", body: "done", openItems: [] },
    cleanup: () => {},
  });

  await svc.tick();
  const saved = store.getRecap("s1");
  expect(saved?.state).toBe("ready");
  expect(saved?.blocks?.[0]).toEqual({
    type: "checklist",
    id: "manual-steps",
    items: [
      { id: "ms1", label: "Set FLAG=1 in prod" },
      { id: "ms2", label: "rotate webhook secret", note: "POST-MERGE" },
    ],
  });
});

test("finalize: manual steps survive the FAILED path too (#1059)", async () => {
  const rec = makeRecap({ state: "generating", cwd: "/tmp/recap-ms-fail", spawnedAt: 100_000 });
  const session = makeSession({
    manualSteps: [{ id: "ms1", text: "run the backfill once", postMerge: false }],
  });
  const store = makeStore([session], [rec]);
  const herdr = makeHerdr([{ cwd: "/tmp/recap-ms-fail", terminalId: "tm2" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    verdictJson: { verdict: "not-valid", headline: 42 }, // unparseable → failed
    cleanup: () => {},
  });

  await svc.tick();
  const saved = store.getRecap("s1");
  expect(saved?.state).toBe("failed");
  expect(saved?.blocks).toEqual([
    {
      type: "checklist",
      id: "manual-steps",
      items: [{ id: "ms1", label: "run the backfill once" }],
    },
  ]);
});

test("finalize: empty carrier fail-closed — diff dropped, file-tree filtered, callout kept", async () => {
  const rec = makeRecap({
    state: "generating",
    cwd: "/tmp/recap-failclosed",
    spawnSessionId: "sp5",
    spawnedAt: 100_000,
    changedFiles: ["src/foo.ts"],
  });
  const store = makeStore([], [rec]);
  // Carrier empty (simulates server bounce before finalize)
  store.pendingDiffs["s1"] = [];
  const herdr = makeHerdr([{ cwd: "/tmp/recap-failclosed", terminalId: "t5" }]);

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    verdictJson: VERDICT_WITH_BLOCKS,
    cleanup: () => {},
  });

  await svc.tick();

  const r = store.getRecap("s1");
  expect(r?.state).toBe("ready");
  const blocks = r?.blocks ?? [];
  // diff dropped (no real hunks)
  expect(blocks.some((b) => b.type === "diff")).toBe(false);
  // file-tree kept: src/foo.ts is in changedFiles; invented.ts filtered out
  const ftBlk = blocks.find((b) => b.type === "file-tree");
  expect(ftBlk).toBeDefined();
  if (ftBlk?.type === "file-tree") {
    expect(ftBlk.entries.every((e) => e.path !== "invented.ts")).toBe(true);
    expect(ftBlk.entries.some((e) => e.path === "src/foo.ts")).toBe(true);
  }
  // callout passes through
  expect(blocks.some((b) => b.type === "callout")).toBe(true);
});

// ── base resolution (PR base, not stored baseBranch) ───────────────────────────────

test("generate: diffs against the resolved PR base and persists it (not session.baseBranch)", async () => {
  const s = makeSession({ status: "done", baseBranch: "dev" }); // stored default, but PR targets main
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let diffedBase: string | undefined;

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    headSha: "sha-head",
    makeTmpDir: () => "/tmp/recap-base-gen",
    resolveBase: async () => ({ base: "main", resolved: true }),
    computeDiff: async (_wt, base) => {
      diffedBase = base;
      return NON_EMPTY_DIFF;
    },
  });

  const result = await svc.generate(s);
  expect(result).toBe("started");
  expect(diffedBase).toBe("main"); // diffed against the PR base, not "dev"
  expect(store.getRecap("s1")?.base).toBe("main"); // persisted on the generating row
});

test("regenerate: resolves the PR base inside generate() despite bypassing dedup", async () => {
  // regenerate() bypasses needsRecap and calls generate(session) with no knownBase — so generate
  // MUST resolve the base itself, else a forced regenerate re-bakes the stale base.
  const s = makeSession({ status: "done", baseBranch: "dev" });
  const store = makeStore([s]);
  const herdr = makeHerdr();
  let diffedBase: string | undefined;

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    makeTmpDir: () => "/tmp/recap-base-regen",
    resolveBase: async () => ({ base: "main", resolved: true }),
    computeDiff: async (_wt, base) => {
      diffedBase = base;
      return NON_EMPTY_DIFF;
    },
  });

  const result = await svc.regenerate(s);
  expect(result).toBe("started");
  expect(diffedBase).toBe("main");
  expect(store.getRecap("s1")?.base).toBe("main");
});

test("considerForArchive: same head but PR base now resolvable → regenerates (not 'skip')", async () => {
  // A recap baked against the old base "dev" at this HEAD; the PR's real base "main" is now known.
  const s = makeSession({ status: "done", baseBranch: "dev" });
  const stale = makeRecap({ state: "ready", headSha: "sha-head", base: "dev", verdict: "ready" });
  const store = makeStore([s], [stale]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    headSha: "sha-head",
    makeTmpDir: () => "/tmp/recap-base-rearchive",
    resolveBase: async () => ({ base: "main", resolved: true }),
  });

  const result = await svc.considerForArchive(s);
  expect(result).toBe("started"); // base changed + resolved → regenerate despite same HEAD
  expect(store.getRecap("s1")?.base).toBe("main");
});

test("considerForArchive: same head, base change only via transient fallback → 'skip' (no thrash)", async () => {
  const s = makeSession({ status: "done", baseBranch: "dev" });
  const existing = makeRecap({
    state: "ready",
    headSha: "sha-head",
    base: "main",
    verdict: "ready",
  });
  const store = makeStore([s], [existing]);
  const herdr = makeHerdr();

  const svc = buildSvc({
    store,
    herdr,
    nowFn: () => 200_000,
    headSha: "sha-head",
    // on-demand resolution failed → non-authoritative fallback to baseBranch "dev"
    resolveBase: async () => ({ base: "dev", resolved: false }),
  });

  const result = await svc.considerForArchive(s);
  expect(result).toBe("skip"); // resolved:false must NOT flip the dedup key
  expect(herdr.started.length).toBe(0);
  expect(store.getRecap("s1")?.base).toBe("main"); // untouched
});
