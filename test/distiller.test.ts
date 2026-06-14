import { test, expect, beforeEach, afterEach } from "bun:test";
import { DistillerService } from "../src/distiller";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

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
