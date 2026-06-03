import { test, expect } from "bun:test";
import {
  HOUSE_RULES_OVERHEAD,
  HOUSE_RULES_TAG,
  planHouseRulesInjection,
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
    createdAt: 0,
    updatedAt: p.updatedAt ?? 0,
    lastEvidenceAt: p.lastEvidenceAt ?? null,
    promotedPrUrl: p.promotedPrUrl ?? null,
  };
}

test("priority: lastEvidenceAt desc with nulls last, tie-break updatedAt desc", () => {
  const a = rule({ id: "a", rule: "a", lastEvidenceAt: 100, updatedAt: 1 });
  const b = rule({ id: "b", rule: "b", lastEvidenceAt: 200, updatedAt: 1 });
  const c = rule({ id: "c", rule: "c", lastEvidenceAt: null, updatedAt: 50 });
  const d = rule({ id: "d", rule: "d", lastEvidenceAt: null, updatedAt: 80 });
  const plan = planHouseRulesInjection([a, b, c, d], 10_000);
  expect(plan.injected.map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
});

test("greedy fill picks rules that fit within budget", () => {
  const a = rule({ id: "a", rule: "x".repeat(20), lastEvidenceAt: 300 });
  const b = rule({ id: "b", rule: "y".repeat(20), lastEvidenceAt: 200 });
  const budget = HOUSE_RULES_OVERHEAD + "- ".length + 20 + "\n".length; // overhead + exactly one rule
  const plan = planHouseRulesInjection([a, b], budget);
  expect(plan.injected.map((r) => r.id)).toEqual(["a"]);
  expect(plan.dropped.map((r) => r.id)).toEqual(["b"]);
});

test("greedy continues past overflow: a later shorter rule still fits (non-prefix)", () => {
  // priority order: big (highest), small (lowest). big overflows, small fits.
  const big = rule({ id: "big", rule: "x".repeat(500), lastEvidenceAt: 300 });
  const small = rule({ id: "small", rule: "ok", lastEvidenceAt: 100 });
  const budget = HOUSE_RULES_OVERHEAD + ("- " + "ok" + "\n").length + 10; // room for small only
  const plan = planHouseRulesInjection([big, small], budget);
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
  const a = rule({ id: "a", rule: "first rule", lastEvidenceAt: 300 });
  const b = rule({ id: "b", rule: "second longer rule here", lastEvidenceAt: 200 });
  const c = rule({ id: "c", rule: "third", lastEvidenceAt: null, updatedAt: 5 });
  const plan = planHouseRulesInjection([a, b, c], 10_000);
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
