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
      herdr: { start: () => ({ terminalId: "dist1" }), stop: () => {} } as any,
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
  d.consider("/r");
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
  d.consider("/r");
  expect(started.length).toBe(0);
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
  d.consider("/r");
  expect(started.length).toBe(0); // 2 learning signals < 3, egress_drop ignored
});

test("distillNow forces a run regardless of threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 1);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
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
  d.distillNow("/r");
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
  d.distillNow("/r");
  await d.tick();
  expect(fired).toBe(1);
});

test("spawn argv follows the safe critic contract (dontAsk after allowlist, bare Write, no skip-permissions)", () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let argv: string[] = [];
  const deps = {
    store,
    herdr: {
      start: (_name: string, _cwd: string, a: string[]) => {
        argv = a;
        return { terminalId: "d1" };
      },
      stop: () => {},
    } as any,
    scratch: { create: () => ({ dir: "/scratch" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);
  d.distillNow("/r");

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
      start: (_n: string, _c: string, a: string[], env?: Record<string, string>) => {
        cap.argv = a;
        cap.env = env;
        cap.starts++;
        return { terminalId: "d1" };
      },
      stop: () => {},
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

test("distill spawn: subscription mode — --settings unchanged + no env 4th arg", () => {
  withAuth("subscription", "/ignored.sh", () => {
    const store = new SessionStore(":memory:");
    seedSignals(store, "/r", 3);
    const { deps, cap } = spawnCapture(store);
    new DistillerService(deps as any).distillNow("/r");
    expect(cap.argv).toContain('{"disableAllHooks":true}');
    expect(cap.env).toBeUndefined();
  });
});

test("distill spawn: api-key mode — apiKeyHelper in --settings + CLAUDE_CONFIG_DIR env", () => {
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

test("distill spawn: api-key without a configured key fails closed (no spawn, scratch cleaned)", () => {
  withAuth("api-key", null, () => {
    const store = new SessionStore(":memory:");
    seedSignals(store, "/r", 3);
    const { deps, cap } = spawnCapture(store);
    new DistillerService(deps as any).distillNow("/r");
    expect(cap.starts).toBe(0);
    expect(cap.removed).toBe(1); // allocated scratch dir cleaned up
  });
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
      start: () => {
        starts++;
        return { terminalId: `d${starts}` };
      },
      stop: () => stopped++,
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
  d.distillNow("/r");
  expect(starts).toBe(1);
  await d.tick(); // not yet timed out
  expect(stopped).toBe(0);
  t += 6_000; // now past timeoutMs
  await d.tick();
  expect(stopped).toBe(1);
  expect(removed).toBe(1);
  expect(store.listLearnings("/r").length).toBe(0); // no proposals → nothing added
  d.distillNow("/r"); // inflight cleared → a new run can start
  expect(starts).toBe(2);
});

test("distillNow with zero signals does not spawn a run", () => {
  const store = new SessionStore(":memory:");
  const { deps, started } = mkDeps(store, { rules: [] }); // no signals seeded
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  expect(started.length).toBe(0);
});

test("consider does nothing when learnings disabled for the repo", () => {
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
    egressExtraHosts: [],
    repoMode: "forge",
  });
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.consider("/r");
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
        egressExtraHosts: [],
        repoMode: "forge",
      }),
      incrementLearningIneffective: (id: string, signals: string[]) => {
        bumped.push({ id, signals });
        return {} as never;
      },
    },
    herdr: { start: () => ({ terminalId: "t1" }) as never, stop: () => {} },
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
  svc.distillNow("/r");
  await svc.tick();
  // only the real active id is bumped, and only the in-window signal id is passed through
  expect(bumped).toEqual([{ id: "rule-1", signals: ["s1"] }]);
});

test("dismissed rules are passed to the distiller so they aren't re-proposed", () => {
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
    herdr: { start: () => ({ terminalId: "d1" }), stop: () => {} } as any,
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
  d.distillNow("/r");
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
        start: (name: string, cwd: string) => {
          if (liveNames.has(name)) throw new Error(`agent_name_taken: ${name}`);
          const terminalId = `dist${nextId++}`;
          liveNames.add(name);
          nameByTerminalId.set(terminalId, name);
          started.push({ name, dir: cwd });
          return { terminalId };
        },
        stop: (terminalId: string) => {
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
  d.consider("/r1");
  d.consider("/r2");
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

  d.consider("/r1");
  d.consider("/r2");
  d.consider("/r3");
  d.consider("/r4");

  // Only 2 spawned (cap)
  expect(started.length).toBe(2);

  // Let the inflight runs finalize and drain queue
  tickRead = true;
  await d.tick(); // finalizes r1 + r2, drains r3 + r4
  expect(started.length).toBe(4);
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

  d.distillNow("/r1");
  d.distillNow("/r2");

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
      start: () => {
        if (throwUnavailable) throw new HerdrUnavailableError();
        if (throwSpawn) throw new Error("spawn failed");
        return { terminalId: "t1" };
      },
      stop: () => {},
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
  d.distillNow("/r0");
  expect(d.health().ok).toBe(true);
  expect(d.health().consecutiveFailures).toBe(0);

  throwUnavailable = false;
  throwSpawn = true;

  // 3 spawn failures → threshold breached
  d.distillNow("/r1");
  expect(d.health().ok).toBe(true); // 1 failure
  d.distillNow("/r2");
  expect(d.health().ok).toBe(true); // 2 failures
  d.distillNow("/r3");
  expect(d.health().ok).toBe(false); // 3 failures → not ok
  expect(d.health().consecutiveFailures).toBe(3);
  expect(d.health().lastFailure?.reason).toBe("spawn");
  expect(d.health().lastFailure?.repoPath).toBe("/r3");
});

test("health — onChange fires on the unhealthy transition and on every further failure while unhealthy", () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 6; i++) seedSignals(store, `/r${i}`, 1);

  let changes = 0;
  const deps = {
    store,
    herdr: {
      start: () => {
        throw new Error("spawn failed");
      },
      stop: () => {},
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
  d.distillNow("/r0"); // 1 failure
  d.distillNow("/r1"); // 2 failures
  expect(changes).toBe(0);

  d.distillNow("/r2"); // 3rd failure → ok→unhealthy transition
  expect(changes).toBe(1);

  // Already unhealthy: each further failure still emits so the count stays fresh.
  d.distillNow("/r3"); // 4 failures
  d.distillNow("/r4"); // 5 failures
  expect(changes).toBe(3);
  expect(d.health().consecutiveFailures).toBe(5);
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
      start: () => ({ terminalId: "t1" }),
      stop: () => stops++,
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
    d.distillNow("/r");
    t += 6_000; // force timeout
    await d.tick(); // timeout-no-output → failure
  }
  expect(d.health().ok).toBe(false);
  expect(d.health().consecutiveFailures).toBe(3);

  // Now a successful run resets health
  t += 1;
  readResult = { rules: [], ineffective: [] };
  d.distillNow("/r");
  await d.tick(); // proposals ready → success
  expect(d.health().ok).toBe(true);
  expect(d.health().consecutiveFailures).toBe(0);
  expect(d.health().lastFailure).toBeNull();
});
