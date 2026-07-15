import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  MergeSuggestionService,
  MERGE_LABEL,
  pickSurvivor,
  crossRepoShortlist,
} from "../src/merge-suggest";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";
import type { Learning } from "../src/types";

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

/** Seed an ACTIVE rule and return it. */
function seedActive(store: SessionStore, repo: string, rule: string): Learning {
  const l = store.addLearning({ repoPath: repo, rule, rationale: "", evidence: [] });
  return store.setLearningStatus(l.id, "active")!;
}

/** mkDeps with a canned LLM output; `cap` records spawn argv/env, `started` counts spawns. */
function mkDeps(store: SessionStore, output: unknown, over: Record<string, unknown> = {}) {
  const cap: { argv: string[]; env: Record<string, string> | undefined; agent: string } = {
    argv: [],
    env: undefined,
    agent: "",
  };
  const started: number[] = [];
  return {
    cap,
    started,
    deps: {
      store,
      herdr: {
        start: async (
          agent: string,
          _dir: string,
          argv: string[],
          env?: Record<string, string>,
        ) => {
          cap.agent = agent;
          cap.argv = argv;
          cap.env = env;
          started.push(1);
          return { terminalId: "m1" };
        },
        stop: async () => {},
      } as never,
      scratch: { create: () => ({ dir: "/scratch/m" }), remove: () => {} },
      onChange: () => {},
      now: () => 1000,
      minRules: 2,
      crossMinRepos: 2,
      writeRules: () => {},
      readOutput: () => output as never,
      log: () => {},
      ...over,
    },
  };
}

// ── intra: clustering, persistence, survivor ────────────────────────────────

test("consider spawns + tick persists an intra merge suggestion (survivor = anchor)", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r", "Use bun, not npm");
  const b = seedActive(store, "/r", "Prefer bun over npm for installs");
  const { deps } = mkDeps(store, {
    groups: [
      {
        memberIds: [a.id, b.id],
        anchorId: a.id,
        mergedRule: "Use bun (not npm)",
        mergedRationale: "same",
      },
    ],
  });
  const svc = new MergeSuggestionService(deps);
  await svc.consider("/r");
  await svc.tick();
  const pending = store.listMergeSuggestions({ status: "pending" });
  expect(pending.length).toBe(1);
  expect(pending[0]!.kind).toBe("intra");
  expect(pending[0]!.targetId).toBe(a.id);
  expect(pending[0]!.sourceIds).toEqual([b.id]);
  expect(pending[0]!.mergedRule).toBe("Use bun (not npm)");
});

test("intra agent name uses the MERGE_LABEL prefix (reaper-safe)", async () => {
  const store = new SessionStore(":memory:");
  seedActive(store, "/r", "rule one");
  seedActive(store, "/r", "rule two");
  const { deps, cap } = mkDeps(store, { groups: [] });
  new MergeSuggestionService(deps).consider("/r");
  expect(cap.agent.startsWith(MERGE_LABEL)).toBe(true);
});

test("consider no-ops below minRules and when the active set is unchanged", async () => {
  const store = new SessionStore(":memory:");
  seedActive(store, "/r", "only one rule");
  const { deps, started } = mkDeps(store, { groups: [] }, { minRules: 2 });
  const svc = new MergeSuggestionService(deps);
  await svc.consider("/r"); // 1 active < 2
  expect(started.length).toBe(0);

  // Now enough rules → spawns once; after a successful tick the signature is stamped, so a
  // second consider over the SAME active set must not re-spawn.
  seedActive(store, "/r", "a second rule");
  await svc.consider("/r");
  await svc.tick();
  expect(started.length).toBe(1);
  await svc.consider("/r");
  expect(started.length).toBe(1); // unchanged set → no re-spawn
});

test("dismissed group is not re-suggested after a benign rule edit (id-only signature)", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r", "Use bun, not npm");
  const b = seedActive(store, "/r", "Prefer bun over npm");
  const out = {
    groups: [
      { memberIds: [a.id, b.id], anchorId: a.id, mergedRule: "Use bun", mergedRationale: "x" },
    ],
  };
  const { deps } = mkDeps(store, out);
  const svc = new MergeSuggestionService(deps);
  await svc.consider("/r");
  await svc.tick();
  const s = store.listMergeSuggestions({ status: "pending" })[0]!;
  store.setMergeSuggestionStatus(s.id, "dismissed");

  // Benign edit: reword a member (its id is unchanged) and re-run via the manual trigger.
  store.setLearningStatus(b.id, "active", "Prefer bun over npm for ALL installs");
  await svc.mergeNow("/r");
  await svc.tick();
  expect(store.listMergeSuggestions({ status: "pending" }).length).toBe(0);
});

test("intra: groups citing unknown ids or singletons are dropped", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r", "rule a");
  seedActive(store, "/r", "rule b");
  const { deps } = mkDeps(store, {
    groups: [
      { memberIds: [a.id, "hallucinated-id"], anchorId: a.id, mergedRule: "x" }, // only 1 valid → drop
      { memberIds: [a.id], anchorId: a.id, mergedRule: "y" }, // singleton → drop
    ],
  });
  const svc = new MergeSuggestionService(deps);
  await svc.mergeNow("/r");
  await svc.tick();
  expect(store.listMergeSuggestions({ status: "pending" }).length).toBe(0);
});

// ── cross-repo ──────────────────────────────────────────────────────────────

test("considerCrossRepo persists a cross suggestion for a rule recurring across repos", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r1", "Always write a regression test");
  const b = seedActive(store, "/r2", "Always write a regression test first");
  const { deps } = mkDeps(store, {
    groups: [{ memberIds: [a.id, b.id], canonicalRule: "Always write a regression test" }],
  });
  const svc = new MergeSuggestionService(deps);
  await svc.considerCrossRepo();
  await svc.tick();
  const cross = store.listMergeSuggestions({ kind: "cross", status: "pending" });
  expect(cross.length).toBe(1);
  expect(new Set(cross[0]!.repoPaths)).toEqual(new Set(["/r1", "/r2"]));
  expect(cross[0]!.targetId).toBeNull();
});

test("cross: a group whose members are all in one repo is rejected", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r1", "same rule");
  const b = seedActive(store, "/r2", "same rule"); // makes the pre-filter spawn
  // The LLM (wrongly) groups a with itself-in-one-repo; validation must require ≥2 repos.
  const { deps } = mkDeps(store, { groups: [{ memberIds: [a.id], canonicalRule: "same rule" }] });
  const svc = new MergeSuggestionService(deps);
  await svc.considerCrossRepo();
  await svc.tick();
  expect(store.listMergeSuggestions({ kind: "cross", status: "pending" }).length).toBe(0);
  void b;
});

test("cross: a group promoted to global (applied) is NOT re-suggested on a later pass (#872)", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r1", "Always write a regression test");
  const b = seedActive(store, "/r2", "Always write a regression test first");
  const out = {
    groups: [{ memberIds: [a.id, b.id], canonicalRule: "Always write a regression test" }],
  };
  const { deps, started } = mkDeps(store, out);
  const svc = new MergeSuggestionService(deps);
  await svc.considerCrossRepo();
  await svc.tick();
  const cross = store.listMergeSuggestions({ kind: "cross", status: "pending" });
  expect(cross.length).toBe(1);
  // Simulate promote-global: mark applied. The member rules stay ACTIVE (no retire), so the
  // dedup set must include `applied` or the same group re-appears next pass.
  store.setMergeSuggestionStatus(cross[0]!.id, "applied");

  // Change the global active set so the cross pass isn't gated out by an unchanged signature —
  // this forces a real second spawn that must then be suppressed by the dedup, not the gate.
  seedActive(store, "/r3", "An entirely unrelated active rule");
  await svc.considerCrossRepo();
  await svc.tick();
  expect(started.length).toBe(2); // the pass genuinely re-ran (not gated out before spawn)
  expect(store.listMergeSuggestions({ kind: "cross", status: "pending" }).length).toBe(0);
});

// ── provider-aware spawn contract ──────────────────────────────────────────

test("intra spawn: explicit Claude keeps writer-ro argv and persists the file result", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r", "Use bun, not npm");
  const b = seedActive(store, "/r", "Prefer bun over npm for installs");
  const { deps, cap } = mkDeps(
    store,
    {
      groups: [
        {
          memberIds: [a.id, b.id],
          anchorId: a.id,
          mergedRule: "Use bun, not npm",
          mergedRationale: "same guidance",
        },
      ],
    },
    { environment: () => ({ provider: "claude", model: "sonnet", effort: "high" }) },
  );

  const svc = new MergeSuggestionService(deps);
  await svc.mergeNow("/r");
  await svc.tick();

  expect(cap.argv[0]).toBe("claude");
  expect(cap.argv).toContain("--allowedTools");
  expect(cap.argv).toContain("Read");
  expect(cap.argv).toContain("Grep");
  expect(cap.argv).toContain("Glob");
  expect(cap.argv).toContain("Write");
  expect(cap.argv).toContain("--permission-mode");
  expect(cap.argv).toContain("dontAsk");
  expect(cap.argv).toContain("--model");
  expect(cap.argv).toContain("sonnet");
  expect(cap.argv).toContain("--effort");
  expect(cap.argv).toContain("high");
  expect(cap.argv.at(-1)).toContain("ONE repository");
  expect(store.listMergeSuggestions({ kind: "intra", status: "pending" })).toHaveLength(1);
});

test("intra spawn: resolved Codex uses codex exec and persists the file result", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r", "Use bun, not npm");
  const b = seedActive(store, "/r", "Prefer bun over npm for installs");
  const { deps, cap } = mkDeps(
    store,
    {
      groups: [
        {
          memberIds: [a.id, b.id],
          anchorId: a.id,
          mergedRule: "Use bun, not npm",
          mergedRationale: "same guidance",
        },
      ],
    },
    { environment: () => ({ provider: "codex", model: "gpt-5.5", effort: "high" }) },
  );

  const svc = new MergeSuggestionService(deps);
  await svc.mergeNow("/r");
  await svc.tick();

  expect(cap.argv).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=high",
    expect.stringContaining("ONE repository"),
  ]);
  expect(cap.env).toBeUndefined();
  expect(store.listMergeSuggestions({ kind: "intra", status: "pending" })).toHaveLength(1);
});

test("cross spawn: explicit Claude keeps writer-ro argv and persists the file result", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r1", "Always write a regression test");
  const b = seedActive(store, "/r2", "Always write a regression test first");
  const { deps, cap } = mkDeps(
    store,
    { groups: [{ memberIds: [a.id, b.id], canonicalRule: "Always write a regression test" }] },
    { environment: () => ({ provider: "claude", model: "sonnet", effort: "high" }) },
  );

  const svc = new MergeSuggestionService(deps);
  await svc.considerCrossRepo();
  await svc.tick();

  expect(cap.argv[0]).toBe("claude");
  expect(cap.argv).toContain("--allowedTools");
  expect(cap.argv).toContain("--permission-mode");
  expect(cap.argv).toContain("dontAsk");
  expect(cap.argv).toContain("--model");
  expect(cap.argv).toContain("sonnet");
  expect(cap.argv).toContain("--effort");
  expect(cap.argv).toContain("high");
  expect(cap.argv.at(-1)).toContain("MANY repositories");
  expect(store.listMergeSuggestions({ kind: "cross", status: "pending" })).toHaveLength(1);
});

test("cross spawn: resolved Codex uses codex exec and persists the file result", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r1", "Always write a regression test");
  const b = seedActive(store, "/r2", "Always write a regression test first");
  const { deps, cap } = mkDeps(
    store,
    { groups: [{ memberIds: [a.id, b.id], canonicalRule: "Always write a regression test" }] },
    { environment: () => ({ provider: "codex", model: "gpt-5.5", effort: "high" }) },
  );

  const svc = new MergeSuggestionService(deps);
  await svc.considerCrossRepo();
  await svc.tick();

  expect(cap.argv).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=high",
    expect.stringContaining("MANY repositories"),
  ]);
  expect(cap.env).toBeUndefined();
  expect(store.listMergeSuggestions({ kind: "cross", status: "pending" })).toHaveLength(1);
});

test("each actual spawn resolves a fresh environment", async () => {
  const store = new SessionStore(":memory:");
  seedActive(store, "/r", "rule one");
  seedActive(store, "/r", "rule two");
  let calls = 0;
  const { deps, cap } = mkDeps(
    store,
    { groups: [] },
    {
      environment: () => {
        calls++;
        return calls === 1
          ? { provider: "claude", model: "sonnet", effort: "low" }
          : { provider: "codex", model: "gpt-5.5", effort: "high" };
      },
    },
  );
  const svc = new MergeSuggestionService(deps);

  await svc.mergeNow("/r");
  await svc.tick();
  await svc.mergeNow("/r");

  expect(calls).toBe(2);
  expect(cap.argv.slice(0, 4)).toEqual(["codex", "exec", "--sandbox", "workspace-write"]);
  expect(cap.argv).toContain("gpt-5.5");
  expect(cap.argv).toContain("model_reasoning_effort=high");
});

// ── pure helpers ────────────────────────────────────────────────────────────

test("pickSurvivor: anchor wins; else most-injected; else earliest createdAt", async () => {
  const mk = (id: string, injectedCount: number, createdAt: number): Learning =>
    ({ id, injectedCount, createdAt }) as Learning;
  const m = [mk("a", 1, 100), mk("b", 5, 200), mk("c", 3, 50)];
  expect(pickSurvivor(m, "a").id).toBe("a"); // anchor (even though not most-injected)
  expect(pickSurvivor(m).id).toBe("b"); // highest injectedCount
  // tie on injectedCount → earliest createdAt: d(5,50) beats b(5,200)
  const tie = [mk("b", 5, 200), mk("d", 5, 50)];
  expect(pickSurvivor(tie).id).toBe("d");
});

test("crossRepoShortlist drops single-repo rules and caps with a reported drop", async () => {
  const mk = (id: string, repoPath: string, rule: string): Learning =>
    ({ id, repoPath, rule }) as Learning;
  const rules = [
    mk("1", "/r1", "always write a regression test"),
    mk("2", "/r2", "always write a regression test please"),
    mk("3", "/r1", "a totally unique rule unique to one repo only"),
  ];
  const { shortlist, dropped } = crossRepoShortlist(rules, 10);
  const ids = new Set(shortlist.map((r) => r.id));
  expect(ids.has("1")).toBe(true);
  expect(ids.has("2")).toBe(true);
  expect(ids.has("3")).toBe(false); // no cross-repo twin
  expect(dropped).toBe(0);

  const capped = crossRepoShortlist(rules, 1);
  expect(capped.shortlist.length).toBe(1);
  expect(capped.dropped).toBe(1);
});

// ── store primitives: citation + restore + counter preservation ─────────────

test("retireLearningMerged sets the citation; restore clears it; listSubsumed is status-scoped", async () => {
  const store = new SessionStore(":memory:");
  const survivor = seedActive(store, "/r", "survivor rule");
  const sub = seedActive(store, "/r", "subsumed rule");
  store.retireLearningMerged(sub.id, survivor.id);

  const retired = store.getLearning(sub.id)!;
  expect(retired.status).toBe("retired");
  expect(retired.retiredReason).toBe("merged");
  expect(retired.mergedIntoId).toBe(survivor.id);
  expect(store.listSubsumedLearnings(survivor.id).map((l) => l.id)).toEqual([sub.id]);

  // Restore clears the citation AND drops it from the survivor's subsumed list.
  store.restoreLearning(sub.id);
  expect(store.getLearning(sub.id)!.mergedIntoId).toBeNull();
  expect(store.listSubsumedLearnings(survivor.id).length).toBe(0);
});

test("mergeLearning preserves the survivor's effectiveness counters", async () => {
  const store = new SessionStore(":memory:");
  const a = seedActive(store, "/r", "rule a");
  store.attributeInjected([a.id], { good: true }); // injected=1 helpful=1
  store.attributeInjected([a.id], { good: false }); // injected=2 helpful=1
  store.mergeLearning(a.id, "rule a — merged richer text");
  const after = store.getLearning(a.id)!;
  expect(after.rule).toBe("rule a — merged richer text");
  expect(after.injectedCount).toBe(2);
  expect(after.helpfulCount).toBe(1);
});

// ── fail-closed ─────────────────────────────────────────────────────────────

test("api-key mode without a configured key fails closed (no spawn)", async () => {
  withAuth("api-key", null, () => {
    const store = new SessionStore(":memory:");
    seedActive(store, "/r", "rule a");
    seedActive(store, "/r", "rule b");
    const { deps, started } = mkDeps(
      store,
      { groups: [] },
      {
        environment: () => ({ provider: "claude", model: null, effort: null }),
      },
    );
    new MergeSuggestionService(deps).mergeNow("/r");
    expect(started.length).toBe(0);
  });
});

test("api-key mode without an Anthropic key does not block resolved Codex", async () => {
  const previousMode = config.authMode;
  const previousHelper = config.authApiKeyHelperPath;
  config.authMode = "api-key";
  config.authApiKeyHelperPath = null;
  try {
    const store = new SessionStore(":memory:");
    seedActive(store, "/r", "rule one");
    seedActive(store, "/r", "rule two");
    const { deps, started, cap } = mkDeps(
      store,
      { groups: [] },
      {
        environment: () => ({ provider: "codex", model: null, effort: null }),
      },
    );

    await new MergeSuggestionService(deps).mergeNow("/r");

    expect(started).toHaveLength(1);
    expect(cap.argv.slice(0, 4)).toEqual(["codex", "exec", "--sandbox", "workspace-write"]);
  } finally {
    config.authMode = previousMode;
    config.authApiKeyHelperPath = previousHelper;
  }
});

// ── boot reapOrphans (issue #1135) ──────────────────────────────────────────

test("reapOrphans closes orphaned __merge__ tabs, sparing unrelated + inflight-owned", async () => {
  const store = new SessionStore(":memory:");
  seedActive(store, "/r", "Use bun, not npm");
  seedActive(store, "/r", "Prefer bun over npm for installs");
  const closed: string[] = [];
  const listed = [
    { name: MERGE_LABEL + "deadbeef", terminalId: "orphan1", tabId: "tabO" },
    { name: "some-session", terminalId: "u1", tabId: "tabU" },
    { name: MERGE_LABEL + "live0001", terminalId: "m1", tabId: "tabL" },
  ];
  const svc = new MergeSuggestionService({
    store,
    herdr: {
      start: async () => ({ terminalId: "m1" }),
      stop: async () => {},
      list: () => listed,
      closeTab: async (t: string) => closed.push(t),
    },
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minRules: 2,
    writeRules: () => {},
    readOutput: () => null, // run stays in flight (not finalized)
    log: () => {},
  } as never);
  await svc.consider("/r"); // in-flight run owns terminalId "m1"
  svc.reapOrphans();
  expect(closed).toEqual(["tabO"]); // orphan only — unrelated + in-flight-owned spared
});

test("reapOrphans is a no-op when herdr is unavailable (merge-suggest)", async () => {
  const store = new SessionStore(":memory:");
  let closes = 0;
  const svc = new MergeSuggestionService({
    store,
    herdr: {
      start: async () => ({ terminalId: "t" }),
      stop: async () => {},
      list: () => {
        throw new Error("herdr down");
      },
      closeTab: async () => {
        closes++;
      },
    },
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    log: () => {},
  } as never);
  expect(() => svc.reapOrphans()).not.toThrow();
  expect(closes).toBe(0);
});
