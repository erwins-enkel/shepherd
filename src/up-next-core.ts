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
  /** Payload for SessionService.create()'s issueRef on Start. */
  issueRef: { number: number; url: string; title: string; body: string };
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
   *  can't be resolved (local forge / un-authed / no identity API). Drives the "mine &
   *  unassigned" filter (#824); null fails open (no assignee filtering — show everything). */
  viewer: string | null;
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

/** The "mine & unassigned" predicate (#824): true when the issue is assigned to at least one
 *  person and the viewer is NOT among them (i.e. assigned solely to others → hide). Fails open
 *  when `viewer` is null (unknown "me"): unassigned and mine-assigned always pass. Mirrors the
 *  Backlog's `hideOthers` (ui/src/lib/components/issues-panel.ts). */
function isAssignedToOthers(assignees: string[], viewer: string | null): boolean {
  if (viewer == null) return false;
  return assignees.length > 0 && !assignees.includes(viewer);
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

/** Map one standalone (non-epic) open issue to a row, or null when excluded. */
function standaloneItem(repo: RepoInput, issue: Issue, linkedSet: Set<number>): UpNextItem | null {
  const labelSet = lc(issue.labels);
  if (isExcludedIssue(issue, labelSet)) return null;
  if (isAssignedToOthers(issue.assignees, repo.viewer)) return null; // #824 mine & unassigned
  if (linkedSet.has(issue.number)) return null; // best-effort secondary
  return {
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
    issueRef: { number: issue.number, url: issue.url, title: issue.title, body: issue.body },
  };
}

/** Map one epic to a single unit row (keyed by its next-actionable child, aged by the parent),
 *  or null when it has no actionable child / is excluded / its child already has a PR in flight. */
function epicItem(repo: RepoInput, e: EpicUnitInput, linkedSet: Set<number>): UpNextItem | null {
  const c = e.candidate;
  if (!c) return null; // no actionable child → suppress (DAG-blocked / in-flight)
  const parentLabelSet = lc(e.parentLabels);
  if (hasLabel(parentLabelSet, ACTIVE_LABEL)) return null;
  if (intersects(parentLabelSet, EXCLUDE_LABELS)) return null;
  if (hasBlockedLabel(e.parentLabels)) return null; // blocked-word label (any boundary variant)
  if (isAssignedToOthers(e.parentAssignees, repo.viewer)) return null; // #824 (keyed on parent)
  if (e.parentBlockedBy && e.parentBlockedBy.length > 0) return null; // epic parent dependency-blocked
  if (linkedSet.has(c.number)) return null; // the child already has a PR in flight
  return {
    repoPath: repo.repoPath,
    repoSlug: repo.repoSlug,
    repoLabel: repo.repoLabel,
    number: c.number,
    title: c.title,
    url: c.url,
    kind: "epic",
    priority: hasLabel(parentLabelSet, PRIORITY_LABEL),
    createdAt: e.parentCreatedAt,
    labels: e.parentLabels,
    labelColors: e.parentLabelColors,
    epicParent: { number: e.parentNumber, title: e.parentTitle },
    issueRef: { number: c.number, url: c.url, title: c.title, body: c.body },
  };
}

function repoItems(repo: RepoInput): UpNextItem[] {
  // Remove epic parents AND members from the flat list: the parent rolls up to its unit
  // (or is suppressed when no child is actionable) and never lists as a standalone issue.
  const memberSet = new Set<number>(repo.subIssueNumbers);
  for (const e of repo.epics) {
    memberSet.add(e.parentNumber);
    for (const m of e.memberNumbers) memberSet.add(m);
  }
  const linkedSet = new Set(repo.linkedIssueNumbers);
  const items: UpNextItem[] = [];
  // Standalone issues (epic members removed → no double-listing), then one row per epic unit.
  for (const issue of repo.openIssues) {
    if (memberSet.has(issue.number)) continue;
    const it = standaloneItem(repo, issue, linkedSet);
    if (it) items.push(it);
  }
  for (const e of repo.epics) {
    const it = epicItem(repo, e, linkedSet);
    if (it) items.push(it);
  }
  return items;
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
): UpNextSnapshot {
  const rank = warmRanks(repos);
  const all = repos.flatMap((r) => repoItems(r));

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
    items.sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.createdAt - b.createdAt || a.number - b.number,
    );
    sections.push({
      kind: "repo",
      repoPath: repo.repoPath,
      repoSlug: repo.repoSlug,
      repoLabel: repo.repoLabel,
      items,
      totalCount: items.length,
    });
  }

  return { generatedAt: now, sections, repoCount: repos.length, fallback, failedRepoCount };
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
  };
}
