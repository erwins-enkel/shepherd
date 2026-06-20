import { test, expect } from "bun:test";
import {
  HOUSE_RULES_OVERHEAD,
  HOUSE_RULES_TAG,
  DAY_MS,
  planHouseRulesInjection,
  prioritize,
  renderHouseRulesBlock,
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
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
    lastEvidenceAt: p.lastEvidenceAt ?? null,
    promotedPrUrl: p.promotedPrUrl ?? null,
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
  const now = 100 * DAY_MS;
  const X = rule({ id: "X", lastUsedAt: now, helpfulCount: 5, injectedCount: 10, updatedAt: 1 });
  const Y = rule({ id: "Y", lastUsedAt: now, helpfulCount: 5, injectedCount: 10, updatedAt: 2 });
  // Identical recency and help → score equal → updatedAt desc: Y first.
  expect(prioritize([X, Y], now).map((r) => r.id)).toEqual(["Y", "X"]);
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
