import type { IssueFilterSettings, UpNextFilterStats, UpNextSnapshot } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

// Up Next's default-issue-filter derivations (#3018), kept out of UpNextPanel. The rules
// themselves run server-side (src/issue-filter.ts); this only describes the result.

const PRIORITY_LABEL = "shepherd:priority";

/** +1 for a narrowed scope, +1 for a fork rule, +1 per hidden label. */
export function activeRuleCount(f: IssueFilterSettings): number {
  return (f.scope !== "all" ? 1 : 0) + (f.forks !== "all" ? 1 : 0) + f.hiddenLabels.length;
}

/** One chip per active rule, in rule order. */
export function activeChips(f: IssueFilterSettings): { key: string; text: string }[] {
  const chips: { key: string; text: string }[] = [];
  if (f.scope === "mine") chips.push({ key: "scope", text: m.upnext_filter_chip_scope_mine() });
  if (f.scope === "mine_unassigned")
    chips.push({ key: "scope", text: m.upnext_filter_chip_scope_mine_unassigned() });
  if (f.forks === "own") chips.push({ key: "forks", text: m.upnext_filter_chip_forks_own() });
  if (f.forks === "hide") chips.push({ key: "forks", text: m.upnext_filter_chip_forks_hide() });
  for (const label of f.hiddenLabels)
    chips.push({ key: `label:${label}`, text: m.upnext_filter_chip_label({ label }) });
  return chips;
}

/** Hidden items in view: summed over the active repo chips, else the whole queue. */
export function hiddenFor(
  stats: UpNextFilterStats | undefined,
  repoFilter: ReadonlySet<string>,
): number {
  if (!stats) return 0;
  if (repoFilter.size === 0) return stats.hiddenCount;
  let n = 0;
  for (const path of repoFilter) n += stats.hiddenByRepo[path] ?? 0;
  return n;
}

/** The labels on the queue plus any already hidden (their items are gone from it), deduped
 *  case-insensitively and sorted. */
export function labelOptions(snap: UpNextSnapshot | null, hiddenLabels: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const label of hiddenLabels) byKey.set(label.toLowerCase(), label);
  for (const s of snap?.sections ?? [])
    for (const it of s.items)
      for (const label of it.labels) {
        const key = label.toLowerCase();
        if (key !== PRIORITY_LABEL && !byKey.has(key)) byKey.set(key, label);
      }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** The fork repos with items in the queue. */
export function forkRepos(snap: UpNextSnapshot | null): string[] {
  const names = new Set<string>();
  for (const s of snap?.sections ?? [])
    for (const it of s.items) if (it.fromFork) names.add(it.repoLabel);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Whether a label is in the hidden set (case-insensitive, as the server matches). */
export function isHiddenLabel(f: IssueFilterSettings, label: string): boolean {
  const key = label.toLowerCase();
  return f.hiddenLabels.some((l) => l.toLowerCase() === key);
}

/** The hidden set with `label` toggled. */
export function toggledLabels(f: IssueFilterSettings, label: string): string[] {
  const key = label.toLowerCase();
  return isHiddenLabel(f, label)
    ? f.hiddenLabels.filter((l) => l.toLowerCase() !== key)
    : [...f.hiddenLabels, label];
}
