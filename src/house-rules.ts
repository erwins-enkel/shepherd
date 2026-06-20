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
  injected: Learning[]; // priority order, fit within budget (Always-rules first, then matched-scoped)
  dropped: Learning[]; // candidates over budget, priority order
  scoped: Learning[]; // scope-gated: have globs but no target path matched (NOT over budget)
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

/** A rule with no scope globs is an "Always-rule" — a candidate for every task,
 *  exactly the pre-#842 behavior. A rule with globs is scoped: a candidate only when
 *  the session's target files match (see {@link learningMatchesScope}). */
function isAlwaysRule(l: Learning): boolean {
  return l.scopeGlobs.length === 0;
}

/** Canonicalize a glob to repo-relative forward-slash form for Bun.Glob matching
 *  (exact-string). Strips a leading `./` and leading `/`, normalizes backslashes. */
export function normalizeGlob(g: string): string {
  return g.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Max glob patterns kept per rule, and max chars per pattern — bounds the scope so a
 *  runaway distiller output OR a fat-fingered operator paste can't bloat a row. */
const MAX_SCOPE_GLOBS = 5;
const MAX_GLOB_LEN = 120;

/** Sanitize proposed/edited `scopeGlobs` from ANY source (distiller LLM or operator edit):
 *  keep only strings, normalize to repo-relative form, drop empty/over-long patterns, dedupe,
 *  and cap the count. Anything not a string array → []. The single source of truth so both the
 *  distiller and the operator path enforce identical caps (#842). */
export function sanitizeScopeGlobs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of raw) {
    if (typeof g !== "string") continue;
    const norm = normalizeGlob(g);
    if (!norm || norm.length > MAX_GLOB_LEN || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= MAX_SCOPE_GLOBS) break;
  }
  return out;
}

/** Canonicalize a path-like token scraped from task text to the same repo-relative
 *  forward-slash form so it can be matched against {@link normalizeGlob}'d patterns.
 *  Strips wrapping quotes/brackets and trailing sentence punctuation, and (when given)
 *  the absolute `repoPath` prefix. Returns "" for empty / non-path tokens. */
export function normalizeExtractedPath(token: string, repoPath?: string): string {
  let t = token.trim().replace(/\\/g, "/");
  t = t.replace(/^[("'`[<]+/, "").replace(/[)"'`\].,;:>]+$/, "");
  if (!t) return "";
  if (repoPath) {
    const base = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (t === base) return "";
    if (t.startsWith(base + "/")) t = t.slice(base.length + 1);
  }
  return t.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** A token is path-like when it has a "/" or ends in a 2–6 char file extension —
 *  so `src/foo.ts`, `house-rules.ts`, `ui/x.svelte` qualify but prose, `#842`, `4000` don't. */
function isPathLike(s: string): boolean {
  return s.includes("/") || /\.[a-z0-9]{2,6}$/i.test(s);
}

/** Collect path-like tokens from one text into `out`. Returns true once the cap is hit. */
function collectPaths(text: string, repoPath: string | undefined, out: Set<string>): boolean {
  for (const raw of text.match(/[\w./@+-]+/g) ?? []) {
    const norm = normalizeExtractedPath(raw, repoPath);
    if (norm && isPathLike(norm)) out.add(norm);
    if (out.size >= 256) return true;
  }
  return false;
}

/** Extract repo-relative path-like tokens from free task text (prompt + issue
 *  title/body). Deduped; capped to bound the match work at spawn. The session's *actual*
 *  touched files are unknowable before it runs, so this is a heuristic over the task
 *  description — a miss simply falls back to Always-rules-only (never worse than the
 *  pre-#842 behavior). */
export function extractTargetPaths(texts: (string | undefined)[], repoPath?: string): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    if (text && collectPaths(text, repoPath, out)) break;
  }
  return [...out];
}

/** True when normalized glob `rawGlob` matches any of `paths`. Two tiers: (1) full-path
 *  glob match; (2) a basename fallback that lets a bare-filename token (no directory) hit a
 *  glob whose trailing segment is a concrete file pattern (contains "."), e.g. bare `foo.ts`
 *  matches `src/`+`**`+`/*.ts`. A trailing bare `**`/`*` is NOT used for the fallback (it
 *  would match any filename). A malformed glob is skipped, never thrown. */
function globMatchesAnyPath(rawGlob: string, paths: string[]): boolean {
  const glob = normalizeGlob(rawGlob);
  if (!glob) return false;
  try {
    const matcher = new Bun.Glob(glob);
    const tail = glob.slice(glob.lastIndexOf("/") + 1);
    const baseMatcher = tail !== glob && tail.includes(".") ? new Bun.Glob(tail) : null;
    return paths.some(
      (p) => matcher.match(p) || (baseMatcher !== null && !p.includes("/") && baseMatcher.match(p)),
    );
  } catch {
    return false;
  }
}

/** True when `learning` is scoped (has globs) and at least one glob matches at least one
 *  of `paths`. Always-rules (no globs) and an empty path set never match. */
export function learningMatchesScope(learning: Learning, paths: string[]): boolean {
  if (learning.scopeGlobs.length === 0 || paths.length === 0) return false;
  return learning.scopeGlobs.some((g) => globMatchesAnyPath(g, paths));
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

/** Plan which house rules inject under the char budget, scoped to the session's target
 *  files (#842). Rules split three ways: Always-rules (no globs), matched-scoped (globs hit
 *  a `targetPaths` entry), and scope-gated (globs, no match → `scoped`, never injected and
 *  never counted against budget). Budget precedence is two-pass: **Always-rules are packed
 *  first** (guaranteed the budget), then matched-scoped fill the remainder — so a flurry of
 *  scoped matches can never evict a universal rule. Within each pass the fill is greedy by
 *  the composite score (a later, shorter rule can still fit after a longer one is dropped),
 *  so `injected` is not necessarily a contiguous prefix. `now` (test-injectable) drives the
 *  recency decay; omitting `targetPaths` (e.g. the cross-repo injectable preview, which has
 *  no session) gates every scoped rule. */
export function planHouseRulesInjection(
  rules: Learning[],
  budgetChars: number,
  now: number = Date.now(),
  targetPaths?: string[],
): HouseRulesPlan {
  const paths = targetPaths ?? [];
  const always: Learning[] = [];
  const matchedScoped: Learning[] = [];
  const gated: Learning[] = [];
  for (const r of rules) {
    if (isAlwaysRule(r)) always.push(r);
    else if (learningMatchesScope(r, paths)) matchedScoped.push(r);
    else gated.push(r);
  }
  const injected: Learning[] = [];
  const dropped: Learning[] = [];
  let used = HOUSE_RULES_OVERHEAD;
  for (const group of [prioritize(always, now), prioritize(matchedScoped, now)]) {
    for (const r of group) {
      const cost = ("- " + r.rule + "\n").length;
      if (used + cost <= budgetChars) {
        injected.push(r);
        used += cost;
      } else {
        dropped.push(r);
      }
    }
  }
  // No rule made the cut → the block renders to null, so report 0 chars used
  // (not the bare overhead) to keep the drawer's budget meter truthful.
  return {
    injected,
    dropped,
    scoped: prioritize(gated, now),
    budgetChars,
    usedChars: injected.length === 0 ? 0 : used,
  };
}

/** Renders the injected rules into the XML-wrapped block, or null when none. */
export function renderHouseRulesBlock(injected: Learning[]): string | null {
  if (injected.length === 0) return null;
  const body = injected.map((r) => `- ${r.rule}`).join("\n");
  return `<${HOUSE_RULES_TAG}>\n${HOUSE_RULES_INTRO}\n${body}\n</${HOUSE_RULES_TAG}>`;
}
