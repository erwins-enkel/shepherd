import { test, expect } from "bun:test";
import { planSweep, parseDecisions, priceBlock } from "../src/learning-sweep";
import { renderHouseRulesBlock } from "../src/house-rules";
import type { Learning } from "../src/types";

function mk(id: string, rule: string, over: Partial<Learning> = {}): Learning {
  return {
    id,
    repoPath: "/r",
    rule,
    rationale: "",
    evidence: [],
    status: "active",
    evidenceCount: 0,
    ineffectiveCount: 0,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: null,
    lastEvidenceAt: null,
    distinctKinds: 0,
    distinctSessions: 0,
    trialedAt: null,
    reTrialBlockedAt: null,
    retiredAt: null,
    retiredReason: null,
    mergedIntoId: null,
    prUrl: null,
    scopeGlobs: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Learning;
}

test("priceBlock matches the block a spawn would actually carry", () => {
  const rules = [mk("a", "fact one"), mk("b", "fact two")];
  const cost = priceBlock(rules, 4000, 1000);
  expect(cost.injectedRules).toBe(2);
  expect(cost.chars).toBe(renderHouseRulesBlock(rules)!.length);
  expect(cost.tokens).toBe(Math.ceil(cost.chars / 4));
});

test("an empty set costs nothing — not the bare tag overhead", () => {
  expect(priceBlock([], 4000, 1000)).toEqual({
    injectedRules: 0,
    chars: 0,
    bytes: 0,
    tokens: 0,
  });
});

test("planSweep prices before/after and shrinks the block by the dropped rules", () => {
  const rules = [mk("a", "keep this fact"), mk("b", "drop this platitude")];
  const plan = planSweep(rules, [{ id: "b", why: "judgement guidance" }], 4000, 1000);
  expect(plan.retire).toEqual([
    { id: "b", rule: "drop this platitude", why: "judgement guidance" },
  ]);
  expect(plan.refused).toEqual([]);
  expect(plan.activeBefore).toBe(2);
  expect(plan.activeAfter).toBe(1);
  expect(plan.after.chars).toBe(plan.before.chars - "- drop this platitude\n".length);
  expect(plan.after.injectedRules).toBe(1);
});

test("a promoted rule is refused — its text is mirrored in CLAUDE.md", () => {
  const rules = [mk("a", "mirrored", { status: "promoted" })];
  const plan = planSweep(rules, [{ id: "a", why: "x" }], 4000, 1000);
  expect(plan.retire).toEqual([]);
  expect(plan.refused).toEqual([{ id: "a", reason: "promoted" }]);
  expect(plan.after.chars).toBe(plan.before.chars); // nothing dropped → nothing saved
});

test("an unknown id is refused, not silently ignored", () => {
  const plan = planSweep([mk("a", "x")], [{ id: "zz", why: "y" }], 4000, 1000);
  expect(plan.refused).toEqual([{ id: "zz", reason: "not-found" }]);
});

test("a duplicate decision retires once", () => {
  const plan = planSweep(
    [mk("a", "x"), mk("b", "y")],
    [
      { id: "a", why: "one" },
      { id: "a", why: "again" },
    ],
    4000,
    1000,
  );
  expect(plan.retire.map((r) => r.id)).toEqual(["a"]);
  expect(plan.refused).toEqual([]);
  expect(plan.activeAfter).toBe(1);
});

test("scope-gated rules never inject, so they move the count but not the chars", () => {
  const rules = [mk("a", "always fact"), mk("b", "scoped fact", { scopeGlobs: ["ui/**"] })];
  const plan = planSweep(rules, [{ id: "b", why: "not a gotcha" }], 4000, 1000);
  expect(plan.before.injectedRules).toBe(1);
  expect(plan.after.chars).toBe(plan.before.chars);
  expect(plan.activeAfter).toBe(1);
});

test("parseDecisions accepts the documented shape and rejects everything else", () => {
  expect(parseDecisions({ drop: [{ id: " a ", why: " because " }] })).toEqual([
    { id: "a", why: "because" },
  ]);
  expect(parseDecisions({ drop: [] })).toEqual([]);
  expect(() => parseDecisions({})).toThrow(/must be/);
  expect(() => parseDecisions(null)).toThrow(/must be/);
  expect(() => parseDecisions({ drop: [{ id: "a" }] })).toThrow(/missing why/);
  expect(() => parseDecisions({ drop: [{ why: "b" }] })).toThrow(/missing id/);
  expect(() => parseDecisions({ drop: [{ id: "  ", why: "b" }] })).toThrow(/missing id/);
});
