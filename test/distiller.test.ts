import { test, expect, beforeEach, afterEach } from "bun:test";
import { DistillerService, DISTILL_LABEL } from "../src/distiller";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";
import { HerdrUnavailableError } from "../src/herdr";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

function withAuth(mode: typeof config.authMode, helper: string | null, fn: () => void): void {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  try {
    fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

function seedSignals(store: SessionStore, repo: string, n: number) {
  for (let i = 0; i < n; i++) {
    store.addSignal({ repoPath: repo, sessionId: null, kind: "reply", payload: `correction ${i}` });
  }
}

function mkDeps(store: SessionStore, proposals: any, onChange = () => {}) {
  const started: { dir: string }[] = [];
  return {
    deps: {
      store,
      herdr: { start: async () => ({ terminalId: "dist1" }), stop: async () => {} } as any,
      scratch: {
        create: () => {
          const d = { dir: `/scratch/${started.length}` };
          started.push(d);
          return d;
        },
        remove: () => {},
      },
      onChange,
      now: () => 1000,
      minSignals: 3,
      writeSignals: () => {},
      readProposals: () => proposals,
    },
    started,
  };
}

test("consider spawns when enough new signals, tick stores proposed learnings", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "use bun not npm", rationale: "repo is bun", evidence: ["x"] }],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();
  const learnings = store.listLearnings("/r", { status: "proposed" });
  expect(learnings.length).toBe(1);
  expect(learnings[0]!.rule).toBe("use bun not npm");
});

test("consider does nothing below the signal threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 2);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  expect(started.length).toBe(0);
});

test("automatic consideration respects the persisted per-repository interval", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps, started } = mkDeps(store, { rules: [] });
  let now = 1_000;
  deps.now = () => now;
  deps.intervalDays = () => 3;
  const d = new DistillerService(deps as any);

  await d.consider("/r");
  await d.tick();
  expect(started.length).toBe(1);
  expect(store.getSetting("distiller:last-run:/r")).toBe(String(now));

  now += 2 * 24 * 60 * 60 * 1000;
  await d.consider("/r");
  expect(started.length).toBe(1);

  now += 24 * 60 * 60 * 1000;
  await d.consider("/r");
  expect(started.length).toBe(2);
});

test("manual distill bypasses a recent automatic-run timestamp", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps, started } = mkDeps(store, { rules: [] });
  deps.intervalDays = () => 14;
  const d = new DistillerService(deps as any);

  await d.consider("/r");
  await d.tick();
  await d.distillNow("/r");

  expect(started.length).toBe(2);
});

test("egress_drop signals are excluded from the learnings corpus + threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 2); // 2 real learning signals — below minSignals (3)
  // A flood of egress_drop alerts must NOT push the repo over the distill threshold.
  for (let i = 0; i < 10; i++) {
    store.addSignal({
      repoPath: "/r",
      sessionId: null,
      kind: "egress_drop",
      payload: `blocked${i}.evil.com`,
    });
  }
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  expect(started.length).toBe(0); // 2 learning signals < 3, egress_drop ignored
});

test("injection_detected and untrusted_author signals are excluded from the learnings corpus", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 2); // 2 real learning signals — below minSignals (3)
  store.addSignal({
    repoPath: "/r",
    sessionId: null,
    kind: "injection_detected",
    payload: JSON.stringify({ issue: 1, labels: ["ignore-previous-instructions"] }),
  });
  store.addSignal({
    repoPath: "/r",
    sessionId: null,
    kind: "untrusted_author",
    payload: "first-time contributor",
  });
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  expect(started.length).toBe(0); // still 2 learning signals < 3, security telemetry ignored
});

test("distillNow forces a run regardless of threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 1);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  expect(started.length).toBe(1);
});

test("duplicate rule text is not re-proposed", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: "/r", rule: "use bun not npm", rationale: "", evidence: [] });
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "Use Bun not npm", rationale: "dup", evidence: [] }],
  });
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  await d.tick();
  expect(store.listLearnings("/r").length).toBe(1); // unchanged
});

test("onChange fires after a run that produced rules", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let fired = 0;
  const { deps } = mkDeps(
    store,
    { rules: [{ rule: "x", rationale: "", evidence: [] }] },
    () => fired++,
  );
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  await d.tick();
  expect(fired).toBe(1);
});

test("spawn argv follows the safe critic contract (dontAsk after allowlist, bare Write, no skip-permissions)", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let argv: string[] = [];
  const deps = {
    store,
    herdr: {
      start: async (_name: string, _cwd: string, a: string[]) => {
        argv = a;
        return { terminalId: "d1" };
      },
      stop: async () => {},
    } as any,
    scratch: { create: () => ({ dir: "/scratch" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");

  expect(argv).not.toContain("--dangerously-skip-permissions");
  const allow = argv.indexOf("--allowedTools");
  const mode = argv.indexOf("--permission-mode");
  expect(allow).toBeGreaterThan(-1);
  expect(mode).toBeGreaterThan(allow); // dontAsk MUST come after the variadic allowlist
  expect(argv[mode + 1]).toBe("dontAsk");
  // bare Write (not path-scoped) and it sits within the allowlist, before --permission-mode
  const write = argv.indexOf("Write");
  expect(write).toBeGreaterThan(allow);
  expect(write).toBeLessThan(mode);
  // disableAllHooks settings present
  expect(argv).toContain('{"disableAllHooks":true}');
  // the prompt is the trailing positional (last arg), after --permission-mode dontAsk
  expect(argv.length).toBeGreaterThan(mode + 2);
});

function spawnCapture(store: SessionStore) {
  const cap: { argv: string[]; env?: Record<string, string>; starts: number; removed: number } = {
    argv: [],
    env: undefined,
    starts: 0,
    removed: 0,
  };
  const deps = {
    store,
    herdr: {
      start: async (_n: string, _c: string, a: string[], env?: Record<string, string>) => {
        cap.argv = a;
        cap.env = env;
        cap.starts++;
        return { terminalId: "d1" };
      },
      stop: async () => {},
    } as any,
    scratch: { create: () => ({ dir: "/scratch" }), remove: () => cap.removed++ },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null,
  };
  return { deps, cap };
}

test("distill spawn: subscription mode — --settings unchanged + no env 4th arg", async () => {
  withAuth("subscription", "/ignored.sh", () => {
    const store = new SessionStore(":memory:");
    seedSignals(store, "/r", 3);
    const { deps, cap } = spawnCapture(store);
    new DistillerService(deps as any).distillNow("/r");
    expect(cap.argv).toContain('{"disableAllHooks":true}');
    expect(cap.env).toBeUndefined();
  });
});

test("distill spawn: api-key mode — apiKeyHelper in --settings + CLAUDE_CONFIG_DIR env", async () => {
  withAuth("api-key", "/helper.sh", () => {
    const store = new SessionStore(":memory:");
    seedSignals(store, "/r", 3);
    const { deps, cap } = spawnCapture(store);
    new DistillerService(deps as any).distillNow("/r");
    const settings = JSON.parse(cap.argv[cap.argv.indexOf("--settings") + 1]!);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.apiKeyHelper).toBe("/helper.sh");
    expect(Object.keys(cap.env!)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });
});

test("distill spawn: api-key without a configured key fails closed (no spawn, scratch cleaned)", async () => {
  withAuth("api-key", null, () => {
    const store = new SessionStore(":memory:");
    seedSignals(store, "/r", 3);
    const { deps, cap } = spawnCapture(store);
    new DistillerService(deps as any).distillNow("/r");
    expect(cap.starts).toBe(0);
    expect(cap.removed).toBe(1); // allocated scratch dir cleaned up
  });
});

test("distill spawn: a resolved Codex environment uses codex exec with its model and effort", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps, cap } = spawnCapture(store);
  deps.environment = () => ({ provider: "codex", model: "gpt-5.5", effort: "high" });

  await new DistillerService(deps as any).distillNow("/r");

  expect(cap.argv).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=high",
    expect.any(String),
  ]);
  expect(cap.env).toBeUndefined();
});

test("distill spawn: an explicit Claude environment keeps the writer-ro Claude argv", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps, cap } = spawnCapture(store);
  deps.environment = () => ({ provider: "claude", model: "sonnet", effort: "high" });

  await new DistillerService(deps as any).distillNow("/r");

  expect(cap.argv[0]).toBe("claude");
  expect(cap.argv).toContain("--settings");
  expect(cap.argv).toContain("--allowedTools");
  expect(cap.argv).toContain("--model");
  expect(cap.argv).toContain("sonnet");
  expect(cap.argv).toContain("--effort");
  expect(cap.argv).toContain("high");
  expect(cap.argv).toContain("--permission-mode");
  expect(cap.argv).toContain("dontAsk");
});

test("distill spawn: missing Anthropic api key does not block a resolved Codex environment", async () => {
  const previousMode = config.authMode;
  const previousHelper = config.authApiKeyHelperPath;
  config.authMode = "api-key";
  config.authApiKeyHelperPath = null;
  try {
    const store = new SessionStore(":memory:");
    seedSignals(store, "/r", 3);
    const { deps, cap } = spawnCapture(store);
    deps.environment = () => ({ provider: "codex", model: null, effort: null });

    await new DistillerService(deps as any).distillNow("/r");

    expect(cap.starts).toBe(1);
    expect(cap.argv.slice(0, 4)).toEqual(["codex", "exec", "--sandbox", "workspace-write"]);
  } finally {
    config.authMode = previousMode;
    config.authApiKeyHelperPath = previousHelper;
  }
});

test("tick finalizes and reaps a run that times out without proposals", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let t = 1000;
  let stopped = 0;
  let removed = 0;
  let starts = 0;
  const deps = {
    store,
    herdr: {
      start: async () => {
        starts++;
        return { terminalId: `d${starts}` };
      },
      stop: async () => stopped++,
    } as any,
    scratch: { create: () => ({ dir: `/scratch/${starts}` }), remove: () => removed++ },
    onChange: () => {},
    now: () => t,
    timeoutMs: 5_000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null, // proposals never written
  };
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  expect(starts).toBe(1);
  await d.tick(); // not yet timed out
  expect(stopped).toBe(0);
  t += 6_000; // now past timeoutMs
  await d.tick();
  expect(stopped).toBe(1);
  expect(removed).toBe(1);
  expect(store.listLearnings("/r").length).toBe(0); // no proposals → nothing added
  await d.distillNow("/r"); // inflight cleared → a new run can start
  expect(starts).toBe(2);
});

test("distillNow with zero signals does not spawn a run", async () => {
  const store = new SessionStore(":memory:");
  const { deps, started } = mkDeps(store, { rules: [] }); // no signals seeded
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  expect(started.length).toBe(0);
});

test("consider does nothing when learnings disabled for the repo", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 5);
  store.setRepoConfig("/r", {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  expect(started.length).toBe(0);
});

test("distiller increments ineffective for cited active rule ids with validated evidence", async () => {
  const bumped: { id: string; signals: string[] }[] = [];
  const active = [{ id: "rule-1", rule: "use bun", status: "active" }];
  const svc = new DistillerService({
    store: {
      listSignals: () => [
        { id: "s1", repoPath: "/r", sessionId: null, kind: "critic", payload: "ran npm", ts: 1 },
      ],
      addLearning: () => ({}) as never,
      listLearnings: () => [],
      listActiveLearnings: () => active as never,
      getRepoConfig: () => ({
        criticEnabled: true,
        criticAllPrs: false,
        autoAddressEnabled: false,
        learningsEnabled: true,
        autopilotEnabled: false,
        planGateEnabled: false,
        autoDrainEnabled: false,
        autoMergeEnabled: false,
        buildQueueEnabled: false,
        draftMode: false,
        signoffAuthority: "human",
        maxAuto: 1,
        autoLabel: "shepherd:auto",
        usageCeilingPct: 80,
        sandboxProfile: "trusted",
        defaultModel: "inherit",
        defaultEffort: "inherit",
        previewOpenMode: "ask",
        egressExtraHosts: [],
        repoMode: "forge",
        autoOptimizeFlagged: false,
        manualStepsIssueEnabled: false,
        preWarmEpicLandingCi: false,
        hidden: false,
      }),
      incrementLearningIneffective: (id: string, signals: string[]) => {
        bumped.push({ id, signals });
        return {} as never;
      },
      accrueProposedEvidence: () => null,
      mergeLearning: () => null,
      retireLearning: () => null,
      getLearning: () => null,
    },
    herdr: {
      start: async () => ({ terminalId: "t1" }) as never,
      stop: async () => {},
      list: () => [],
      closeTab: async () => {},
    },
    scratch: { create: () => ({ dir: "/tmp/x" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    writeSignals: () => {},
    // rule-1 cites a real signal (s1) plus a hallucinated one (s99); bogus is not active
    readProposals: () => ({
      rules: [],
      ineffective: [
        { id: "rule-1", evidence: ["s1", "s99"] },
        { id: "bogus", evidence: ["s1"] },
      ],
    }),
  });
  await svc.distillNow("/r");
  await svc.tick();
  // only the real active id is bumped, and only the in-window signal id is passed through
  expect(bumped).toEqual([{ id: "rule-1", signals: ["s1"] }]);
});

test("dismissed rules are passed to the distiller so they aren't re-proposed", async () => {
  const store = new SessionStore(":memory:");
  const dis = store.addLearning({
    repoPath: "/r",
    rule: "dismissed rule",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(dis.id, "dismissed");
  seedSignals(store, "/r", 3);
  let captured: string[] = [];
  const deps = {
    store,
    herdr: { start: async () => ({ terminalId: "d1" }), stop: async () => {} } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: (_dir: string, _sigs: unknown, existingRules: string[]) => {
      captured = existingRules;
    },
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  expect(captured).toContain("dismissed rule");
});

// ── New tests: unique agent name, concurrency cap, health ───────────────────

function mkCollisionAwareDeps(
  store: SessionStore,
  proposals: any,
  onChange = () => {},
  maxConcurrent?: number,
) {
  const liveNames = new Set<string>();
  const nameByTerminalId = new Map<string, string>();
  let nextId = 0;
  const started: { name: string; dir: string }[] = [];
  return {
    deps: {
      store,
      herdr: {
        start: async (name: string, cwd: string) => {
          if (liveNames.has(name)) throw new Error(`agent_name_taken: ${name}`);
          const terminalId = `dist${nextId++}`;
          liveNames.add(name);
          nameByTerminalId.set(terminalId, name);
          started.push({ name, dir: cwd });
          return { terminalId };
        },
        stop: async (terminalId: string) => {
          const n = nameByTerminalId.get(terminalId);
          if (n) liveNames.delete(n);
          nameByTerminalId.delete(terminalId);
        },
      } as any,
      scratch: {
        create: () => ({ dir: `/scratch/${nextId}` }),
        remove: () => {},
      },
      onChange,
      now: () => 1000,
      minSignals: 3,
      maxConcurrent,
      writeSignals: () => {},
      readProposals: () => proposals,
    },
    started,
    liveNames,
  };
}

test("collision regression: two repos considered together get distinct unique agent names", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r1", 3);
  seedSignals(store, "/r2", 3);
  const { deps, started } = mkCollisionAwareDeps(store, { rules: [], ineffective: [] });
  const d = new DistillerService(deps as any);
  // Both repos pass threshold — both should spawn without collision
  await d.consider("/r1");
  await d.consider("/r2");
  expect(started.length).toBe(2);
  // Names must be unique and share the DISTILL_LABEL prefix
  const [n1, n2] = started.map((s) => s.name);
  expect(n1).toMatch(new RegExp(`^${DISTILL_LABEL}`));
  expect(n2).toMatch(new RegExp(`^${DISTILL_LABEL}`));
  expect(n1).not.toBe(n2);
});

test("concurrency cap: at most maxConcurrent spawns live; queue drains via tick", async () => {
  const store = new SessionStore(":memory:");
  for (const r of ["/r1", "/r2", "/r3", "/r4"]) seedSignals(store, r, 3);
  let tickRead = false;
  const readProposals = () => (tickRead ? { rules: [], ineffective: [] } : null);
  const { deps, started } = mkCollisionAwareDeps(store, null, () => {}, 2);
  // override readProposals to be dynamic
  (deps as any).readProposals = readProposals;
  const d = new DistillerService(deps as any);

  await d.consider("/r1");
  await d.consider("/r2");
  await d.consider("/r3");
  await d.consider("/r4");

  // Only 2 spawned (cap)
  expect(started.length).toBe(2);

  // Let the inflight runs finalize and drain queue
  tickRead = true;
  await d.tick(); // finalizes r1 + r2, drains r3 + r4
  expect(started.length).toBe(4);
});

test("cap holds under a fire-and-forget fan-out (daily-sweep race): begin reserves its slot synchronously", async () => {
  // Regression: `void consider(repo)` per repo (index.ts daily sweep) fires all considers in
  // one tick BEFORE any awaits. If begin() reserved its inflight slot only AFTER `await
  // herdr.start`, every repo would pass `inflight.size < maxConcurrent` and blow the cap. The
  // synchronous reservation must hold the line even when no individual call is awaited.
  const store = new SessionStore(":memory:");
  for (const r of ["/r1", "/r2", "/r3", "/r4"]) seedSignals(store, r, 3);
  const { deps, started } = mkCollisionAwareDeps(store, null, () => {}, 2);
  (deps as any).readProposals = () => null; // nothing finalizes during the fan-out
  const d = new DistillerService(deps as any);

  // Fan out concurrently (mirrors `for (const repo …) void distiller.consider(repo.path)`).
  await Promise.all(["/r1", "/r2", "/r3", "/r4"].map((r) => d.consider(r)));

  expect(started.length).toBe(2); // cap respected; r3 + r4 queued, not spawned
});

test("distillNow respects the cap: second call queued, drains on tick", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r1", 1);
  seedSignals(store, "/r2", 1);
  let tickRead = false;
  const readProposals = () => (tickRead ? { rules: [], ineffective: [] } : null);
  const { deps, started } = mkCollisionAwareDeps(store, null, () => {}, 1);
  (deps as any).readProposals = readProposals;
  const d = new DistillerService(deps as any);

  await d.distillNow("/r1");
  await d.distillNow("/r2");

  expect(started.length).toBe(1); // only 1 inflight

  tickRead = true;
  await d.tick(); // finalizes r1, drains r2
  expect(started.length).toBe(2);
});

test("health — spawn failures accumulate; HerdrUnavailableError is NOT counted", async () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 5; i++) seedSignals(store, `/r${i}`, 1);

  let throwUnavailable = false;
  let throwSpawn = false;
  const deps = {
    store,
    herdr: {
      start: async () => {
        if (throwUnavailable) throw new HerdrUnavailableError();
        if (throwSpawn) throw new Error("spawn failed");
        return { terminalId: "t1" };
      },
      stop: async () => {},
    } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 1,
    writeSignals: () => {},
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);

  // HerdrUnavailableError does NOT affect health
  throwUnavailable = true;
  await d.distillNow("/r0");
  expect(d.health().ok).toBe(true);
  expect(d.health().consecutiveFailures).toBe(0);

  throwUnavailable = false;
  throwSpawn = true;

  // 3 spawn failures → threshold breached
  await d.distillNow("/r1");
  expect(d.health().ok).toBe(true); // 1 failure
  await d.distillNow("/r2");
  expect(d.health().ok).toBe(true); // 2 failures
  await d.distillNow("/r3");
  expect(d.health().ok).toBe(false); // 3 failures → not ok
  expect(d.health().consecutiveFailures).toBe(3);
  expect(d.health().lastFailure?.reason).toBe("spawn");
  expect(d.health().lastFailure?.repoPath).toBe("/r3");
});

test("health — onChange fires on the unhealthy transition and on every further failure while unhealthy", async () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 6; i++) seedSignals(store, `/r${i}`, 1);

  let changes = 0;
  const deps = {
    store,
    herdr: {
      start: async () => {
        throw new Error("spawn failed");
      },
      stop: async () => {},
    } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => changes++,
    now: () => 1000,
    minSignals: 1,
    writeSignals: () => {},
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);

  // Below threshold (banner hidden): no emit.
  await d.distillNow("/r0"); // 1 failure
  await d.distillNow("/r1"); // 2 failures
  expect(changes).toBe(0);

  await d.distillNow("/r2"); // 3rd failure → ok→unhealthy transition
  expect(changes).toBe(1);

  // Already unhealthy: each further failure still emits so the count stays fresh.
  await d.distillNow("/r3"); // 4 failures
  await d.distillNow("/r4"); // 5 failures
  expect(changes).toBe(3);
  expect(d.health().consecutiveFailures).toBe(5);
});

// ── Task 3: UPDATE / DELETE / NOOP capture-time merge ────────────────────────

test("UPDATE merges rule text + rationale while preserving counters", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const learning = store.addLearning({
    repoPath: "/r",
    rule: "original rule",
    rationale: "r1",
    evidence: [],
  });
  store.setLearningStatus(learning.id, "active");
  // Seed counters via attributeInjected
  store.attributeInjected([learning.id], { good: true }); // injected=1, helpful=1

  const { deps } = mkDeps(store, {
    rules: [],
    updates: [{ id: learning.id, rule: "enriched rule text", rationale: "r2" }],
    deletes: [],
    ineffective: [],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  const updated = store.getLearning(learning.id)!;
  expect(updated.rule).toBe("enriched rule text");
  expect(updated.rationale).toBe("r2");
  expect(updated.helpfulCount).toBe(1); // preserved
  expect(updated.injectedCount).toBe(1); // preserved
});

test("ADD carrying text just merged by an UPDATE is deduped (no duplicate active rule)", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const learning = store.addLearning({
    repoPath: "/r",
    rule: "original rule",
    rationale: "r1",
    evidence: [],
  });
  store.setLearningStatus(learning.id, "active");

  // The LLM both UPDATEs the rule to a richer text AND emits an ADD with that same text.
  // The ADD must dedup against the just-merged rule — `have` is recomputed after updates.
  const merged = "merged enriched rule text";
  const { deps } = mkDeps(store, {
    rules: [{ rule: merged, rationale: "dup", evidence: [] }],
    updates: [{ id: learning.id, rule: merged, rationale: "r2" }],
    deletes: [],
    ineffective: [],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  // Exactly one rule remains (the merged one); no duplicate proposed rule was added.
  expect(store.listLearnings("/r").length).toBe(1);
  expect(store.listLearnings("/r", { status: "proposed" }).length).toBe(0);
  const only = store.getLearning(learning.id)!;
  expect(only.rule).toBe(merged);
  expect(only.status).toBe("active");
});

test("activeRules payload marks promoted rules (UPDATE/DELETE eligibility)", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const active = store.addLearning({
    repoPath: "/r",
    rule: "active rule",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(active.id, "active");
  const promoted = store.addLearning({
    repoPath: "/r",
    rule: "promoted rule",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(promoted.id, "active");
  store.promoteLearning(promoted.id, "https://github.com/pr/1");

  let captured: { id: string; promoted: boolean }[] = [];
  const { deps } = mkDeps(store, null);
  (deps as any).writeSignals = (
    _dir: string,
    _sigs: unknown,
    _existing: string[],
    activeRules: { id: string; promoted: boolean }[],
  ) => {
    captured = activeRules;
  };
  const d = new DistillerService(deps as any);
  await d.consider("/r"); // begin() → writeSignals runs synchronously

  const byId = new Map(captured.map((r) => [r.id, r]));
  expect(byId.get(active.id)?.promoted).toBe(false);
  expect(byId.get(promoted.id)?.promoted).toBe(true);
});

test("UPDATE skips promoted rules", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const learning = store.addLearning({
    repoPath: "/r",
    rule: "original rule",
    rationale: "r1",
    evidence: [],
  });
  store.setLearningStatus(learning.id, "active");
  store.promoteLearning(learning.id, "https://github.com/pr/1");

  const { deps } = mkDeps(store, {
    rules: [],
    updates: [{ id: learning.id, rule: "should not replace", rationale: "r2" }],
    deletes: [],
    ineffective: [],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  const unchanged = store.getLearning(learning.id)!;
  expect(unchanged.rule).toBe("original rule"); // not changed
});

test("UPDATE and DELETE ignore bogus and non-active ids", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const proposed = store.addLearning({
    repoPath: "/r",
    rule: "proposed rule",
    rationale: "",
    evidence: [],
  });
  // proposed.id is valid but status is "proposed", not "active"

  const { deps } = mkDeps(store, {
    rules: [],
    updates: [
      { id: "nope", rule: "bogus update", rationale: "" },
      { id: proposed.id, rule: "should not update proposed", rationale: "" },
    ],
    deletes: [
      { id: "nope", reason: "bogus delete" },
      { id: proposed.id, reason: "should not delete proposed" },
    ],
    ineffective: [],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  const unchanged = store.getLearning(proposed.id)!;
  expect(unchanged.rule).toBe("proposed rule"); // not changed
  expect(unchanged.status).toBe("proposed"); // not retired
});

test("DELETE soft-retires with reason 'superseded'", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const learning = store.addLearning({
    repoPath: "/r",
    rule: "old rule",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(learning.id, "active");

  const { deps } = mkDeps(store, {
    rules: [],
    updates: [],
    deletes: [{ id: learning.id, reason: "contradicted by new evidence" }],
    ineffective: [],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  const retired = store.getLearning(learning.id)!;
  expect(retired.status).toBe("retired");
  expect(retired.retiredReason).toBe("superseded");
});

test("ADD cap: at most 5 rules added per run", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);

  const rules = Array.from({ length: 6 }, (_, i) => ({
    rule: `new rule ${i}`,
    rationale: "",
    evidence: [],
  }));
  const { deps } = mkDeps(store, { rules, updates: [], deletes: [], ineffective: [] });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  expect(store.listLearnings("/r", { status: "proposed" }).length).toBe(5); // capped at 5
});

test("UPDATE cap: at most 5 updates applied per run", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);

  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const l = store.addLearning({ repoPath: "/r", rule: `rule ${i}`, rationale: "", evidence: [] });
    store.setLearningStatus(l.id, "active");
    ids.push(l.id);
  }

  const updates = ids.map((id, i) => ({ id, rule: `updated rule ${i}`, rationale: "" }));
  const { deps } = mkDeps(store, {
    rules: [],
    updates,
    deletes: [],
    ineffective: [],
  });
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  const changed = ids.filter((id, i) => store.getLearning(id)!.rule === `updated rule ${i}`);
  expect(changed.length).toBe(5); // capped at 5
});

test("onChange fires on update-only proposals (no rules, no ineffective)", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const learning = store.addLearning({
    repoPath: "/r",
    rule: "original",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(learning.id, "active");

  let fired = 0;
  const { deps } = mkDeps(
    store,
    {
      rules: [],
      updates: [{ id: learning.id, rule: "updated text", rationale: "r" }],
      deletes: [],
      ineffective: [],
    },
    () => fired++,
  );
  const d = new DistillerService(deps as any);
  await d.consider("/r");
  await d.tick();

  expect(fired).toBe(1);
});

test("health — timeout-no-output counts as failure; successful finalize resets health", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 1);
  let t = 1000;
  let readResult: any = null;
  let stops = 0;
  const deps = {
    store,
    herdr: {
      start: async () => ({ terminalId: "t1" }),
      stop: async () => stops++,
    } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => t,
    minSignals: 1,
    timeoutMs: 5_000,
    writeSignals: () => {},
    readProposals: () => readResult,
  };
  const d = new DistillerService(deps as any);

  // 3 timeout failures to trip health
  for (let i = 0; i < 3; i++) {
    readResult = null;
    await d.distillNow("/r");
    t += 6_000; // force timeout
    await d.tick(); // timeout-no-output → failure
  }
  expect(d.health().ok).toBe(false);
  expect(d.health().consecutiveFailures).toBe(3);

  // Now a successful run resets health
  t += 1;
  readResult = { rules: [], ineffective: [] };
  await d.distillNow("/r");
  await d.tick(); // proposals ready → success
  expect(d.health().ok).toBe(true);
  expect(d.health().consecutiveFailures).toBe(0);
  expect(d.health().lastFailure).toBeNull();
});

test("#842: distiller persists sanitized scopeGlobs from a proposal", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [
      {
        rule: "keep svelte styles scoped",
        rationale: "ui only",
        evidence: [],
        // mix of valid + junk: non-string, ./-prefixed (normalized), over-long, dup
        scopeGlobs: [
          "./ui/**/*.svelte",
          "ui/**/*.svelte", // dup after normalize
          42,
          "x".repeat(200), // over MAX_GLOB_LEN
        ],
      },
    ],
  });
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  await d.tick();
  const [l] = store.listLearnings("/r", { status: "proposed" });
  expect(l!.scopeGlobs).toEqual(["ui/**/*.svelte"]);
});

test("#842: a proposal without scopeGlobs stays an Always-rule (empty globs)", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "general rule", rationale: "", evidence: [] }],
  });
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");
  await d.tick();
  const [l] = store.listLearnings("/r", { status: "proposed" });
  expect(l!.scopeGlobs).toEqual([]);
});

// ── Task 2: reaffirm channel ─────────────────────────────────────────────────

test("reaffirm: re-evidenced proposed rule accrues evidence (not NOOP)", async () => {
  const store = new SessionStore(":memory:");
  // Seed a proposed rule + a signal that is in the run's signal set
  const sig = store.addSignal({
    repoPath: "/r",
    sessionId: null,
    kind: "reply",
    payload: "use bun again",
  });
  const proposed = store.addLearning({
    repoPath: "/r",
    rule: "use bun not npm",
    rationale: "repo is bun",
    evidence: [],
  });
  // Proposed rules start with status "proposed" by default
  const before = store.getLearning(proposed.id)!;
  expect(before.evidenceCount).toBe(0);

  const { deps } = mkDeps(store, {
    rules: [],
    updates: [],
    deletes: [],
    ineffective: [],
    reaffirm: [{ id: proposed.id, evidence: [sig.id] }],
  });
  // Use a writeSignals that captures the signal in f.signalIds by passing signals through
  const svc = new DistillerService({
    ...(deps as any),
  });
  await svc.distillNow("/r");
  await svc.tick();

  const after = store.getLearning(proposed.id)!;
  expect(after.evidenceCount).toBe(1);
  expect(after.evidence).toContain(sig.id);
});

test("reaffirm: evidence not in f.signalIds (fabricated id) is not accrued", async () => {
  const store = new SessionStore(":memory:");
  // Seed one real signal — distillNow requires >= 1
  store.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: "p" });
  const proposed = store.addLearning({
    repoPath: "/r",
    rule: "use bun not npm",
    rationale: "",
    evidence: [],
  });

  const { deps } = mkDeps(store, {
    rules: [],
    updates: [],
    deletes: [],
    ineffective: [],
    reaffirm: [{ id: proposed.id, evidence: ["hallucinated-id-not-in-run"] }],
  });
  const svc = new DistillerService(deps as any);
  await svc.distillNow("/r");
  await svc.tick();

  // fabricated signal id filtered out → accrueProposedEvidence called with []  → returns null → count stays 0
  const after = store.getLearning(proposed.id)!;
  expect(after.evidenceCount).toBe(0);
});

test("reaffirm: proposedRules passed to writeSignals include proposed rules sorted by evidenceCount DESC capped at 30", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);

  // Add two proposed rules with different evidence counts
  const p1 = store.addLearning({ repoPath: "/r", rule: "rule alpha", rationale: "", evidence: [] });
  const p2 = store.addLearning({ repoPath: "/r", rule: "rule beta", rationale: "", evidence: [] });
  // Give p2 more evidence by accruing a fake signal id directly
  const sig = store.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: "x" });
  store.accrueProposedEvidence(p2.id, [sig.id]);

  let capturedProposed: { id: string; rule: string }[] = [];
  const deps = {
    store,
    herdr: { start: async () => ({ terminalId: "d1" }), stop: async () => {} } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: (
      _dir: string,
      _sigs: unknown,
      _existing: string[],
      _activeRules: unknown,
      proposedRules: { id: string; rule: string }[],
    ) => {
      capturedProposed = proposedRules;
    },
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);
  await d.distillNow("/r");

  // p2 has evidenceCount=1, p1 has evidenceCount=0 → p2 should come first
  expect(capturedProposed.length).toBe(2);
  expect(capturedProposed[0]!.id).toBe(p2.id);
  expect(capturedProposed[1]!.id).toBe(p1.id);
  // Should only contain id+rule (no other fields)
  expect(Object.keys(capturedProposed[0]!)).toEqual(["id", "rule"]);
});

// ── boot reapOrphans (issue #1135) ──────────────────────────────────────────

test("reapOrphans closes orphaned __distill__ tabs, sparing unrelated + inflight-owned", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const closed: string[] = [];
  const listed = [
    { name: DISTILL_LABEL + "deadbeef", terminalId: "orphan1", tabId: "tabO" },
    { name: "my-feature-branch", terminalId: "u1", tabId: "tabU" },
    { name: DISTILL_LABEL + "live0001", terminalId: "live1", tabId: "tabL" },
  ];
  const svc = new DistillerService({
    store,
    herdr: {
      start: async () => ({ terminalId: "live1" }),
      stop: async () => {},
      list: () => listed,
      closeTab: async (id: string) => closed.push(id),
    },
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null, // run stays in flight (not finalized)
  } as never);
  await svc.distillNow("/r"); // in-flight run owns terminalId "live1"
  svc.reapOrphans();
  expect(closed).toEqual(["tabO"]); // orphan only — unrelated + in-flight-owned spared
});

test("reapOrphans is a no-op when herdr is unavailable", async () => {
  const store = new SessionStore(":memory:");
  let closes = 0;
  const svc = new DistillerService({
    store,
    herdr: {
      start: async () => ({ terminalId: "t" }),
      stop: async () => {},
      list: () => {
        throw new HerdrUnavailableError();
      },
      closeTab: async () => {
        closes++;
      },
    },
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
  } as never);
  expect(() => svc.reapOrphans()).not.toThrow();
  expect(closes).toBe(0);
});
