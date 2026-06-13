import { expect, test } from "bun:test";
import { RecapService } from "../src/recap";
import type { Recap, Session } from "../src/types";
import type { ActivityEntry } from "../src/activity";

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
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    research: false,
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
    ...over,
  };
}

function makeRecap(over: Partial<Recap> = {}): Recap {
  return {
    sessionId: "s1",
    state: "generating",
    headSha: "sha-a",
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
  getRecap: (id: string) => Recap | null;
  putRecap: (r: Recap) => void;
  snapshotRecaps: () => Record<string, Recap>;
  generatingRecaps: () => Recap[];
  dropRecap: (id: string) => void;
  getReview: (id: string) => null;
  recordReviewerSpawn: (r: any) => void;
  completeReviewerSpawn: (id: string, u: any, at: number) => void;
  list: (opts?: { activeOnly?: boolean }) => Session[];
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
    getRecap: (id) => store.recaps[id] ?? null,
    putRecap: (r) => {
      store.recaps[r.sessionId] = r;
      store.generatingRows = Object.values(store.recaps).filter((x) => x.state === "generating");
    },
    snapshotRecaps: () => ({ ...store.recaps }),
    generatingRecaps: () => store.generatingRows,
    dropRecap: (id) => {
      delete store.recaps[id];
      store.generatingRows = store.generatingRows.filter((r) => r.sessionId !== id);
    },
    getReview: () => null,
    recordReviewerSpawn: (r: any) => store.reviewerSpawns.push(r),
    completeReviewerSpawn: (id: string, u: any, at: number) =>
      store.completedSpawns.push({ id, u, at }),
    list: () => store.sessions,
  };
  return store;
}

type FakePaneEntry = { cwd: string; terminalId: string };

type FakeHerdr = {
  started: { label: string; cwd: string; argv: string[] }[];
  stopped: string[];
  livePanes: FakePaneEntry[];
  start: (label: string, cwd: string, argv: string[]) => { terminalId: string };
  stop: (id: string) => void;
  list: () => FakePaneEntry[];
};

function makeHerdr(livePanes: FakePaneEntry[] = []): FakeHerdr {
  const h: FakeHerdr = {
    started: [],
    stopped: [],
    livePanes,
    start: (label, cwd, argv) => {
      const tid = `tid-${h.started.length + 1}`;
      h.started.push({ label, cwd, argv });
      h.livePanes.push({ cwd, terminalId: tid });
      return { terminalId: tid };
    },
    stop: (id) => h.stopped.push(id),
    list: () => h.livePanes,
  };
  return h;
}

const NON_EMPTY_DIFF = {
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

const EMPTY_DIFF = {
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
  nowFn: () => number;
  headSha?: string;
  diff?: typeof NON_EMPTY_DIFF | typeof EMPTY_DIFF;
  verdictJson?: unknown | null;
  idleThresholdMs?: number;
  timeoutMs?: number;
  cleanup?: (d: string) => void;
  makeTmpDir?: () => string;
  readUsage?: () => Promise<any>;
}): RecapService {
  let tmpIdx = 0;
  return new RecapService({
    store: opts.store as any,
    herdr: opts.herdr as any,
    onChange: opts.onChange ?? (() => {}),
    model: "sonnet",
    now: opts.nowFn,
    idleThresholdMs: opts.idleThresholdMs ?? 120_000,
    timeoutMs: opts.timeoutMs ?? 300_000,
    headSha: async () => opts.headSha ?? "sha-head",
    computeDiff: async () => (opts.diff ?? NON_EMPTY_DIFF) as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => (opts.verdictJson !== undefined ? opts.verdictJson : null),
    readUsage: opts.readUsage ?? (async () => null),
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
    model: "sonnet",
    now: () => t,
    idleThresholdMs: 120_000,
    timeoutMs: 300_000,
    headSha: async () => currentHead,
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => null,
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
    model: "sonnet",
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => "sha-new",
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => null,
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
    start: () => {
      throw new Error("herdr start failed");
    },
    stop: (id) => herdr.stopped.push(id),
    list: () => herdr.livePanes,
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
    model: "sonnet",
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => "sha-head",
    computeDiff: async () => diffPromise as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => null,
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
    model: "sonnet",
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => {
      throw new Error("worktree gone");
    },
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => null,
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
    model: "sonnet",
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => "sha-head",
    computeDiff: async () => {
      throw new Error("git diff exceeded maxBuffer");
    },
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => null,
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
    model: "sonnet",
    now: () => 200_000,
    timeoutMs: 300_000,
    headSha: async () => {
      throw new Error("rev-parse failed");
    },
    computeDiff: async () => NON_EMPTY_DIFF as any,
    readTranscript: (): ActivityEntry[] => [],
    readPlan: () => "",
    readVerdict: () => null,
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
    model: "sonnet",
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
    readVerdict: () => null,
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
