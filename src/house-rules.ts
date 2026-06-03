import type { Learning } from "./types";

/** XML tag wrapping the Shepherd-curated house-rules block. The block is injected into
 *  every agent's *system prompt* (not the human turn — see service.ts), so the tag lets the
 *  agent tell standing guidance apart from the task it is handed. Agent-facing prompt text
 *  (not operator UI), so fixed English — same precedent as the distiller/critic spawn
 *  prompts and BRANCH_RENAME_NOTICE. */
export const HOUSE_RULES_TAG = "shepherd-house-rules";

/** Intro line inside the tag, stating what the rules are and that they are not the task. */
const HOUSE_RULES_INTRO =
  "Project house rules curated by Shepherd — standing guidance for this repo. " +
  "Apply throughout the session; this is not the task itself.";

/** Fixed char overhead of the rendered block, independent of rule count:
 *  `<tag>\n` + `intro\n` + (rules) + `\n</tag>`. Used as the budget base so the meter
 *  (usedChars) stays exactly equal to renderHouseRulesBlock(...).length. */
export const HOUSE_RULES_OVERHEAD =
  `<${HOUSE_RULES_TAG}>`.length + HOUSE_RULES_INTRO.length + `</${HOUSE_RULES_TAG}>`.length + 2;

export interface HouseRulesPlan {
  injected: Learning[]; // priority order, fit within budget
  dropped: Learning[]; // over budget, priority order
  budgetChars: number;
  usedChars: number; // exact rendered length of the block (XML tag + intro + bullets)
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
  let used = HOUSE_RULES_OVERHEAD;
  for (const r of ordered) {
    const cost = ("- " + r.rule + "\n").length;
    if (used + cost <= budgetChars) {
      injected.push(r);
      used += cost;
    } else {
      dropped.push(r);
    }
  }
  // No rule made the cut → the block renders to null, so report 0 chars used
  // (not the bare overhead) to keep the drawer's budget meter truthful.
  return { injected, dropped, budgetChars, usedChars: injected.length === 0 ? 0 : used };
}

/** Renders the injected rules into the XML-wrapped block, or null when none. */
export function renderHouseRulesBlock(injected: Learning[]): string | null {
  if (injected.length === 0) return null;
  const body = injected.map((r) => `- ${r.rule}`).join("\n");
  return `<${HOUSE_RULES_TAG}>\n${HOUSE_RULES_INTRO}\n${body}\n</${HOUSE_RULES_TAG}>`;
}
