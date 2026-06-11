import type { AutoMergeStatus, DrainStatus, Learning, RepoInjectable, Session } from "../types";
import { m } from "$lib/paraglide/messages";

/** Enabled drains only, sorted by repo path — the rows the QueueStrip renders. */
export function enabledDrains(drain: Record<string, DrainStatus>): DrainStatus[] {
  return Object.values(drain)
    .filter((d) => d.enabled)
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** One row in the generalized per-repo status band: the repo's drain (only when
 *  enabled), plus its learnings footprint. A row exists only when the repo currently
 *  has a RUNNING agent; the drain/learnings data merely enriches that row. */
export interface RepoStatusRow {
  repoPath: string;
  /** The enabled drain for this repo, or null when the repo has no enabled drain
   *  (a name-only or insight-only row). */
  drain: DrainStatus | null;
  /** Count of pending (proposed) learnings for this repo. */
  insights: number;
  /** Over-budget rule count surfaced ONLY when there are no proposals — the #253
   *  "curate" case the old TopBar badge fell back to. 0 = nothing to curate. */
  curate: number;
}

/** Count of an injectable repo's active rules that didn't fit its budget — only
 *  meaningful when injection is enabled (pruning can free room; disabled → 0). */
function overBudgetCount(repo: RepoInjectable): number {
  return repo.enabled ? repo.rules.filter((r) => !r.injected).length : 0;
}

/** Shared map-building for insights (Learning counts per repo) and curate
 *  (over-budget rule counts per repo, only for enabled injectables). */
function buildInsightsCurateMaps(
  items: Learning[],
  injectable: RepoInjectable[],
): { insightsByRepo: Map<string, number>; curateByRepo: Map<string, number> } {
  const insightsByRepo = new Map<string, number>();
  for (const l of items) insightsByRepo.set(l.repoPath, (insightsByRepo.get(l.repoPath) ?? 0) + 1);

  const curateByRepo = new Map<string, number>();
  for (const r of injectable) {
    const n = overBudgetCount(r);
    if (n > 0) curateByRepo.set(r.repoPath, n);
  }
  return { insightsByRepo, curateByRepo };
}

/** One chip in the horizontal repo-filter rail: one entry per repo with ≥1 live
 *  (non-archived) session. */
export interface RepoChip {
  repoPath: string;
  /** Count of this repo's live (non-archived) sessions. */
  count: number;
  /** Enabled drain for this repo, or null. */
  drain: DrainStatus | null;
  /** Pending (proposed) learnings count for this repo. */
  insights: number;
  /** Over-budget rule count, surfaced ONLY when insights === 0 (mirrors repoStatusRows). */
  curate: number;
}

/**
 * One chip per repo that currently has ≥1 live session (any status EXCEPT "archived").
 * Sourced from the unfiltered herd `sessions` so the repo filter can scope to
 * idle/blocked/done repos too. Enriched with the repo's enabled drain + learnings
 * footprint, same enrichment rules as repoStatusRows. Sorted by repoPath.
 */
export function repoChipRows(
  sessions: Session[],
  drain: Record<string, DrainStatus>,
  items: Learning[],
  injectable: RepoInjectable[],
): RepoChip[] {
  const countByRepo = new Map<string, number>();
  for (const s of sessions) {
    if (s.status === "archived") continue;
    countByRepo.set(s.repoPath, (countByRepo.get(s.repoPath) ?? 0) + 1);
  }
  if (countByRepo.size === 0) return [];

  const drains = new Map(enabledDrains(drain).map((d) => [d.repoPath, d]));
  const { insightsByRepo, curateByRepo } = buildInsightsCurateMaps(items, injectable);

  return [...countByRepo.entries()]
    .map(([repoPath, count]) => {
      const insights = insightsByRepo.get(repoPath) ?? 0;
      return {
        repoPath,
        count,
        drain: drains.get(repoPath) ?? null,
        insights,
        curate: insights === 0 ? (curateByRepo.get(repoPath) ?? 0) : 0,
      };
    })
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** The chip rail renders only when ≥2 repos have a live session (real filtering need). */
export function chipRailVisible(chips: RepoChip[]): boolean {
  return chips.length >= 2;
}

/** Whether a chip carries any drain/learnings telemetry worth showing on its own. */
export function chipHasTelemetry(chip: RepoChip): boolean {
  return chip.drain !== null || chip.insights > 0 || chip.curate > 0;
}

/** Whether an active repo filter should be cleared because the repo no longer has a
 *  rail chip to un-toggle it — the only repo-filter control the grid view has, and
 *  one that disappears under the <2-repo rail gate. Prevents an un-clearable strand. */
export function shouldClearRepoFilter(repoFilter: string | null, chips: RepoChip[]): boolean {
  return (
    repoFilter !== null && !(chipRailVisible(chips) && chips.some((c) => c.repoPath === repoFilter))
  );
}

/**
 * Build the per-repo status rows for the QueueStrip's first band: one row per repo
 * that currently has a RUNNING agent (`runningRepoPaths`). Each row is enriched with
 * the repo's ENABLED drain (taken only from `enabledDrains` — a disabled drain entry
 * never leaks its inflight/queue/popover) and its learnings footprint (pending
 * proposals, or an over-budget curate need). A repo with an enabled drain or pending
 * learnings but NO running agent gets no row. Sorted by repoPath.
 */
export function repoStatusRows(
  drain: Record<string, DrainStatus>,
  items: Learning[],
  injectable: RepoInjectable[],
  runningRepoPaths: Set<string>,
): RepoStatusRow[] {
  const drains = new Map(enabledDrains(drain).map((d) => [d.repoPath, d]));
  const { insightsByRepo, curateByRepo } = buildInsightsCurateMaps(items, injectable);

  return [...runningRepoPaths]
    .map((repoPath) => {
      const insights = insightsByRepo.get(repoPath) ?? 0;
      return {
        repoPath,
        drain: drains.get(repoPath) ?? null,
        insights,
        curate: insights === 0 ? (curateByRepo.get(repoPath) ?? 0) : 0,
      };
    })
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Whether the repo-status band carries enough value to render: at least one row
 *  has drain/queue/learnings info, OR ≥2 repos run (so the herd filter is useful).
 *  The ≥2-rows case earns its space only because the band's repo-name buttons are
 *  interactive herd filters — i.e. QueueStrip is given `onrepofilter`. Without that
 *  the names are inert and ≥2 bare rows show nothing actionable. A single bare
 *  name-only row is pure noise — hide the whole band. */
export function bandHasValue(rows: RepoStatusRow[]): boolean {
  if (rows.length >= 2) return true;
  return rows.some((r) => r.drain !== null || r.insights > 0 || r.curate > 0);
}

/** Whether the `queued` indicator is an interactive trigger (opens the queue
 *  popover) rather than inert text — true only when something is actually queued. */
export function queueOpenable(d: DrainStatus): boolean {
  return d.queued > 0;
}

/** Active (non-idle) merge-train statuses, sorted by repoPath. */
export function activeMergeTrain(autoMerge: Record<string, AutoMergeStatus>): AutoMergeStatus[] {
  return Object.values(autoMerge)
    .filter((s) => s.state !== null && s.state !== undefined)
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Whether the merge-train state is an attention/error state (vs active/in-progress). */
export function mergeTrainIsAttention(state: string): boolean {
  return state === "merge_error" || state === "rebase_cap";
}

/**
 * Localized label for a merge-train state code.
 * Returns an empty string for null/undefined (idle) — callers should guard before rendering.
 */
export function mergeTrainLabel(state: string | null | undefined): string {
  switch (state) {
    case "merging":
      return m.automerge_state_merging();
    case "rebasing":
      return m.automerge_state_rebasing();
    case "merge_error":
      return m.automerge_state_merge_error();
    case "rebase_cap":
      return m.automerge_state_rebase_cap();
    default:
      return "";
  }
}

/** Localized banner line for a paused drain, mapped from its reason + detail. */
export function pausedText(d: DrainStatus): string {
  const desig = d.detail ?? "";
  switch (d.reason) {
    case "blocked":
      return m.drain_paused_blocked({ desig });
    case "changes_requested":
      return m.drain_paused_changes({ desig });
    case "error":
      return m.drain_paused_error({ desig });
    case "usage":
      return m.drain_paused_usage({ pct: desig });
    default:
      return m.drain_paused_generic();
  }
}
