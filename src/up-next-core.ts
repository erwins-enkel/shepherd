// Up Next (#1169) — pure ranking/classification/collapse for the cross-repo "what to
// start next" feed. NO I/O: the service (src/up-next.ts) fetches per-repo facts and
// feeds them in; this module is the deterministic, unit-tested decision layer.
//
// Ranking (priority-dominant, lexicographic):
//   1. shepherd:priority items across ALL repos — warm-first (repo lastUsedAt desc), then oldest age.
//   2. per-repo clusters in warm order; within a repo: ready-epic-unit -> bug -> feature, then oldest age.
// Epics collapse to ONE unit keyed by their next-actionable child; the unit is AGED BY THE
// PARENT'S createdAt (the child carries none — SubIssueRef has no createdAt and
// selectEpicCandidates hard-codes createdAt:0, so child-age would tie all epics at 0).
import type { Issue } from "./forge/types";
import { PRIORITY_LABEL, ACTIVE_LABEL } from "./drain-core";
import { isDependabotAuthor } from "./forge/pr-kind";
import { BAND_RANK, band } from "./up-next-readiness-core";
import {
  DEFAULT_ISSUE_FILTER,
  ISSUE_FILTER_FORKS,
  ISSUE_FILTER_SCOPES,
  hiddenByRule,
  isMine,
  type IssueFilterContext,
  type IssueFilterForks,
  type IssueFilterRule,
  type IssueFilterScope,
  type IssueFilterSettings,
  type IssueFilterSubject,
} from "./issue-filter";

export type UpNextKind = "epic" | "bug" | "feature";

/** One startable row. For an epic, `number`/`title`/`url`/`issueRef` describe the
 *  next-actionable CHILD (what Start spawns); `createdAt` is the PARENT's age. */
export interface UpNextItem {
  repoPath: string;
  repoSlug: string | null;
  repoLabel: string;
  number: number;
  title: string;
  url: string;
  kind: UpNextKind;
  priority: boolean;
  createdAt: number;
  /** The issue's labels (standalone) or the parent epic's labels (epic unit) — used by the
   *  UI's client-side hide-blocked display filter (isBlocked in issues-panel.ts). */
  labels: string[];
  /** Forge label name → source color. Optional presentational metadata; names in `labels`
   *  remain authoritative and a missing/partial map renders with the neutral fallback. */
  labelColors?: Record<string, string>;
  /** Present iff this row represents an epic unit (the parent it rolls up). */
  epicParent?: { number: number; title: string };
  /** Issue identity; Start loads the full body server-side. */
  issueRef: { number: number; url: string; title: string };
  /** The repo is a fork (`forge.isFork`); its issues are the upstream's. */
  fromFork: boolean;
  /** Assigned to or authored by the viewer (the parent's, for an epic unit) — see issue-filter.ts.
   *  With `fromFork` it drives the row tag: FORK (mine) or UPSTREAM (not mine). */
  mine: boolean;
}

/** What the operator's issue filter (src/issue-filter.ts) hides from the startable items. */
export interface UpNextFilterStats {
  /** Startable items the filter hides. */
  hiddenCount: number;
  /** Each hidden item counted once, under the first rule that drops it: the repo's override (else
   *  scope → forks), then labels. */
  hiddenBy: Record<IssueFilterRule, number>;
  /** repoPath → hidden items in that repo; repos with none are omitted. */
  hiddenByRepo: Record<string, number>;
  /** The visible count were that option picked, the other settings unchanged. Repos with an
   *  override don't follow the global options, so their items count the same in every option. */
  optionCounts: {
    scope: Record<IssueFilterScope, number>;
    forks: Record<IssueFilterForks, number>;
  };
}

export interface UpNextSection {
  kind: "priority" | "repo";
  repoPath: string | null;
  repoSlug: string | null;
  repoLabel: string | null;
  /** Full ranked item list (bounded by the 200/repo listIssues source). The UI renders the
   *  first PRIORITY_CAP / REPO_CAP and reveals the rest via an in-place "show all N" expander. */
  items: UpNextItem[];
  /** items.length — convenience for the UI's "show all N" label. */
  totalCount: number;
}

export interface UpNextSnapshot {
  generatedAt: number;
  sections: UpNextSection[];
  /** Forge-backed repos successfully scanned this refresh (excludes ones whose fetch failed). */
  repoCount: number;
  /** Degraded rung applied this refresh (e.g. "warm-repos-only"), or null when clean. */
  fallback: string | null;
  /** Repos whose issue fetch threw this refresh and were dropped. >0 means a fetch failure may
   *  be hiding work, so the UI surfaces a load error instead of an "all caught up" empty state. */
  failedRepoCount: number;
  filter: UpNextFilterStats;
}

/** A resolved epic, as fed in by the service (after buildEpic + selectEpicCandidates). */
export interface EpicUnitInput {
  parentNumber: number;
  parentTitle: string;
  parentUrl: string;
  parentCreatedAt: number;
  parentLabels: string[];
  /** Forge colors paired with parentLabels; forwarded to the collapsed Up Next row. */
  parentLabelColors?: Record<string, string>;
  /** The epic parent's assignees. The unit is filtered by these (#824) — the candidate child
   *  is synthesized with `assignees: []`, so the parent is the assignee-bearing issue (matching
   *  what the Backlog hides). */
  parentAssignees: string[];
  /** The epic parent's author; with parentAssignees it decides whether the unit is "mine". */
  parentAuthor?: string;
  /** All epic member issue numbers — removed from the flat per-repo list (dedup). */
  memberNumbers: number[];
  /** selectEpicCandidates()[0], or null when no child is actionable (suppress the unit). */
  candidate: Issue | null;
  /** The epic parent's own still-open blockers (GitHub issue dependencies). Non-empty ⇒ the whole
   *  epic unit is suppressed from Up Next, mirroring the standalone blocked-issue rule. */
  parentBlockedBy?: number[];
}

export interface RepoInput {
  repoPath: string;
  repoSlug: string | null;
  repoLabel: string;
  lastUsedAt: number | null;
  /** The operator's own login on this repo's forge (`forge.currentUser()`), or null when it
   *  can't be resolved (local forge / un-authed / no identity API). Drives the issue filter's
   *  "mine" (src/issue-filter.ts); null fails open (scope / forks:own hide nothing here). */
  viewer: string | null;
  /** `forge.isFork`: the repo is a fork and lists its upstream's issues. */
  isFork: boolean;
  openIssues: Issue[];
  epics: EpicUnitInput[];
  /** All native sub-issue numbers in the repo (from listSubIssueSummaries). Removed from the
   *  flat list even when their parent is off-page, so an orphan child never lists standalone —
   *  mirrors the backlog's hide-set. */
  subIssueNumbers: number[];
  /** Issue numbers an open PR would close (best-effort secondary exclusion). */
  linkedIssueNumbers: number[];
}

/** UI display caps (items beyond these reveal via a "show all N" expander). The server
 *  returns the full list; these document the default rendered count. */
export const PRIORITY_CAP = 10;
export const REPO_CAP = 5;

const BUG_LABELS = new Set(["bug", "type/bug", "type:bug"]);
const EXCLUDE_LABELS = new Set(["wontfix", "wont-fix"]);
/** Word-boundary "blocked" match — mirrors BLOCKED_LABEL_RE / isBlocked in
 *  ui/src/lib/components/issues-panel.ts (kept in sync for server↔UI parity; no shared module
 *  spans src/ ↔ ui/). Matches `blocked`, `blocked-upstream`, `status:blocked`; NOT `unblocked`
 *  or `blocking`. Up Next only lists startable work, so any blocked-labeled issue is dropped. */
const BLOCKED_LABEL_RE = /\bblocked/i;
function hasBlockedLabel(labels: string[]): boolean {
  return labels.some((l) => BLOCKED_LABEL_RE.test(l));
}
const KIND_RANK: Record<UpNextKind, number> = { epic: 0, bug: 1, feature: 2 };

function lc(labels: string[]): Set<string> {
  return new Set(labels.map((l) => l.toLowerCase()));
}
function hasLabel(set: Set<string>, label: string): boolean {
  return set.has(label.toLowerCase());
}
function intersects(set: Set<string>, want: Set<string>): boolean {
  for (const w of want) if (set.has(w)) return true;
  return false;
}

/** Bot-authored issues: the PR-only classifyPr heuristics don't transfer to issues, so this
 *  collapses to author-login matching — Dependabot plus any `[bot]` suffix. Bot-authored
 *  issues are rare in practice (bots open PRs); label exclusions carry most of the weight. */
function isBotAuthored(issue: Issue): boolean {
  const a = issue.author;
  if (!a) return false;
  return isDependabotAuthor(a) || a.toLowerCase().endsWith("[bot]");
}

function classifyKind(labelSet: Set<string>): "bug" | "feature" {
  return intersects(labelSet, BUG_LABELS) ? "bug" : "feature";
}

/** A standalone issue's kind from its labels — exported so the readiness eval (#2535) rebuilds
 *  today's in-repo order with the same rule. */
export function standaloneKind(labels: string[]): "bug" | "feature" {
  return classifyKind(lc(labels));
}

/** Today's in-repo order: epic > bug > feature, then oldest, then issue number. */
export function compareInRepo(
  a: Pick<UpNextItem, "kind" | "createdAt" | "number">,
  b: Pick<UpNextItem, "kind" | "createdAt" | "number">,
): number {
  return KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.createdAt - b.createdAt || a.number - b.number;
}

/** Standalone-issue exclusions applied before ranking. Epic membership + PR-linkage are
 *  handled by the caller (they need cross-issue context). */
function isExcludedIssue(issue: Issue, labelSet: Set<string>): boolean {
  if (hasLabel(labelSet, ACTIVE_LABEL)) return true;
  if (intersects(labelSet, EXCLUDE_LABELS)) return true;
  if (hasBlockedLabel(issue.labels)) return true; // blocked-word label (any boundary variant)
  if (isBotAuthored(issue)) return true;
  if (issue.blockedBy && issue.blockedBy.length > 0) return true; // dependency-blocked (#1622)
  return false;
}

/** A startable row (every non-filter exclusion passed) plus what the issue filter reads. */
interface Candidate {
  item: UpNextItem;
  subject: IssueFilterSubject;
  ctx: IssueFilterContext;
}

function candidate(
  repo: RepoInput,
  item: Omit<UpNextItem, "fromFork" | "mine">,
  subject: IssueFilterSubject,
): Candidate {
  return {
    item: { ...item, fromFork: repo.isFork, mine: isMine(subject, repo.viewer) },
    subject,
    ctx: { viewer: repo.viewer, isFork: repo.isFork },
  };
}

/** Map one standalone (non-epic) open issue to a candidate row, or null when excluded. */
function standaloneItem(repo: RepoInput, issue: Issue, linkedSet: Set<number>): Candidate | null {
  const labelSet = lc(issue.labels);
  if (isExcludedIssue(issue, labelSet)) return null;
  if (linkedSet.has(issue.number)) return null; // best-effort secondary
  const item = {
    repoPath: repo.repoPath,
    repoSlug: repo.repoSlug,
    repoLabel: repo.repoLabel,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    kind: classifyKind(labelSet),
    priority: hasLabel(labelSet, PRIORITY_LABEL),
    createdAt: issue.createdAt,
    labels: issue.labels,
    labelColors: issue.labelColors,
    issueRef: { number: issue.number, url: issue.url, title: issue.title },
  };
  return candidate(repo, item, issue);
}

/** Map one epic to a single unit candidate (keyed by its next-actionable child, aged by the
 *  parent), or null when it has no actionable child / is excluded / its child already has a PR in
 *  flight. The issue filter reads the PARENT (assignees, author, labels). */
function epicItem(repo: RepoInput, e: EpicUnitInput, linkedSet: Set<number>): Candidate | null {
  const c = e.candidate;
  if (!c) return null; // no actionable child → suppress (DAG-blocked / in-flight)
  const parentLabelSet = lc(e.parentLabels);
  if (hasLabel(parentLabelSet, ACTIVE_LABEL)) return null;
  if (intersects(parentLabelSet, EXCLUDE_LABELS)) return null;
  if (hasBlockedLabel(e.parentLabels)) return null; // blocked-word label (any boundary variant)
  if (e.parentBlockedBy && e.parentBlockedBy.length > 0) return null; // epic parent dependency-blocked
  if (linkedSet.has(c.number)) return null; // the child already has a PR in flight
  const item = {
    repoPath: repo.repoPath,
    repoSlug: repo.repoSlug,
    repoLabel: repo.repoLabel,
    number: c.number,
    title: c.title,
    url: c.url,
    kind: "epic" as const,
    priority: hasLabel(parentLabelSet, PRIORITY_LABEL),
    createdAt: e.parentCreatedAt,
    labels: e.parentLabels,
    labelColors: e.parentLabelColors,
    epicParent: { number: e.parentNumber, title: e.parentTitle },
    issueRef: { number: c.number, url: c.url, title: c.title },
  };
  return candidate(repo, item, {
    assignees: e.parentAssignees,
    author: e.parentAuthor,
    labels: e.parentLabels,
  });
}

function repoCandidates(repo: RepoInput): Candidate[] {
  // Remove epic parents AND members from the flat list: the parent rolls up to its unit
  // (or is suppressed when no child is actionable) and never lists as a standalone issue.
  const memberSet = new Set<number>(repo.subIssueNumbers);
  for (const e of repo.epics) {
    memberSet.add(e.parentNumber);
    for (const m of e.memberNumbers) memberSet.add(m);
  }
  const linkedSet = new Set(repo.linkedIssueNumbers);
  const out: Candidate[] = [];
  // Standalone issues (epic members removed → no double-listing), then one row per epic unit.
  for (const issue of repo.openIssues) {
    if (memberSet.has(issue.number)) continue;
    const it = standaloneItem(repo, issue, linkedSet);
    if (it) out.push(it);
  }
  for (const e of repo.epics) {
    const it = epicItem(repo, e, linkedSet);
    if (it) out.push(it);
  }
  return out;
}

/** The rules buildSnapshot applies. `repoOverrides` is keyed by RAW `repoPath` (the service
 *  reconciles the stored realpath keys first). */
type RuleFilter = Pick<IssueFilterSettings, "scope" | "forks" | "hiddenLabels"> &
  Partial<Pick<IssueFilterSettings, "repoOverrides">>;

/** A repo's candidates, carrying its override (if any) in the filter context. */
function overriddenCandidates(repo: RepoInput, filter: RuleFilter): Candidate[] {
  const override = filter.repoOverrides?.[repo.repoPath];
  const out = repoCandidates(repo);
  return override ? out.map((c) => ({ ...c, ctx: { ...c.ctx, override } })) : out;
}

function visibleCount(candidates: Candidate[], filter: RuleFilter): number {
  return candidates.filter((c) => hiddenByRule(c.subject, c.ctx, filter) === null).length;
}

function optionCounts(
  candidates: Candidate[],
  filter: RuleFilter,
): UpNextFilterStats["optionCounts"] {
  const count = <K extends string>(options: readonly K[], field: "scope" | "forks") =>
    Object.fromEntries(
      options.map((o) => [o, visibleCount(candidates, { ...filter, [field]: o })]),
    ) as Record<K, number>;
  return { scope: count(ISSUE_FILTER_SCOPES, "scope"), forks: count(ISSUE_FILTER_FORKS, "forks") };
}

/** Split the startable candidates into the visible items and the stats of what the filter hides. */
function applyFilter(
  candidates: Candidate[],
  filter: RuleFilter,
): { visible: UpNextItem[]; stats: UpNextFilterStats } {
  const visible: UpNextItem[] = [];
  const hiddenBy: Record<IssueFilterRule, number> = { scope: 0, forks: 0, labels: 0, repo: 0 };
  const hiddenByRepo: Record<string, number> = {};
  for (const c of candidates) {
    const rule = hiddenByRule(c.subject, c.ctx, filter);
    if (rule === null) {
      visible.push(c.item);
      continue;
    }
    hiddenBy[rule]++;
    hiddenByRepo[c.item.repoPath] = (hiddenByRepo[c.item.repoPath] ?? 0) + 1;
  }
  const stats: UpNextFilterStats = {
    hiddenCount: candidates.length - visible.length,
    hiddenBy,
    hiddenByRepo,
    optionCounts: optionCounts(candidates, filter),
  };
  return { visible, stats };
}

/** repoPath -> warm rank (0 = warmest). lastUsedAt desc; nulls last; ties by label then path. */
function warmRanks(repos: RepoInput[]): Map<string, number> {
  const ordered = [...repos].sort(
    (a, b) =>
      (b.lastUsedAt ?? -Infinity) - (a.lastUsedAt ?? -Infinity) ||
      a.repoLabel.localeCompare(b.repoLabel) ||
      a.repoPath.localeCompare(b.repoPath),
  );
  const rank = new Map<string, number>();
  ordered.forEach((r, i) => rank.set(r.repoPath, i));
  return rank;
}

export function buildSnapshot(
  repos: RepoInput[],
  now: number,
  fallback: string | null = null,
  failedRepoCount = 0,
  filter: RuleFilter = DEFAULT_ISSUE_FILTER,
): UpNextSnapshot {
  const rank = warmRanks(repos);
  const { visible: all, stats } = applyFilter(
    repos.flatMap((r) => overriddenCandidates(r, filter)),
    filter,
  );

  // Tier 1 — priority across all repos: warm-first, then oldest age, then issue number.
  const priority = all
    .filter((i) => i.priority)
    .sort(
      (a, b) =>
        (rank.get(a.repoPath) ?? 0) - (rank.get(b.repoPath) ?? 0) ||
        a.createdAt - b.createdAt ||
        a.number - b.number,
    );

  const sections: UpNextSection[] = [];
  if (priority.length > 0) {
    sections.push({
      kind: "priority",
      repoPath: null,
      repoSlug: null,
      repoLabel: null,
      items: priority,
      totalCount: priority.length,
    });
  }

  // Tier 2 — per-repo clusters in warm order; non-priority only (priority pulled out above).
  const byRepo = new Map<string, UpNextItem[]>();
  for (const i of all) {
    if (i.priority) continue;
    (byRepo.get(i.repoPath) ?? byRepo.set(i.repoPath, []).get(i.repoPath)!).push(i);
  }
  const warmOrder = [...repos].sort(
    (a, b) => (rank.get(a.repoPath) ?? 0) - (rank.get(b.repoPath) ?? 0),
  );
  for (const repo of warmOrder) {
    const items = byRepo.get(repo.repoPath);
    if (!items || items.length === 0) continue; // silently omit fully-excluded repos
    items.sort(compareInRepo);
    sections.push({
      kind: "repo",
      repoPath: repo.repoPath,
      repoSlug: repo.repoSlug,
      repoLabel: repo.repoLabel,
      items,
      totalCount: items.length,
    });
  }

  return {
    generatedAt: now,
    sections,
    repoCount: repos.length,
    fallback,
    failedRepoCount,
    filter: stats,
  };
}

/** One section's items stable-sorted by readiness band, the ORIGINAL index breaking ties — so each
 *  band keeps the order the section already had (warm order for priority, compareInRepo per repo). */
function rankByBand(
  items: UpNextItem[],
  scoreOf: (item: UpNextItem) => number | null,
): UpNextItem[] {
  return items
    .map((item, index) => ({ item, index, rank: BAND_RANK[band(scoreOf(item))] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Readiness rerank (#2535): reorder items WITHIN each section by readiness band (ready → maybe →
 * notReady; an unscored item is `maybe`). Deliberately narrow — sections keep their order, no item
 * crosses a section, and the priority label still dominates — so the judge can only refine today's
 * order, never override it. All-null scores are therefore the identity (every item lands in `maybe`).
 */
export function applyReadiness(
  snap: UpNextSnapshot,
  scoreOf: (item: UpNextItem) => number | null,
): UpNextSnapshot {
  return {
    ...snap,
    sections: snap.sections.map((section) => ({
      ...section,
      items: rankByBand(section.items, scoreOf),
    })),
  };
}

/**
 * Apply a read-time hidden-repo filter to an already-computed snapshot.
 *
 * Used by handleUpNextGet so that a repo hidden *after* the last background compute is
 * invisible on the very next GET, without waiting for the next recompute cycle (≤15 min).
 * The source filter (buildUpNextRepos) prevents wasted forge fan-out for the next compute;
 * this filter gives instant freshness for the cached payload in between.
 *
 * `hiddenRaw` must already be in the raw join(repoRoot,name) path-space (reconciled by the
 * caller, e.g. via reconcileRealPathsToRaw — keeping path-space concerns out of this module).
 */
export function excludeHiddenSections(
  snap: UpNextSnapshot,
  hiddenRaw: Set<string>,
): UpNextSnapshot {
  if (hiddenRaw.size === 0) return snap;

  let removedRepoSections = 0;
  const sections: UpNextSection[] = [];

  for (const section of snap.sections) {
    if (section.kind === "repo") {
      if (section.repoPath != null && hiddenRaw.has(section.repoPath)) {
        removedRepoSections++;
        continue; // drop this section entirely
      }
      sections.push(section);
    } else if (section.kind === "priority") {
      const filteredItems = section.items.filter((item) => !hiddenRaw.has(item.repoPath));
      if (filteredItems.length === 0) continue; // drop priority section when it empties
      sections.push({ ...section, items: filteredItems, totalCount: filteredItems.length });
    } else {
      sections.push(section);
    }
  }

  return {
    ...snap,
    sections,
    repoCount: Math.max(0, snap.repoCount - removedRepoSections),
    filter: withoutHiddenRepos(snap.filter, hiddenRaw),
  };
}

/** Drop hidden repos from the per-repo hidden counts and the total. `hiddenBy` / `optionCounts`
 *  carry no per-repo split, so they stay as computed until the next compute (whose source filter
 *  already excludes the repo). */
function withoutHiddenRepos(stats: UpNextFilterStats, hiddenRaw: Set<string>): UpNextFilterStats {
  const hiddenByRepo: Record<string, number> = {};
  let dropped = 0;
  for (const [path, n] of Object.entries(stats.hiddenByRepo)) {
    if (hiddenRaw.has(path)) dropped += n;
    else hiddenByRepo[path] = n;
  }
  if (dropped === 0) return stats;
  return { ...stats, hiddenCount: Math.max(0, stats.hiddenCount - dropped), hiddenByRepo };
}
