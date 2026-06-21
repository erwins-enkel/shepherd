import { test, expect } from "bun:test";
import {
  HOUSE_RULES_OVERHEAD,
  HOUSE_RULES_TAG,
  DAY_MS,
  envNum,
  planHouseRulesInjection,
  prioritize,
  renderHouseRulesBlock,
  extractTargetPaths,
  normalizeExtractedPath,
  normalizeGlob,
  learningMatchesScope,
} from "../src/house-rules";
import type { Learning } from "../src/types";

function rule(p: Partial<Learning>): Learning {
  return {
    id: p.id ?? crypto.randomUUID(),
    repoPath: "/repo",
    rule: p.rule ?? "r",
    rationale: "",
    evidence: [],
    status: "active",
    evidenceCount: 0,
    ineffectiveCount: 0,
    helpfulCount: p.helpfulCount ?? 0,
    injectedCount: p.injectedCount ?? 0,
    lastUsedAt: p.lastUsedAt ?? null,
    retiredAt: null,
    retiredReason: null,
    scopeGlobs: p.scopeGlobs ?? [],
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
    lastEvidenceAt: p.lastEvidenceAt ?? null,
    promotedPrUrl: p.promotedPrUrl ?? null,
    mergedIntoId: p.mergedIntoId ?? null,
    trialedAt: p.trialedAt ?? null,
    distinctKinds: p.distinctKinds ?? 0,
    distinctSessions: p.distinctSessions ?? 0,
  };
}

// ── composite sort ─────────────────────────────────────────────────────────────

// Replaces the old two-key (lastEvidenceAt desc, updatedAt desc) test.
// With the composite score and a `now` far in the past of these timestamps
// (all timestamps are tiny ms values relative to a now=10_000 * DAY_MS),
// recency is near-zero for all — the tie is broken by updatedAt desc.
test("priority: composite score, tie-break updatedAt desc", () => {
  // now is very large so all rules are ancient → recency ≈ 0 for all.
  // Help component differentiates: all have injectedCount=0 → helpComponent is the neutral prior (equal).
  // So score is equal for all → updatedAt desc breaks the tie.
  const now = 10_000 * DAY_MS;
  const a = rule({ id: "a", rule: "a", lastEvidenceAt: 100, updatedAt: 1 });
  const b = rule({ id: "b", rule: "b", lastEvidenceAt: 200, updatedAt: 2 });
  const c = rule({ id: "c", rule: "c", lastEvidenceAt: null, updatedAt: 50 });
  const d = rule({ id: "d", rule: "d", lastEvidenceAt: null, updatedAt: 80 });
  // All have lastUsedAt=null, lastEvidenceAt tiny relative to now → recency near-0 for all.
  // Equal help (all 0/0) → equal score → sorted by updatedAt desc: d(80), c(50), b(2), a(1).
  const plan = planHouseRulesInjection([a, b, c, d], 10_000, now);
  expect(plan.injected.map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
});

// ── new composite-specific tests ───────────────────────────────────────────────

test("recency decays on lastUsedAt: recently-used ranks above stale", () => {
  const now = 100 * DAY_MS;
  const A = rule({ id: "A", lastUsedAt: now - 1 * DAY_MS });
  const B = rule({ id: "B", lastUsedAt: now - 60 * DAY_MS });
  // Both injectedCount=0, equal help — recency wins.
  expect(prioritize([B, A], now).map((r) => r.id)).toEqual(["A", "B"]);
});

test("effectiveLastUsed uses lastUsedAt not lastEvidenceAt when lastUsedAt is set", () => {
  const now = 100 * DAY_MS;
  // A: lastUsedAt=now (very recent), lastEvidenceAt=now-90d (old) → effectiveLastUsed=now
  const A = rule({ id: "A", lastUsedAt: now, lastEvidenceAt: now - 90 * DAY_MS });
  // B: lastUsedAt=now-90d (old), lastEvidenceAt=now (recent) → effectiveLastUsed=now-90d (lastUsedAt wins)
  const B = rule({ id: "B", lastUsedAt: now - 90 * DAY_MS, lastEvidenceAt: now });
  // A has recent effectiveLastUsed; B's recent lastEvidenceAt is ignored because lastUsedAt is set.
  expect(prioritize([B, A], now).map((r) => r.id)).toEqual(["A", "B"]);
});

test("proven outranks lucky (help component: smoothed mean)", () => {
  const now = 100 * DAY_MS;
  // Same recency for both.
  const P = rule({ id: "P", lastUsedAt: now, helpfulCount: 50, injectedCount: 60 });
  const L = rule({ id: "L", lastUsedAt: now, helpfulCount: 1, injectedCount: 1 });
  // Smoothed: P=(50 + 4*0.5)/(60+4)=52/64≈0.81; L=(1+2)/(1+4)=3/5=0.60
  expect(prioritize([L, P], now).map((r) => r.id)).toEqual(["P", "L"]);
});

test("no inversion: lightly-helped outranks unproven (fixed prior, not Wilson LB)", () => {
  const now = 100 * DAY_MS;
  const H = rule({ id: "H", lastUsedAt: now, helpfulCount: 1, injectedCount: 1 });
  const U = rule({ id: "U", lastUsedAt: now, helpfulCount: 0, injectedCount: 0 });
  // Smoothed: H=(1+2)/(1+4)=0.60; U=(0+2)/(0+4)=0.50. H > U.
  // Would FAIL under Wilson LB: wilson(1,1)≈0.21 < 0.5, inverting the order.
  expect(prioritize([U, H], now).map((r) => r.id)).toEqual(["H", "U"]);
});

test("determinism tie-break: higher updatedAt sorts first on identical score inputs", () => {
  // Setup designed to diverge on old vs new comparator:
  //   New: effectiveLastUsed = lastUsedAt (set) → both = now → equal recency + equal help (0/0)
  //        → score tie → updatedAt desc → Y(2) before X(1) → ["y","x"]
  //   Old: lastEvidenceAt desc nulls-last → X(200) before Y(100) → ["x","y"]  ← assertion fails
  const now = 100 * DAY_MS;
  const X = rule({ id: "x", lastUsedAt: now, lastEvidenceAt: 200, updatedAt: 1 });
  const Y = rule({ id: "y", lastUsedAt: now, lastEvidenceAt: 100, updatedAt: 2 });
  expect(prioritize([X, Y], now).map((r) => r.id)).toEqual(["y", "x"]);
});

// ── trial tier tests ──────────────────────────────────────────────────────────

test("prioritize: high-score unproven trial sorts AFTER low-score non-trial", () => {
  const now = 100 * DAY_MS;
  // Unproven trial: trialedAt set, helpfulCount=0 (high injected → lower help score, but still a trial)
  const trial = rule({
    id: "trial",
    trialedAt: now,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: now, // recency=1, max possible recency
  });
  // Non-trial: trialedAt=null, very low score (stale, unproven)
  const nonTrial = rule({
    id: "nonTrial",
    trialedAt: null,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: 0, // very old → recency near 0
  });
  // Despite `trial` having better recency, `nonTrial` must sort first (non-trial tier)
  expect(prioritize([trial, nonTrial], now).map((r) => r.id)).toEqual(["nonTrial", "trial"]);
});

test("prioritize: proven trial (helpfulCount>0) is NOT tiered, orders by score", () => {
  const now = 100 * DAY_MS;
  // Proven trial: trialedAt set BUT helpfulCount>0 → not an unproven trial
  const provenTrial = rule({
    id: "provenTrial",
    trialedAt: now,
    helpfulCount: 5,
    injectedCount: 5,
    lastUsedAt: now - 1 * DAY_MS,
  });
  // Non-trial with worse score
  const nonTrial = rule({
    id: "nonTrial",
    trialedAt: null,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: 0, // very old
  });
  // provenTrial has better score than nonTrial → it wins by score (no tier penalty)
  const result = prioritize([nonTrial, provenTrial], now).map((r) => r.id);
  expect(result[0]).toBe("provenTrial");
});

test("planHouseRulesInjection: all non-trials appear before any unproven trial in injected", () => {
  const now = 100 * DAY_MS;
  const alwaysTrial = rule({
    id: "aTrial",
    rule: "always trial",
    trialedAt: now,
    helpfulCount: 0,
    scopeGlobs: [],
    lastUsedAt: now,
  });
  const scopedTrial = rule({
    id: "sTrial",
    rule: "scoped trial",
    trialedAt: now,
    helpfulCount: 0,
    scopeGlobs: ["src/**"],
    lastUsedAt: now,
  });
  const alwaysNonTrial = rule({
    id: "aNT",
    rule: "always non-trial",
    trialedAt: null,
    scopeGlobs: [],
    lastUsedAt: now - 1 * DAY_MS,
  });
  const scopedNonTrial = rule({
    id: "sNT",
    rule: "scoped non-trial",
    trialedAt: null,
    scopeGlobs: ["src/**"],
    lastUsedAt: now - 2 * DAY_MS,
  });
  const plan = planHouseRulesInjection(
    [alwaysTrial, scopedTrial, alwaysNonTrial, scopedNonTrial],
    10_000,
    now,
    ["src/foo.ts"],
  );
  const ids = plan.injected.map((r) => r.id);
  // All non-trials must precede all trials
  const nonTrialPositions = ["aNT", "sNT"].map((id) => ids.indexOf(id));
  const trialPositions = ["aTrial", "sTrial"].map((id) => ids.indexOf(id));
  expect(nonTrialPositions.every((p) => p !== -1)).toBe(true);
  expect(trialPositions.every((p) => p !== -1)).toBe(true);
  expect(Math.max(...nonTrialPositions)).toBeLessThan(Math.min(...trialPositions));
});

test("planHouseRulesInjection drop-first: once a non-trial is dropped, no trial is injected", () => {
  const now = 100 * DAY_MS;
  // A long non-trial Always-rule that doesn't fit, ensuring nonTrialDropped=true
  const longNonTrial = rule({
    id: "longNT",
    rule: "x".repeat(500),
    trialedAt: null,
    scopeGlobs: [],
  });
  // A short unproven trial that WOULD fit on its own
  const shortTrial = rule({
    id: "shortTrial",
    rule: "ok",
    trialedAt: now,
    helpfulCount: 0,
    scopeGlobs: [],
  });
  // Budget: overhead + cost of "ok" only (no room for the long rule)
  const budget = HOUSE_RULES_OVERHEAD + "- ok\n".length;
  const plan = planHouseRulesInjection([longNonTrial, shortTrial], budget, now);
  // longNT dropped → nonTrialDropped=true → shortTrial must NOT be injected
  expect(plan.injected.map((r) => r.id)).toEqual([]);
  expect(plan.dropped.map((r) => r.id).sort()).toEqual(["longNT", "shortTrial"].sort());
});

test("planHouseRulesInjection: proven matched-scoped injected ahead of unproven Always trial when budget forces choice", () => {
  const now = 100 * DAY_MS;
  // Unproven Always trial (pass C)
  const alwaysTrial = rule({
    id: "aTrial",
    rule: "always trial rule here",
    trialedAt: now,
    helpfulCount: 0,
    scopeGlobs: [],
  });
  // Proven matched-scoped non-trial (pass B)
  const scopedProven = rule({
    id: "sProven",
    rule: "scoped proven",
    trialedAt: null,
    helpfulCount: 3,
    injectedCount: 5,
    scopeGlobs: ["src/**"],
    lastUsedAt: now - 1 * DAY_MS,
  });
  // Budget: overhead + cost of exactly one of them (scoped proven is shorter)
  const scopedCost = "- scoped proven\n".length;
  const budget = HOUSE_RULES_OVERHEAD + scopedCost;
  const plan = planHouseRulesInjection([alwaysTrial, scopedProven], budget, now, ["src/foo.ts"]);
  // B (scoped non-trial) fills before C (always trial) → sProven injected, aTrial dropped
  expect(plan.injected.map((r) => r.id)).toEqual(["sProven"]);
  expect(plan.dropped.map((r) => r.id)).toEqual(["aTrial"]);
});

// ── budget / greedy / render tests (unchanged) ─────────────────────────────────

test("greedy fill picks rules that fit within budget", () => {
  // Both rules equally ancient (lastEvidenceAt only, no lastUsedAt). a has higher lastEvidenceAt.
  const now = 10_000 * DAY_MS;
  const a = rule({ id: "a", rule: "x".repeat(20), lastEvidenceAt: 300 });
  const b = rule({ id: "b", rule: "y".repeat(20), lastEvidenceAt: 200 });
  const budget = HOUSE_RULES_OVERHEAD + "- ".length + 20 + "\n".length; // overhead + exactly one rule
  const plan = planHouseRulesInjection([a, b], budget, now);
  expect(plan.injected.map((r) => r.id)).toEqual(["a"]);
  expect(plan.dropped.map((r) => r.id)).toEqual(["b"]);
});

test("greedy continues past overflow: a later shorter rule still fits (non-prefix)", () => {
  // priority order: big (highest lastEvidenceAt), small (lowest). big overflows, small fits.
  const now = 10_000 * DAY_MS;
  const big = rule({ id: "big", rule: "x".repeat(500), lastEvidenceAt: 300 });
  const small = rule({ id: "small", rule: "ok", lastEvidenceAt: 100 });
  const budget = HOUSE_RULES_OVERHEAD + ("- " + "ok" + "\n").length + 10; // room for small only
  const plan = planHouseRulesInjection([big, small], budget, now);
  expect(plan.injected.map((r) => r.id)).toEqual(["small"]);
  expect(plan.dropped.map((r) => r.id)).toEqual(["big"]);
});

test("exact-fit boundary is included", () => {
  const a = rule({ id: "a", rule: "abcde", lastEvidenceAt: 1 });
  const budget = HOUSE_RULES_OVERHEAD + ("- " + "abcde" + "\n").length;
  const plan = planHouseRulesInjection([a], budget);
  expect(plan.injected.map((r) => r.id)).toEqual(["a"]);
});

test("block overhead alone exceeds budget → empty / null, usedChars 0", () => {
  const a = rule({ id: "a", rule: "anything" });
  const plan = planHouseRulesInjection([a], HOUSE_RULES_OVERHEAD - 1);
  expect(plan.injected).toEqual([]);
  // usedChars must report 0 (not the bare overhead) so the meter matches the
  // null block — nothing is actually injected.
  expect(plan.usedChars).toBe(0);
  expect(renderHouseRulesBlock(plan.injected)).toBeNull();
});

test("empty input → empty / null, usedChars 0", () => {
  const plan = planHouseRulesInjection([], 4000);
  expect(plan.injected).toEqual([]);
  expect(plan.dropped).toEqual([]);
  expect(plan.usedChars).toBe(0);
  expect(renderHouseRulesBlock(plan.injected)).toBeNull();
});

test("usedChars equals rendered block length for a multi-rule plan", () => {
  const now = 10_000 * DAY_MS;
  const a = rule({ id: "a", rule: "first rule", lastEvidenceAt: 300 });
  const b = rule({ id: "b", rule: "second longer rule here", lastEvidenceAt: 200 });
  const c = rule({ id: "c", rule: "third", lastEvidenceAt: null, updatedAt: 5 });
  const plan = planHouseRulesInjection([a, b, c], 10_000, now);
  expect(plan.injected.length).toBe(3);
  const block = renderHouseRulesBlock(plan.injected)!;
  expect(block).not.toBeNull();
  expect(plan.usedChars).toBe(block.length);
});

test("rendered block is wrapped in the XML tag, one bullet per rule", () => {
  const a = rule({ id: "a", rule: "use bun" });
  const b = rule({ id: "b", rule: "rebase, do not merge" });
  const block = renderHouseRulesBlock([a, b])!;
  expect(block.startsWith(`<${HOUSE_RULES_TAG}>\n`)).toBe(true);
  expect(block.endsWith(`\n</${HOUSE_RULES_TAG}>`)).toBe(true);
  expect(block).toContain("- use bun");
  expect(block).toContain("- rebase, do not merge");
});

test("envNum: unset and non-numeric env values fall back to the default; valid values parse", () => {
  const name = "SHEPHERD_TEST_ENVNUM_XYZ";
  delete process.env[name];
  expect(envNum(name, 0.5)).toBe(0.5); // unset → default
  try {
    process.env[name] = "abc";
    expect(envNum(name, 0.5)).toBe(0.5); // non-numeric → default (no NaN poisoning)
    process.env[name] = "";
    expect(envNum(name, 0.5)).toBe(0.5); // empty → default
    process.env[name] = "30";
    expect(envNum(name, 0.5)).toBe(30); // valid → parsed
  } finally {
    delete process.env[name];
  }
});

// ── #842 glob-scoped injection ──────────────────────────────────────────────

test("normalizeGlob strips ./ and leading slash, normalizes backslashes", () => {
  expect(normalizeGlob("./src/**")).toBe("src/**");
  expect(normalizeGlob("/src/foo.ts")).toBe("src/foo.ts");
  expect(normalizeGlob("ui\\**\\*.svelte")).toBe("ui/**/*.svelte");
  expect(normalizeGlob("  src/**  ")).toBe("src/**");
});

test("normalizeExtractedPath canonicalizes ./, absolute-under-repo, and punctuation", () => {
  expect(normalizeExtractedPath("./src/foo.ts")).toBe("src/foo.ts");
  expect(normalizeExtractedPath("/repo/src/foo.ts", "/repo")).toBe("src/foo.ts");
  expect(normalizeExtractedPath("`src/foo.ts`,")).toBe("src/foo.ts");
  expect(normalizeExtractedPath("(ui/x.svelte)")).toBe("ui/x.svelte");
  expect(normalizeExtractedPath("/repo", "/repo")).toBe("");
});

test("extractTargetPaths keeps path-like tokens, drops prose/numbers", () => {
  const paths = extractTargetPaths([
    "Please fix src/house-rules.ts and update ui/x.svelte for issue #842 (4000 chars)",
  ]);
  expect(paths).toContain("src/house-rules.ts");
  expect(paths).toContain("ui/x.svelte");
  expect(paths).not.toContain("842");
  expect(paths).not.toContain("Please");
  // bare filename with a real extension is kept
  expect(extractTargetPaths(["touch house-rules.ts"])).toContain("house-rules.ts");
  // a bare word is not a path
  expect(extractTargetPaths(["just some prose words here"])).toEqual([]);
});

test("extractTargetPaths strips an absolute repoPath prefix to repo-relative", () => {
  expect(
    extractTargetPaths(["edit /home/me/repo/src/a.ts now", undefined], "/home/me/repo"),
  ).toEqual(["src/a.ts"]);
});

// token × glob match matrix (the load-bearing normalization assertions)
const SCOPED = (globs: string[]) => rule({ id: "s", rule: "scoped", scopeGlobs: globs });
test.each([
  ["src/**", "src/foo.ts", true],
  ["src/**", "src/a/b.ts", true],
  ["src/**", "ui/x.ts", false],
  ["src/**/*.ts", "src/foo.ts", true],
  ["**/*.svelte", "ui/x.svelte", true],
  // bare-filename token hits a glob whose trailing segment is a concrete file pattern
  ["src/**/*.ts", "foo.ts", true],
  ["src/house-rules.ts", "house-rules.ts", true],
  // bare filename must NOT match a directory-only glob (trailing ** has no dot)
  ["src/**", "readme.md", false],
])("learningMatchesScope(%s vs %s) === %s", (glob, path, expected) => {
  expect(learningMatchesScope(SCOPED([glob]), [path])).toBe(expected);
});

test("learningMatchesScope: Always-rule (no globs) never matches via scope, empty paths never match", () => {
  expect(learningMatchesScope(rule({ id: "a", scopeGlobs: [] }), ["src/foo.ts"])).toBe(false);
  expect(learningMatchesScope(SCOPED(["src/**"]), [])).toBe(false);
});

test("planHouseRulesInjection: Always-rules always candidates; scoped gated unless matched", () => {
  const always = rule({ id: "always", rule: "always rule", scopeGlobs: [] });
  const match = rule({ id: "m", rule: "src rule", scopeGlobs: ["src/**"] });
  const nomatch = rule({ id: "n", rule: "ui rule", scopeGlobs: ["ui/**"] });

  const withMatch = planHouseRulesInjection([always, match, nomatch], 10_000, undefined, [
    "src/foo.ts",
  ]);
  const injectedIds = withMatch.injected.map((r) => r.id).sort();
  expect(injectedIds).toEqual(["always", "m"]);
  // the non-matching scoped rule is gated (scoped bucket), NOT dropped as over-budget
  expect(withMatch.scoped.map((r) => r.id)).toEqual(["n"]);
  expect(withMatch.dropped).toEqual([]);

  // no target paths → every scoped rule gated, only Always-rules inject
  const noPaths = planHouseRulesInjection([always, match, nomatch], 10_000);
  expect(noPaths.injected.map((r) => r.id)).toEqual(["always"]);
  expect(noPaths.scoped.map((r) => r.id).sort()).toEqual(["m", "n"]);
});

test("planHouseRulesInjection: Always-rules are packed before matched-scoped (never evicted)", () => {
  // Budget fits exactly the two Always-rules + overhead, no room for the scoped match.
  const a1 = rule({ id: "a1", rule: "AAAA", scopeGlobs: [], lastEvidenceAt: 10 });
  const a2 = rule({ id: "a2", rule: "BBBB", scopeGlobs: [], lastEvidenceAt: 9 });
  // a flurry of matching scoped rules with FRESHER evidence than the Always-rules
  const scoped = Array.from({ length: 6 }, (_, i) =>
    rule({ id: `s${i}`, rule: `SCOPED-${i}`, scopeGlobs: ["src/**"], lastEvidenceAt: 100 + i }),
  );
  const costOf = (s: string) => ("- " + s + "\n").length;
  const budget = HOUSE_RULES_OVERHEAD + costOf("AAAA") + costOf("BBBB");
  const plan = planHouseRulesInjection([...scoped, a1, a2], budget, undefined, ["src/foo.ts"]);
  const injectedIds = plan.injected.map((r) => r.id).sort();
  // both Always-rules guaranteed; every scoped match dropped despite fresher evidence
  expect(injectedIds).toEqual(["a1", "a2"]);
  expect(plan.dropped.every((r) => r.id.startsWith("s"))).toBe(true);
  expect(plan.dropped.length).toBe(6);
});
