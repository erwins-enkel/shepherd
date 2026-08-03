/**
 * Pure planning + pricing for the one-shot house-rules sweep (issue #2004).
 *
 * The flywheel's admission criteria were re-targeted from behavioral rules to non-derivable repo
 * facts (see `src/learning-shape.ts`). Going forward the distiller's fails-the-admission-test DELETE
 * criterion drains the active set on its own daily run; this module exists for the one-shot that
 * fixes TODAY's corpus, and for measuring what that costs the injected block.
 *
 * No store, no fs, no clock of its own — `scripts/sweep-house-rules.ts` is the only I/O — so the
 * arithmetic the sweep reports is unit-testable against fixtures.
 *
 * Pricing deliberately reuses the spawn path end to end: `planHouseRulesInjection` decides what
 * would inject, `renderHouseRulesBlock` renders exactly what a spawn would carry, and
 * `measurePromptBlocks` (the #1999 meter) prices it. So the numbers reported here are the meter's
 * numbers in the meter's units, not a parallel estimate. One caveat worth stating: with no session
 * there are no target paths, so scope-gated rules never inject — same as the drawer's cross-repo
 * overview. The delta is therefore the Always-rule baseline, and a scoped rule's retirement shows up
 * in the rule count, not in the chars.
 */

import type { Learning } from "./types";
import { planHouseRulesInjection, renderHouseRulesBlock, HOUSE_RULES_TAG } from "./house-rules";
import { measurePromptBlocks } from "./prompt-budget";

/** One operator/agent decision: retire this rule, for this stated reason. */
export interface SweepDecision {
  id: string;
  why: string;
}

/** Why a decision could not be applied. `promoted` rules are refused for the same reason the
 *  distiller may not delete them — their text is mirrored verbatim in the repo's CLAUDE.md, so
 *  retiring the row silently desyncs the two. */
export type SweepRefusal = "not-found" | "not-active" | "promoted";

/** What the injected `<shepherd-house-rules>` block costs, in the meter's units. */
export interface BlockCost {
  /** Rules that would actually inject (Always-rules; see the module note on scope gating). */
  injectedRules: number;
  chars: number;
  bytes: number;
  /** ESTIMATE — see `estimateTokens` in prompt-budget.ts. */
  tokens: number;
}

export interface SweepPlan {
  retire: { id: string; rule: string; why: string }[];
  refused: { id: string; reason: SweepRefusal }[];
  /** Rules the repo has now (active + promoted), and what remains after the retirements. */
  activeBefore: number;
  activeAfter: number;
  before: BlockCost;
  after: BlockCost;
}

/** Price the block that `rules` would produce at spawn. An empty injection set renders to `null`
 *  (no block at all), which costs nothing — not the bare tag overhead. */
export function priceBlock(rules: Learning[], budgetChars: number, now?: number): BlockCost {
  const plan = planHouseRulesInjection(rules, budgetChars, now ?? Date.now());
  const text = renderHouseRulesBlock(plan.injected);
  if (text === null) return { injectedRules: 0, chars: 0, bytes: 0, tokens: 0 };
  const measured = measurePromptBlocks([{ name: HOUSE_RULES_TAG, text }]);
  return {
    injectedRules: plan.injected.length,
    chars: measured.totalChars,
    bytes: measured.totalBytes,
    tokens: measured.totalTokens,
  };
}

/**
 * Resolve `decisions` against the repo's current active+promoted `rules` and price the before/after
 * block. Pure: decides nothing on its own and mutates nothing — the caller applies `retire`.
 *
 * A decision naming an unknown id, an already-retired rule or a promoted rule is refused rather
 * than silently dropped, so a stale decisions file is visible instead of quietly under-applying.
 * Duplicate ids collapse to one retirement.
 */
export function planSweep(
  rules: Learning[],
  decisions: SweepDecision[],
  budgetChars: number,
  now?: number,
): SweepPlan {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const retire: SweepPlan["retire"] = [];
  const refused: SweepPlan["refused"] = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const rule = byId.get(d.id);
    if (!rule) {
      refused.push({ id: d.id, reason: "not-found" });
      continue;
    }
    if (rule.status === "promoted") {
      refused.push({ id: d.id, reason: "promoted" });
      continue;
    }
    if (rule.status !== "active") {
      refused.push({ id: d.id, reason: "not-active" });
      continue;
    }
    retire.push({ id: rule.id, rule: rule.rule, why: d.why });
  }
  const retiring = new Set(retire.map((r) => r.id));
  const remaining = rules.filter((r) => !retiring.has(r.id));
  return {
    retire,
    refused,
    activeBefore: rules.length,
    activeAfter: remaining.length,
    before: priceBlock(rules, budgetChars, now),
    after: priceBlock(remaining, budgetChars, now),
  };
}

/** Parse a decisions file body: `{"drop":[{"id":"…","why":"…"}]}`. Throws on any shape it cannot
 *  trust — applying a half-understood file against the live corpus is worse than refusing to run. */
export function parseDecisions(raw: unknown): SweepDecision[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { drop?: unknown }).drop)) {
    throw new Error('decisions file must be {"drop":[{"id":"…","why":"…"}]}');
  }
  return (raw as { drop: unknown[] }).drop.map((entry, i) => {
    const e = entry as { id?: unknown; why?: unknown };
    if (typeof e?.id !== "string" || !e.id.trim()) throw new Error(`drop[${i}]: missing id`);
    if (typeof e.why !== "string" || !e.why.trim()) throw new Error(`drop[${i}]: missing why`);
    return { id: e.id.trim(), why: e.why.trim() };
  });
}
