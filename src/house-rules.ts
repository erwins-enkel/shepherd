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

// ── ranking constants (env-overridable) ───────────────────────────────────────

export const DAY_MS = 86_400_000;
/** Parse a numeric env override, falling back to `def` for unset or non-numeric (NaN/±Inf)
 *  values — a bad env var must not silently poison the score and disable ranking. */
export function envNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def; // unset/empty → default (Number("")===0)
  const v = Number(raw);
  return Number.isFinite(v) ? v : def; // non-numeric (NaN/±Inf) → default
}
const RANK_W_RECENCY = envNum("SHEPHERD_LEARNINGS_RANK_W_RECENCY", 0.5);
const RANK_W_HELP = envNum("SHEPHERD_LEARNINGS_RANK_W_HELP", 0.5);
const RANK_HALF_LIFE_DAYS = envNum("SHEPHERD_LEARNINGS_RANK_HALF_LIFE_DAYS", 30);
const RANK_PRIOR_STRENGTH = envNum("SHEPHERD_LEARNINGS_RANK_PRIOR_STRENGTH", 4);
const RANK_NEUTRAL_PRIOR = envNum("SHEPHERD_LEARNINGS_RANK_NEUTRAL_PRIOR", 0.5);
/** Per-day decay factor; default half-life = 30 days → 0.5^(1/30). */
const RANK_DECAY_BASE = Math.pow(0.5, 1 / RANK_HALF_LIFE_DAYS);

export interface HouseRulesPlan {
  injected: Learning[]; // priority order, fit within budget
  dropped: Learning[]; // over budget, priority order
  budgetChars: number;
  usedChars: number; // exact rendered length of the block (XML tag + intro + bullets)
}

/**
 * Composite score for a single rule, given the current time `now` (ms since epoch).
 *
 * recencyDecay  ∈ (0,1] — exponential decay on lastUsedAt (falls back to lastEvidenceAt,
 *                          then createdAt). Clamped so future timestamps don't yield >1.
 * helpComponent ∈ [0,1] — Bayesian-smoothed mean with fixed neutral prior (0.5).
 *                          Fixed prior keeps `proven 50/60 > lucky 1/1 > unproven 0/0 >
 *                          unhelpful 0/2` correct independent of base rate.
 * score = RANK_W_RECENCY * recencyDecay + RANK_W_HELP * helpComponent
 */
function scoreRule(r: Learning, now: number): number {
  const effectiveLastUsed = r.lastUsedAt ?? r.lastEvidenceAt ?? r.createdAt;
  const ageDays = Math.max(0, (now - effectiveLastUsed) / DAY_MS);
  const recencyDecay = Math.pow(RANK_DECAY_BASE, ageDays);
  const helpComponent =
    (r.helpfulCount + RANK_PRIOR_STRENGTH * RANK_NEUTRAL_PRIOR) /
    (r.injectedCount + RANK_PRIOR_STRENGTH);
  return RANK_W_RECENCY * recencyDecay + RANK_W_HELP * helpComponent;
}

/** Priority sort: composite recency-decay + smoothed-help score, desc.
 *  Tie-break: updatedAt desc (determinism). `now` defaults to Date.now() so
 *  existing callers need no change. */
export function prioritize(rules: Learning[], now: number = Date.now()): Learning[] {
  return [...rules].sort((a, b) => {
    const diff = scoreRule(b, now) - scoreRule(a, now);
    if (diff !== 0) return diff; // desc by score
    return b.updatedAt - a.updatedAt; // desc by updatedAt (tie-break)
  });
}

/** Priority: composite score desc → updatedAt desc. Greedy fill: add a rule
 *  when used + cost ≤ budget, else mark it dropped and keep checking later (shorter) rules,
 *  so `injected` is not necessarily a contiguous prefix of priority order. */
export function planHouseRulesInjection(
  rules: Learning[],
  budgetChars: number,
  now: number = Date.now(),
): HouseRulesPlan {
  const ordered = prioritize(rules, now);
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
