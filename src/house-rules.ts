import type { Learning } from "./types";

/** Header for the Shepherd-curated house-rules block prepended to every agent prompt.
 *  Agent-facing prompt text (not operator UI), so it is a fixed English constant —
 *  same precedent as the distiller/critic spawn prompts. */
export const HOUSE_RULES_HEADER = "## Project house rules (curated by Shepherd)";

export interface HouseRulesPlan {
  injected: Learning[]; // priority order, fit within budget
  dropped: Learning[]; // over budget, priority order
  budgetChars: number;
  usedChars: number; // exact rendered length of the block (header + bullets)
}

/** Priority sort: lastEvidenceAt desc (nulls last), tie-break updatedAt desc.
 *  Stale rules with no recent evidence drop first. */
export function prioritize(rules: Learning[]): Learning[] {
  return [...rules].sort((a, b) => {
    if (a.lastEvidenceAt !== b.lastEvidenceAt) {
      if (a.lastEvidenceAt === null) return 1; // nulls last
      if (b.lastEvidenceAt === null) return -1;
      return b.lastEvidenceAt - a.lastEvidenceAt; // desc
    }
    return b.updatedAt - a.updatedAt; // desc
  });
}

/** Priority: lastEvidenceAt desc (nulls last) → updatedAt desc. Greedy fill: add a rule
 *  when used + cost ≤ budget, else mark it dropped and keep checking later (shorter) rules,
 *  so `injected` is not necessarily a contiguous prefix of priority order. */
export function planHouseRulesInjection(rules: Learning[], budgetChars: number): HouseRulesPlan {
  const ordered = prioritize(rules);
  const injected: Learning[] = [];
  const dropped: Learning[] = [];
  let used = HOUSE_RULES_HEADER.length;
  for (const r of ordered) {
    const cost = ("- " + r.rule + "\n").length;
    if (used + cost <= budgetChars) {
      injected.push(r);
      used += cost;
    } else {
      dropped.push(r);
    }
  }
  return { injected, dropped, budgetChars, usedChars: used };
}

/** Renders the injected rules into the prompt block, or null when none. */
export function renderHouseRulesBlock(injected: Learning[]): string | null {
  if (injected.length === 0) return null;
  return `${HOUSE_RULES_HEADER}\n${injected.map((r) => `- ${r.rule}`).join("\n")}`;
}
