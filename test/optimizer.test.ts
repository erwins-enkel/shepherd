import { test, expect, beforeEach, afterEach } from "bun:test";
import { OptimizerService, OPTIMIZE_LABEL, type OptimizerTarget } from "../src/optimizer";
import { SessionStore } from "../src/store";
import { HerdrUnavailableError } from "../src/herdr";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

/** Seed an ACTIVE rule and return its id. */
function seedActiveRule(store: SessionStore, repo: string, rule: string): string {
  const l = store.addLearning({ repoPath: repo, rule, rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  return l.id;
}

/** Seed a PROMOTED rule and return its id. */
function seedPromotedRule(store: SessionStore, repo: string, rule: string): string {
  const id = seedActiveRule(store, repo, rule);
  store.promoteLearning(id, "https://example/pr");
  return id;
}

/** Flag a rule as ineffective by citing one fresh signal (active/promoted only). */
function flag(store: SessionStore, repo: string, id: string): void {
  const s = store.addSignal({ repoPath: repo, sessionId: null, kind: "critic", payload: "failed" });
  store.incrementLearningIneffective(id, [s.id]);
}

interface FakePromoter {
  calls: string[];
  resyncPromoted: (repoPath: string) => Promise<{ ok: true; url: string }>;
}
function fakePromoter(): FakePromoter {
  const calls: string[] = [];
  return {
    calls,
    resyncPromoted: (repoPath: string) => {
      calls.push(repoPath);
      return Promise.resolve({ ok: true as const, url: "" });
    },
  };
}

function mkDeps(
  store: SessionStore,
  output: RawLike,
  opts: {
    onChange?: () => void;
    promoter?: FakePromoter;
    now?: () => number;
    timeoutMs?: number;
    maxConcurrent?: number;
    writeInput?: (dir: string, targets: OptimizerTarget[]) => void;
  } = {},
) {
  const promoter = opts.promoter ?? fakePromoter();
  const cap = { starts: 0, stops: 0, removed: 0 };
  return {
    promoter,
    cap,
    deps: {
      store,
      herdr: {
        start: async () => {
          cap.starts++;
          return { terminalId: `opt${cap.starts}` };
        },
        stop: async () => cap.stops++,
      } as any,
      scratch: {
        create: () => ({ dir: `/scratch/${cap.starts}` }),
        remove: () => cap.removed++,
      },
      promoter,
      onChange: opts.onChange ?? (() => {}),
      now: opts.now ?? (() => 1000),
      timeoutMs: opts.timeoutMs,
      maxConcurrent: opts.maxConcurrent,
      writeInput: opts.writeInput ?? (() => {}),
      readOutput: () => output,
    },
  };
}

type RawLike = { revisions?: { id?: unknown; rule?: unknown; rationale?: unknown }[] } | null;

test("applies revisions + clears flag; onChange fires", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "old rule");
  flag(store, "/r", id);
  let changed = 0;
  const { deps } = mkDeps(
    store,
    { revisions: [{ id, rule: "new stronger rule" }] },
    {
      onChange: () => changed++,
    },
  );
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  await svc.tick();
  const l = store.getLearning(id)!;
  expect(l.rule).toBe("new stronger rule");
  expect(l.ineffectiveCount).toBe(0);
  expect(changed).toBe(1);
});

test("optimizeOne scopes input + applied revisions to a single id", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActiveRule(store, "/r", "rule A");
  const b = seedActiveRule(store, "/r", "rule B");
  flag(store, "/r", a);
  flag(store, "/r", b);
  let capturedTargets: OptimizerTarget[] = [];
  // readOutput returns revisions for BOTH a and b — only a is in this run's target set.
  const { deps } = mkDeps(
    store,
    {
      revisions: [
        { id: a, rule: "A revised" },
        { id: b, rule: "B revised" },
      ],
    },
    { writeInput: (_d, t) => (capturedTargets = t) },
  );
  const svc = new OptimizerService(deps as any);
  await svc.optimizeOne(a);
  await svc.tick();
  expect(store.getLearning(a)!.rule).toBe("A revised");
  expect(store.getLearning(b)!.rule).toBe("rule B"); // untouched
  expect(store.getLearning(b)!.ineffectiveCount).toBe(1); // still flagged
  expect(capturedTargets.map((t) => t.id)).toEqual([a]); // input scoped to a only
});

test("id-guard: a revision for an id not in the target set is ignored", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActiveRule(store, "/r", "rule A");
  flag(store, "/r", a);
  const { deps } = mkDeps(store, {
    revisions: [{ id: "ghost-id", rule: "injected" }],
  });
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  await svc.tick();
  expect(store.getLearning(a)!.rule).toBe("rule A"); // untouched
  expect(store.getLearning(a)!.ineffectiveCount).toBe(1); // still flagged
});

test("promoted rule revised → resyncPromoted called once with repo", async () => {
  const store = new SessionStore(":memory:");
  const id = seedPromotedRule(store, "/r", "promoted rule");
  flag(store, "/r", id);
  const promoter = fakePromoter();
  const { deps } = mkDeps(store, { revisions: [{ id, rule: "promoted revised" }] }, { promoter });
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  await svc.tick();
  await Promise.resolve(); // let the fire-and-forget resync settle
  expect(promoter.calls).toEqual(["/r"]);
});

test("only an active rule revised → resyncPromoted NOT called", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "active rule");
  flag(store, "/r", id);
  const promoter = fakePromoter();
  const { deps } = mkDeps(store, { revisions: [{ id, rule: "active revised" }] }, { promoter });
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  await svc.tick();
  await Promise.resolve();
  expect(promoter.calls).toEqual([]);
});

test("timeout/no-output → health failure, scratch removed, herdr stopped", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "rule");
  flag(store, "/r", id);
  let t = 1000;
  const { deps, cap } = mkDeps(store, null, { now: () => t, timeoutMs: 5_000 });
  const svc = new OptimizerService(deps as any);

  // 3 timeout failures to trip the health threshold.
  for (let i = 0; i < 3; i++) {
    flag(store, "/r", id); // re-flag (reviseLearning never ran; but keep it flagged anyway)
    await svc.optimizeOne(id);
    t += 6_000;
    await svc.tick();
  }
  expect(svc.health().ok).toBe(false);
  expect(svc.health().consecutiveFailures).toBe(3);
  expect(svc.health().lastFailure?.reason).toBe("timeout-no-output");
  expect(cap.stops).toBe(3);
  // one scratch removed per finalized run (begin allocates, finalize removes)
  expect(cap.removed).toBe(3);
});

test("one run per repo: a second optimizeAllFlagged is a no-op while the first is inflight", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "rule");
  flag(store, "/r", id);
  const { deps, cap } = mkDeps(store, null); // readOutput null → run stays inflight
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  await svc.optimizeAllFlagged("/r");
  expect(cap.starts).toBe(1);
});

test("empty/blank rule revision is rejected", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "keep me");
  flag(store, "/r", id);
  const { deps } = mkDeps(store, { revisions: [{ id, rule: "   " }] });
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  await svc.tick();
  expect(store.getLearning(id)!.rule).toBe("keep me"); // not applied
  expect(store.getLearning(id)!.ineffectiveCount).toBe(1); // still flagged
});

test("nothing flagged → no spawn", async () => {
  const store = new SessionStore(":memory:");
  seedActiveRule(store, "/r", "rule"); // active but NOT flagged
  const { deps, cap } = mkDeps(store, { revisions: [] });
  const svc = new OptimizerService(deps as any);
  await svc.optimizeAllFlagged("/r");
  expect(cap.starts).toBe(0);
});

test("spawn argv follows the safe contract + unique __optimize__ name", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "rule");
  flag(store, "/r", id);
  let argv: string[] = [];
  let name = "";
  const promoter = fakePromoter();
  const deps = {
    store,
    herdr: {
      start: async (n: string, _cwd: string, a: string[]) => {
        name = n;
        argv = a;
        return { terminalId: "o1" };
      },
      stop: async () => {},
    } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    promoter,
    onChange: () => {},
    now: () => 1000,
    writeInput: () => {},
    readOutput: () => null,
  };
  new OptimizerService(deps as any).optimizeAllFlagged("/r");

  expect(name).toMatch(new RegExp(`^${OPTIMIZE_LABEL}`));
  expect(argv).not.toContain("--dangerously-skip-permissions");
  const allow = argv.indexOf("--allowedTools");
  const mode = argv.indexOf("--permission-mode");
  expect(allow).toBeGreaterThan(-1);
  expect(mode).toBeGreaterThan(allow);
  expect(argv[mode + 1]).toBe("dontAsk");
  const write = argv.indexOf("Write");
  expect(write).toBeGreaterThan(allow);
  expect(write).toBeLessThan(mode);
  expect(argv).toContain('{"disableAllHooks":true}');
  expect(argv.length).toBeGreaterThan(mode + 2); // prompt trails dontAsk
});

// ── boot reapOrphans (issue #1135) ──────────────────────────────────────────

test("reapOrphans closes orphaned __optimize__ tabs, sparing unrelated + inflight-owned", async () => {
  const store = new SessionStore(":memory:");
  const id = seedActiveRule(store, "/r", "old rule");
  flag(store, "/r", id);
  const closed: string[] = [];
  const listed = [
    { name: OPTIMIZE_LABEL + "deadbeef", terminalId: "orphan1", tabId: "tabO" },
    { name: "review TASK-09", terminalId: "u1", tabId: "tabU" },
    { name: OPTIMIZE_LABEL + "live0001", terminalId: "live1", tabId: "tabL" },
  ];
  const svc = new OptimizerService({
    store,
    herdr: {
      start: async () => ({ terminalId: "live1" }),
      stop: async () => {},
      list: () => listed,
      closeTab: async (t: string) => closed.push(t),
    },
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    promoter: fakePromoter(),
    onChange: () => {},
    now: () => 1000,
    writeInput: () => {},
    readOutput: () => null, // run stays in flight (not finalized)
  } as never);
  await svc.optimizeOne(id); // in-flight run owns terminalId "live1"
  svc.reapOrphans();
  expect(closed).toEqual(["tabO"]); // orphan only — unrelated + in-flight-owned spared
});

test("reapOrphans is a no-op when herdr is unavailable (optimizer)", async () => {
  const store = new SessionStore(":memory:");
  let closes = 0;
  const svc = new OptimizerService({
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
    promoter: fakePromoter(),
    onChange: () => {},
    now: () => 1000,
  } as never);
  expect(() => svc.reapOrphans()).not.toThrow();
  expect(closes).toBe(0);
});
