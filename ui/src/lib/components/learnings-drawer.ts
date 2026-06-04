import type { Learning, RepoInjectable, SignalKind } from "../types";

/** Last non-empty path segment (repo display name). */
export function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
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

export type InjectionBadge = "injected" | "over-budget" | "disabled";

/** Which injection badge a rule shows, given the repo's enabled flag.
 *  - disabled: repo injection is off → rule isn't injected regardless of budget
 *  - injected: rule made the budget cut
 *  - over-budget: enabled but the rule didn't fit (operator can prune to free room) */
export function injectionBadge(
  rule: Learning & { injected: boolean },
  enabled: boolean,
): InjectionBadge {
  if (!enabled) return "disabled";
  return rule.injected ? "injected" : "over-budget";
}

/** Count of rules the planner actually injected (true count for the meter). */
export function injectedCount(repo: RepoInjectable): number {
  return repo.rules.reduce((n, r) => n + (r.injected ? 1 : 0), 0);
}

/** Whether to show the "not working" badge on an active rule (self-audit, §5). */
export function showIneffective(rule: { ineffectiveCount: number }): boolean {
  return rule.ineffectiveCount > 0;
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
