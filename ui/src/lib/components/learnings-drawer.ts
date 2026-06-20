import type { InjectableRule, Learning, RepoInjectable, SignalKind } from "../types";

/** Last non-empty path segment (repo display name). */
export function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}

/** Stable DOM anchor id for a repo's drawer section, derived from the FULL repoPath
 *  (not basename — two repos can share a basename, which would collide). A readable
 *  slug carries the gist for debugging, and a djb2 hash of the RAW path disambiguates
 *  paths that slugify identically (differ only in punctuation, e.g. `/r/a-b` vs
 *  `/r/a/b`), so the id is injective. Used to deep-link the drawer to a repo when
 *  opened from the per-repo status row. */
export function repoAnchorId(repoPath: string): string {
  let h = 5381;
  for (let i = 0; i < repoPath.length; i++) h = ((h << 5) + h + repoPath.charCodeAt(i)) >>> 0;
  const slug = repoPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `learnings-repo-${slug}-${h.toString(36)}`;
}

/** Group learnings by repoPath, preserving first-seen order. */
export function groupByRepo(items: Learning[]): [string, Learning[]][] {
  const map = new Map<string, Learning[]>();
  for (const l of items) {
    const g = map.get(l.repoPath);
    if (g) g.push(l);
    else map.set(l.repoPath, [l]);
  }
  return [...map.entries()];
}

/** One drawer section: a repo with its proposed (editable) rules and, when the
 *  server reports any active/promoted rules, the injectable view (budget + badges). */
export interface RepoGroup {
  repoPath: string;
  proposed: Learning[];
  injectable: RepoInjectable | null;
}

/** Merge the proposed-rule groups and the per-repo injectable payloads into one
 *  ordered repo list keyed by repoPath. Proposed repos come first (preserving
 *  their first-seen order), then any injectable-only repos (those with active/
 *  promoted rules but zero proposals — exactly the #253 case). */
export function mergeRepoGroups(proposed: Learning[], injectable: RepoInjectable[]): RepoGroup[] {
  const inj = new Map(injectable.map((r) => [r.repoPath, r]));
  const groups: RepoGroup[] = [];
  const seen = new Set<string>();
  for (const [repoPath, rules] of groupByRepo(proposed)) {
    seen.add(repoPath);
    groups.push({ repoPath, proposed: rules, injectable: inj.get(repoPath) ?? null });
  }
  for (const r of injectable) {
    if (seen.has(r.repoPath)) continue;
    seen.add(r.repoPath);
    groups.push({ repoPath: r.repoPath, proposed: [], injectable: r });
  }
  return groups;
}

export type InjectionBadge = "injected" | "over-budget" | "disabled" | "scoped";

/** Which injection badge a rule shows, given the repo's enabled flag.
 *  - disabled: repo injection is off → rule isn't injected regardless of budget
 *  - injected: rule made the budget cut
 *  - scoped: glob-scoped rule, injects only for matching tasks (NOT over-budget;
 *    this preview has no session, so it's shown conditional, not dropped)
 *  - over-budget: enabled but the rule didn't fit (operator can prune to free room) */
export function injectionBadge(
  rule: Learning & { injected: boolean; scoped?: boolean },
  enabled: boolean,
): InjectionBadge {
  if (!enabled) return "disabled";
  if (rule.injected) return "injected";
  if (rule.scoped) return "scoped";
  return "over-budget";
}

/** Count of rules the planner actually injected (true count for the meter). */
export function injectedCount(repo: RepoInjectable): number {
  return repo.rules.reduce((n, r) => n + (r.injected ? 1 : 0), 0);
}

/** Whether to show the "not working" badge on an active rule (self-audit, §5). */
export function showIneffective(rule: { ineffectiveCount: number }): boolean {
  return rule.ineffectiveCount > 0;
}

/** Flagged ("not working") rules in a repo's injectable view (ineffectiveCount > 0). */
export function flaggedRules(repo: RepoInjectable | null): InjectableRule[] {
  return repo ? repo.rules.filter((r) => r.ineffectiveCount > 0) : [];
}
/** Count of flagged rules in a repo's injectable view. */
export function flaggedCount(repo: RepoInjectable | null): number {
  return flaggedRules(repo).length;
}
/** Total flagged rules across all repos (drives the header filter toggle + its count). */
export function totalFlagged(injectable: RepoInjectable[]): number {
  return injectable.reduce((n, r) => n + flaggedCount(r), 0);
}

// ─── triage helpers ───────────────────────────────────────────────────────────

/** Count of rules the planner dropped (didn't fit budget) for an enabled repo.
 *  Null repo → 0. Disabled repo → 0 (rules are uninjected because injection is
 *  off, NOT budget pressure — the single authoritative "over budget" predicate).
 *  Scope-gated rules are excluded: they're uninjected because no task matched their
 *  globs, not because of budget pressure (#842). */
export function droppedCount(repo: RepoInjectable | null): number {
  return repo && repo.enabled ? repo.rules.filter((r) => !r.injected && !r.scoped).length : 0;
}

/** True when the repo has ≥1 rule the planner dropped due to budget pressure. */
export function isOverBudget(repo: RepoInjectable | null): boolean {
  return droppedCount(repo) > 0;
}

/** Sort a repo-group array into triage order (new array, input not mutated):
 *  tier 0 = over-budget, tier 1 = flagged-only, tier 2 = everything else.
 *  Within each tier the original (first-seen) order is preserved (stable). */
export function sortGroupsForTriage(groups: RepoGroup[]): RepoGroup[] {
  function tier(g: RepoGroup): number {
    if (isOverBudget(g.injectable)) return 0;
    if (flaggedCount(g.injectable) > 0) return 1;
    return 2;
  }
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => tier(a.g) - tier(b.g) || a.i - b.i)
    .map(({ g }) => g);
}

/** Split a repo's rules into dropped vs injected subsets for over-budget display.
 *  Only splits when `isOverBudget(repo)` is true — disabled repos and repos
 *  without dropped rules are returned unsplit (all rules in `injected`) so the
 *  drawer doesn't mislabel a disabled repo's rules as "not injected". */
export function splitDropped(repo: RepoInjectable | null): {
  dropped: InjectableRule[];
  injected: InjectableRule[];
} {
  if (!repo) return { dropped: [], injected: [] };
  if (!isOverBudget(repo)) return { dropped: [], injected: repo.rules };
  // Scope-gated rules are not over-budget — they stay in the non-dropped bucket
  // (rendered with their own "scoped" badge), only true budget casualties drop.
  return {
    dropped: repo.rules.filter((r) => !r.injected && !r.scoped),
    injected: repo.rules.filter((r) => r.injected || r.scoped),
  };
}

/** Repos that need operator attention (over-budget OR flagged), in triage order.
 *  Returns one entry per qualifying group with its dropped/flagged counts. */
export function reposNeedingAttention(
  groups: RepoGroup[],
): { repoPath: string; droppedCount: number; flaggedCount: number }[] {
  return sortGroupsForTriage(groups)
    .filter((g) => isOverBudget(g.injectable) || flaggedCount(g.injectable) > 0)
    .map((g) => ({
      repoPath: g.repoPath,
      droppedCount: droppedCount(g.injectable),
      flaggedCount: flaggedCount(g.injectable),
    }));
}

/** Rules visible under the active lens combination for a repo.
 *  No lens → all rules (caller handles dropped-first ordering via splitDropped).
 *  A lens active → union (deduped by id, preserving repo.rules order) of:
 *    flaggedOnly  → rules with ineffectiveCount > 0
 *    overBudgetOnly → dropped rules (only when repo is actually over-budget) */
export function visibleInjectableRules(
  repo: RepoInjectable | null,
  lenses: { flaggedOnly: boolean; overBudgetOnly: boolean },
): InjectableRule[] {
  if (!repo) return [];
  if (!lenses.flaggedOnly && !lenses.overBudgetOnly) return repo.rules;
  const overBudget = isOverBudget(repo);
  const ids = new Set<string>();
  const result: InjectableRule[] = [];
  for (const r of repo.rules) {
    const wantFlagged = lenses.flaggedOnly && r.ineffectiveCount > 0;
    const wantDropped = lenses.overBudgetOnly && !r.injected && !r.scoped && overBudget;
    if ((wantFlagged || wantDropped) && !ids.has(r.id)) {
      ids.add(r.id);
      result.push(r);
    }
  }
  return result;
}

// ─── retired-rule helpers ─────────────────────────────────────────────────────

/** Retired rules for a repo (auto-retired by effectiveness loop). */
export function retiredRules(repo: RepoInjectable | null): Learning[] {
  return repo?.retired ?? [];
}

/** Count of retired rules in a repo. */
export function retiredCount(repo: RepoInjectable | null): number {
  return retiredRules(repo).length;
}

/** Count of unseen retired rules (drives the new-retired banner). */
export function unseenRetiredCount(repo: RepoInjectable | null): number {
  return repo?.unseenRetired ?? 0;
}

/** Help-rate stat for a rule: null when never injected (avoids division by zero).
 *  Returns { helped, pulls } counts so the caller formats the display. */
export function helpRate(rule: {
  helpfulCount: number;
  injectedCount: number;
}): { helped: number; pulls: number } | null {
  if (rule.injectedCount === 0) return null;
  return { helped: rule.helpfulCount, pulls: rule.injectedCount };
}

/** Stable display order for the evidence breakdown: most operator-meaningful
 *  source first (a correction you gave) down to passive ones (a stall). */
const KIND_ORDER: SignalKind[] = ["reply", "critic", "block", "stall"];

/** Break a learning's evidence into its source kinds, e.g.
 *  `[{ kind: "reply", count: 2 }, { kind: "critic", count: 1 }]`. Drops kinds
 *  with no signals and returns `[]` when the server sent no breakdown (so the
 *  drawer falls back to the bare count). The component maps kind → label. */
export function evidenceSources(l: Learning): { kind: SignalKind; count: number }[] {
  const k = l.evidenceKinds;
  if (!k) return [];
  return KIND_ORDER.filter((kind) => (k[kind] ?? 0) > 0).map((kind) => ({
    kind,
    count: k[kind] as number,
  }));
}
