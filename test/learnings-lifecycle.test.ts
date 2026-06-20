import { test, expect, describe } from "bun:test";
import {
  wilsonLowerBound,
  isGoodOutcome,
  repoBaseRate,
  shouldRetire,
  runAutoRetire,
  AUTO_RETIRE_REASON,
  WILSON_Z,
  RETIRE_N_MIN,
  DEFAULT_BASE_RATE,
  BASE_RATE_MIN_N,
  MAX_RETIRE_PER_SWEEP,
  type AutoRetireDeps,
} from "../src/learnings-lifecycle";
import type { Learning, ReviewVerdict } from "../src/types";
import type { RepoConfig } from "../src/store";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeLearning(o: Partial<Learning> & { id: string }): Learning {
  return {
    repoPath: "/repo",
    rule: "Use X over Y",
    rationale: "rationale",
    evidence: [],
    status: "active",
    evidenceCount: 0,
    ineffectiveCount: 0,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    retiredReason: null,
    scopeGlobs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEvidenceAt: null,
    promotedPrUrl: null,
    mergedIntoId: null,
    ...o,
  };
}

function makeVerdict(
  o: Partial<ReviewVerdict> & { decision: ReviewVerdict["decision"] },
): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "abc",
    patchId: "",
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
    updatedAt: Date.now(),
    ...o,
  };
}

function makeRepoConfig(o: Partial<RepoConfig> = {}): RepoConfig {
  return {
    criticEnabled: false,
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
    autoOptimizeFlagged: false,
    ...o,
  };
}

// ── fake store + optimizer ────────────────────────────────────────────────────

function makeFakeDeps(opts: {
  repoPaths?: string[];
  active?: Learning[];
  retired?: Learning[];
  cfg?: Partial<RepoConfig>;
  autoOptimizedAtMap?: Record<string, number | null>;
}) {
  const active = opts.active ?? [];
  const retired = opts.retired ?? [];
  const cfg = makeRepoConfig(opts.cfg ?? {});
  const retiredByStore: Learning[] = [];
  const optimizeCalls: string[] = [];
  const autoOptimizedAtMap = opts.autoOptimizedAtMap ?? {};

  const store: AutoRetireDeps["store"] = {
    listRepoPathsWithInjectableLearnings: () =>
      opts.repoPaths ?? [...new Set(active.map((r) => r.repoPath))],
    listActiveLearnings: (_repoPath) => active.filter((r) => r.repoPath === _repoPath),
    listRetiredLearnings: (_repoPath) => retired.filter((r) => r.repoPath === _repoPath),
    getRepoConfig: () => cfg,
    autoOptimizedAt: (id) => autoOptimizedAtMap[id] ?? null,
    retireLearning: (id, _reason) => {
      const r = active.find((x) => x.id === id);
      if (!r) return null;
      const retired: Learning = {
        ...r,
        status: "retired",
        retiredAt: Date.now(),
        retiredReason: _reason,
      };
      retiredByStore.push(retired);
      // remove from active so second sweep sees it gone
      const idx = active.findIndex((x) => x.id === id);
      if (idx !== -1) active.splice(idx, 1);
      return retired;
    },
  };

  const optimizer: AutoRetireDeps["optimizer"] = {
    optimizeOne: (id) => {
      optimizeCalls.push(id);
    },
  };

  return { store, optimizer, retiredByStore, optimizeCalls };
}

// ── wilsonLowerBound ──────────────────────────────────────────────────────────

describe("wilsonLowerBound", () => {
  test("n=0 → 0 (no evidence)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test("helpful=8, n=10, z=1.96 ≈ 0.49 (±0.01)", () => {
    const w = wilsonLowerBound(8, 10, 1.96);
    expect(w).toBeGreaterThan(0.48);
    expect(w).toBeLessThan(0.5);
  });

  test("0 successes out of many → small but non-negative (clamped ≥0)", () => {
    const w = wilsonLowerBound(0, 20);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThan(0.1);
  });

  test("all successes → < 1 and rises with n", () => {
    const w5 = wilsonLowerBound(5, 5);
    const w20 = wilsonLowerBound(20, 20);
    expect(w5).toBeLessThan(1);
    expect(w20).toBeLessThan(1);
    expect(w20).toBeGreaterThan(w5); // more evidence → tighter bound, higher lower end
  });

  test("monotonic: more successes at fixed n raises the bound", () => {
    const n = 10;
    const w3 = wilsonLowerBound(3, n);
    const w5 = wilsonLowerBound(5, n);
    const w8 = wilsonLowerBound(8, n);
    expect(w5).toBeGreaterThan(w3);
    expect(w8).toBeGreaterThan(w5);
  });

  test("result clamped to [0, 1]", () => {
    const w = wilsonLowerBound(10, 10);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
  });
});

// ── isGoodOutcome ─────────────────────────────────────────────────────────────

describe("isGoodOutcome", () => {
  test("commented + 0 findings → true", () => {
    expect(isGoodOutcome(makeVerdict({ decision: "commented", findings: [] }), 0)).toBe(true);
  });

  test("commented + non-empty findings → false", () => {
    expect(isGoodOutcome(makeVerdict({ decision: "commented", findings: ["fix X"] }), 0)).toBe(
      false,
    );
  });

  test("changes_requested → false", () => {
    expect(isGoodOutcome(makeVerdict({ decision: "changes_requested", findings: [] }), 0)).toBe(
      false,
    );
  });

  test("error → false", () => {
    expect(isGoodOutcome(makeVerdict({ decision: "error", findings: [] }), 0)).toBe(false);
  });

  test("null review + 0 blocking signals → true", () => {
    expect(isGoodOutcome(null, 0)).toBe(true);
  });

  test("null review + blocking signals > 0 → false", () => {
    expect(isGoodOutcome(null, 1)).toBe(false);
    expect(isGoodOutcome(null, 3)).toBe(false);
  });
});

// ── repoBaseRate ──────────────────────────────────────────────────────────────

describe("repoBaseRate", () => {
  test("total injected < minN → defaultRate", () => {
    const rules = [makeLearning({ id: "a", injectedCount: 5, helpfulCount: 5 })];
    const rate = repoBaseRate(rules, { defaultRate: 0.5, minN: 20 });
    expect(rate).toBe(0.5);
  });

  test("total injected at minN → true ratio", () => {
    const rules = [
      makeLearning({ id: "a", injectedCount: 10, helpfulCount: 8 }),
      makeLearning({ id: "b", injectedCount: 10, helpfulCount: 6 }),
    ];
    // 20 total, 14 helpful → 0.7
    const rate = repoBaseRate(rules, { defaultRate: 0.5, minN: 20 });
    expect(rate).toBeCloseTo(0.7, 5);
  });

  test("total injected > minN → true ratio", () => {
    const rules = [makeLearning({ id: "a", injectedCount: 30, helpfulCount: 15 })];
    const rate = repoBaseRate(rules, { defaultRate: 0.5, minN: 20 });
    expect(rate).toBeCloseTo(0.5, 5);
  });

  test("rules with injectedCount=0 excluded from denominator", () => {
    const rules = [
      makeLearning({ id: "a", injectedCount: 0, helpfulCount: 0 }),
      makeLearning({ id: "b", injectedCount: 20, helpfulCount: 10 }),
    ];
    const rate = repoBaseRate(rules, { defaultRate: 0.99, minN: 20 });
    expect(rate).toBeCloseTo(0.5, 5);
  });

  test("includes retired rules in denominator (prevents survivorship cascade)", () => {
    // bad retired rule + good active rules; retired keeps base low
    const retiredBad = makeLearning({
      id: "r1",
      status: "retired",
      injectedCount: 20,
      helpfulCount: 0,
    });
    const activeGood = makeLearning({
      id: "a1",
      status: "active",
      injectedCount: 20,
      helpfulCount: 18,
    });
    // combined: 40 injected, 18 helpful → 0.45; without retired: 18/20 = 0.9
    const rate = repoBaseRate([retiredBad, activeGood], { defaultRate: 0.5, minN: 20 });
    expect(rate).toBeCloseTo(18 / 40, 5);
  });

  test("defaults: uses BASE_RATE_MIN_N and DEFAULT_BASE_RATE when opts omitted", () => {
    const rules = [makeLearning({ id: "a", injectedCount: 2, helpfulCount: 1 })];
    // 2 < BASE_RATE_MIN_N (20) → should return DEFAULT_BASE_RATE (0.5)
    const rate = repoBaseRate(rules);
    expect(rate).toBe(DEFAULT_BASE_RATE);
  });
});

// ── shouldRetire ──────────────────────────────────────────────────────────────

describe("shouldRetire", () => {
  const baseRate = 0.5;

  test("all gates pass → true", () => {
    // ineffectiveCount>0, injectedCount>=8, wilson bound < baseRate
    const rule = makeLearning({ id: "a", ineffectiveCount: 2, injectedCount: 10, helpfulCount: 1 });
    expect(shouldRetire(rule, baseRate)).toBe(true);
  });

  test("ineffectiveCount=0 → false (not flagged as bad)", () => {
    const rule = makeLearning({ id: "a", ineffectiveCount: 0, injectedCount: 10, helpfulCount: 1 });
    expect(shouldRetire(rule, baseRate)).toBe(false);
  });

  test("injectedCount < nMin → false (not enough data)", () => {
    const rule = makeLearning({ id: "a", ineffectiveCount: 3, injectedCount: 5, helpfulCount: 0 });
    expect(shouldRetire(rule, baseRate, { nMin: 8 })).toBe(false);
  });

  test("injectedCount === nMin → eligible (boundary inclusive)", () => {
    // helpfulCount=0 → wilson bound near 0 < 0.5
    const rule = makeLearning({ id: "a", ineffectiveCount: 1, injectedCount: 8, helpfulCount: 0 });
    expect(shouldRetire(rule, baseRate, { nMin: 8 })).toBe(true);
  });

  test("wilson bound >= baseRate → false (performing adequately)", () => {
    // helpful=8, n=8 → high wilson bound >> 0.5
    const rule = makeLearning({ id: "a", ineffectiveCount: 1, injectedCount: 8, helpfulCount: 8 });
    expect(shouldRetire(rule, 0.5)).toBe(false);
  });

  test("uses custom z via opts", () => {
    const rule = makeLearning({ id: "a", ineffectiveCount: 1, injectedCount: 10, helpfulCount: 1 });
    // with huge z, the interval is very wide → lower bound might flip
    const withDefault = shouldRetire(rule, baseRate);
    const withTinyZ = shouldRetire(rule, baseRate, { z: 0.001 });
    // Both should pass since helpfulCount=1/10 is well below 0.5 regardless of z
    expect(withDefault).toBe(true);
    expect(withTinyZ).toBe(true);
  });

  test("#842: a scope-gated rule never injected (injectedCount=0) is not auto-retired", () => {
    // A glob-scoped rule whose globs never matched a task stays at injectedCount=0.
    // Even flagged ineffective, the nMin gate (injectedCount < nMin) must spare it —
    // scoping must never turn into unfair retirement.
    const scopedUnmatched = makeLearning({
      id: "s",
      scopeGlobs: ["src/**"],
      injectedCount: 0,
      ineffectiveCount: 3,
      helpfulCount: 0,
    });
    expect(shouldRetire(scopedUnmatched, baseRate)).toBe(false);
  });
});

// ── runAutoRetire ─────────────────────────────────────────────────────────────

describe("runAutoRetire", () => {
  test("retires only active rules meeting all gates; promoted with same bad stats NOT retired", () => {
    // bad active rule (helpfulCount=0, injectedCount=10, ineffectiveCount=3)
    const active = makeLearning({
      id: "active1",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 3,
    });
    // promoted with identical bad stats — should NOT be touched
    const promoted = makeLearning({
      id: "promoted1",
      repoPath: "/repo",
      status: "promoted",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 3,
    });
    // A retired rule with good stats to keep base rate above 0
    // (combined: 40 injected, 20 helpful → 0.5 base rate; wilson(0,10) ≈ 0 < 0.5 → retires)
    const goodRetired = makeLearning({
      id: "good-retired",
      repoPath: "/repo",
      status: "retired",
      injectedCount: 20,
      helpfulCount: 20,
      ineffectiveCount: 0,
    });

    const { store, optimizer, optimizeCalls } = makeFakeDeps({
      active: [active, promoted],
      retired: [goodRetired],
    });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 5 });

    expect(result.map((r) => r.id)).toEqual(["active1"]);
    expect(optimizeCalls).toHaveLength(0);
  });

  test("per-sweep cap honored: ≥4 eligible → only maxRetirePerSweep retired", () => {
    const bad = (id: string) =>
      makeLearning({
        id,
        repoPath: "/repo",
        status: "active",
        injectedCount: 10,
        helpfulCount: 0,
        ineffectiveCount: 2,
      });
    // good retired rule keeps base rate > 0 so bad rules actually qualify
    const goodRetired = makeLearning({
      id: "good-retired",
      repoPath: "/repo",
      status: "retired",
      injectedCount: 20,
      helpfulCount: 20,
      ineffectiveCount: 0,
    });

    const { store, optimizer } = makeFakeDeps({
      active: [bad("a"), bad("b"), bad("c"), bad("d")],
      retired: [goodRetired],
    });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 2 });

    expect(result).toHaveLength(2);
  });

  test("auto-optimize branch: flag ON + not yet optimized → optimizeOne called, NOT retired", () => {
    const rule = makeLearning({
      id: "r1",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 2,
    });

    const { store, optimizer, optimizeCalls } = makeFakeDeps({
      active: [rule],
      retired: [],
      cfg: { autoOptimizeFlagged: true },
      autoOptimizedAtMap: { r1: null },
    });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 5 });

    expect(result).toHaveLength(0); // NOT retired
    expect(optimizeCalls).toEqual(["r1"]); // optimizeOne called
  });

  test("auto-optimize branch: flag ON + already optimized → retired normally", () => {
    const rule = makeLearning({
      id: "r2",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 2,
    });

    const { store, optimizer, optimizeCalls } = makeFakeDeps({
      active: [rule],
      retired: [],
      cfg: { autoOptimizeFlagged: true },
      autoOptimizedAtMap: { r2: Date.now() - 1000 },
    });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 5 });

    expect(result.map((r) => r.id)).toEqual(["r2"]);
    expect(optimizeCalls).toHaveLength(0);
  });

  test("auto-optimize branch: flag OFF → retire directly regardless of autoOptimizedAt", () => {
    const rule = makeLearning({
      id: "r3",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 2,
    });

    const { store, optimizer, optimizeCalls } = makeFakeDeps({
      active: [rule],
      retired: [],
      cfg: { autoOptimizeFlagged: false },
      autoOptimizedAtMap: { r3: null },
    });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 5 });

    expect(result.map((r) => r.id)).toEqual(["r3"]);
    expect(optimizeCalls).toHaveLength(0);
  });

  test("auto-optimize does NOT consume retire budget", () => {
    // 2 rules: first gets optimize path (no retire), second should still retire within cap
    const opt = makeLearning({
      id: "opt1",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 2,
    });
    const ret = makeLearning({
      id: "ret1",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 2,
    });
    // good retired rule keeps base rate > 0
    const goodRetired = makeLearning({
      id: "good-retired",
      repoPath: "/repo",
      status: "retired",
      injectedCount: 20,
      helpfulCount: 20,
      ineffectiveCount: 0,
    });

    // make opt1 get optimize path (autoOptimizedAt=null), ret1 get retire path (already optimized)
    const { store, optimizer, optimizeCalls } = makeFakeDeps({
      active: [opt, ret],
      retired: [goodRetired],
      cfg: { autoOptimizeFlagged: true },
      autoOptimizedAtMap: { opt1: null, ret1: Date.now() - 1000 },
    });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 1 });

    // ret1 retires (budget=1, not consumed by opt1)
    expect(result.map((r) => r.id)).toEqual(["ret1"]);
    expect(optimizeCalls).toEqual(["opt1"]);
  });

  test("no cascade: stable corpus retires only the bad rule; second sweep retires nothing", () => {
    // 1 genuinely bad rule + several good rules
    const bad = makeLearning({
      id: "bad",
      repoPath: "/repo",
      status: "active",
      injectedCount: 20,
      helpfulCount: 0,
      ineffectiveCount: 5,
    });
    const good1 = makeLearning({
      id: "good1",
      repoPath: "/repo",
      status: "active",
      injectedCount: 20,
      helpfulCount: 18,
      ineffectiveCount: 1,
    });
    const good2 = makeLearning({
      id: "good2",
      repoPath: "/repo",
      status: "active",
      injectedCount: 20,
      helpfulCount: 17,
      ineffectiveCount: 1,
    });

    const activeList = [bad, good1, good2];
    const retiredList: Learning[] = [];

    const { store, optimizer } = makeFakeDeps({
      active: activeList,
      retired: retiredList,
    });

    // First sweep: only bad retires
    const sweep1 = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 10 });
    expect(sweep1.map((r) => r.id)).toEqual(["bad"]);

    // Move bad to retired array to simulate store state for next sweep
    const retiredBad: Learning = { ...bad, status: "retired" };
    retiredList.push(retiredBad);

    // Second sweep: base rate now computed incl. retired bad rule → good rules survive
    const sweep2 = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 10 });
    expect(sweep2).toHaveLength(0);
  });

  test("returns correct RetiredRecord shape", () => {
    const rule = makeLearning({
      id: "r4",
      repoPath: "/myrepo",
      rule: "Prefer async/await",
      status: "active",
      injectedCount: 12,
      helpfulCount: 2,
      ineffectiveCount: 4,
    });

    const { store, optimizer } = makeFakeDeps({ active: [rule], retired: [] });

    const result = runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 5 });

    expect(result).toHaveLength(1);
    const rec = result[0]!;
    expect(rec.repoPath).toBe("/myrepo");
    expect(rec.id).toBe("r4");
    expect(rec.rule).toBe("Prefer async/await");
    expect(rec.helpfulCount).toBe(2);
    expect(rec.injectedCount).toBe(12);
    expect(rec.ineffectiveCount).toBe(4);
  });

  test("AUTO_RETIRE_REASON passed to retireLearning", () => {
    const rule = makeLearning({
      id: "reason-check",
      repoPath: "/repo",
      status: "active",
      injectedCount: 10,
      helpfulCount: 0,
      ineffectiveCount: 2,
    });

    let capturedReason: string | undefined;
    const active = [rule];

    const store: AutoRetireDeps["store"] = {
      listRepoPathsWithInjectableLearnings: () => ["/repo"],
      listActiveLearnings: () => active,
      listRetiredLearnings: () => [],
      getRepoConfig: () => makeRepoConfig(),
      autoOptimizedAt: () => null,
      retireLearning: (id, reason) => {
        capturedReason = reason;
        const r = active.find((x) => x.id === id)!;
        return { ...r, status: "retired", retiredAt: Date.now(), retiredReason: reason };
      },
    };

    const optimizer: AutoRetireDeps["optimizer"] = { optimizeOne: () => {} };
    runAutoRetire({ store, optimizer, nMin: 8, maxRetirePerSweep: 5 });

    expect(capturedReason).toBe(AUTO_RETIRE_REASON);
  });

  test("exported constants have expected defaults", () => {
    expect(WILSON_Z).toBe(1.96);
    expect(RETIRE_N_MIN).toBe(8);
    expect(DEFAULT_BASE_RATE).toBe(0.5);
    expect(BASE_RATE_MIN_N).toBe(20);
    expect(MAX_RETIRE_PER_SWEEP).toBe(3);
    expect(AUTO_RETIRE_REASON).toBe("auto-retire");
  });
});
