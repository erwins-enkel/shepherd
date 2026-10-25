/**
 * Pure logic extracted from IssuesPanel.svelte — unit-testable without a DOM.
 */
import type {
  Issue,
  EpicSummary,
  EpicChild,
  IssueFilterRepoOverride,
  IssueFilterSettings,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

/** Which "someone else is working / owns this epic" signal (#1616) fired, highest-priority first. */
export type EpicOthersTier = "inflight" | "assigned" | "authored";

export interface EpicOthersFlag {
  tier: EpicOthersTier;
  /** In-flight child count (only meaningful for the "inflight" tier; 0 otherwise). */
  inFlight: number;
  /** Who to name on the pill/notice — PR authors (inflight), assignees, or the lone author. */
  who: string[];
}

/**
 * Derive the epic-ownership flag from an {@link EpicSummary}'s server-computed fields (already
 * viewer-excluded, so nothing here ever points at the operator's own work). Precedence:
 * in-flight children → parent assigned to others → parent authored by another. Returns null when
 * the epic isn't flagged (or `summary` is absent — a non-epic row). The `?? …` guards tolerate an
 * older payload predating these optional fields.
 */
export function epicFlagForOthers(summary: EpicSummary | undefined): EpicOthersFlag | null {
  if (!summary) return null;
  const inFlight = summary.inFlight ?? 0;
  if (inFlight > 0) return { tier: "inflight", inFlight, who: summary.inFlightBy ?? [] };
  const assigned = summary.assignedOthers ?? [];
  if (assigned.length > 0) return { tier: "assigned", inFlight: 0, who: assigned };
  if (summary.authoredByOther)
    return { tier: "authored", inFlight: 0, who: [summary.authoredByOther] };
  return null;
}

/**
 * Label the drain stamps on an issue claimed by a running session (mirrors
 * ACTIVE_LABEL in src/drain-core.ts). Canonical UI-side source — imported by
 * PromptSources.svelte and IssuesPanel.svelte instead of a bare literal.
 */
export const ACTIVE_LABEL = "shepherd:active";

/**
 * Matches a `blocked` word at a word boundary, case-insensitive — e.g. `blocked`,
 * `blocked-upstream`, `status/blocked`, `S: blocked`, `kind:blocked`. Does NOT match
 * `unblocked`/`unblock-me` (no boundary before "blocked" there). No `g` flag: `.test()`
 * stays stateless, so the shared instance is safe to reuse across calls.
 */
const BLOCKED_LABEL_RE = /\bblocked/i;

/**
 * Whether an issue's labels mark it blocked (any label matching {@link BLOCKED_LABEL_RE}).
 * The `?? []` guard tolerates a stale payload that predates the `labels` field.
 */
export function isBlocked(labels: readonly string[]): boolean {
  return (labels ?? []).some((l) => BLOCKED_LABEL_RE.test(l));
}

/**
 * Narrow an issue list to hide "blocked" issues (labeled with a blocked-word label —
 * see {@link isBlocked}). Fails open — returns every issue unchanged — when `on` is false.
 */
export function hideBlockedIssues(issues: readonly Issue[], on: boolean): Issue[] {
  if (!on) return [...issues];
  return issues.filter((issue) => !isBlocked(issue.labels));
}

/**
 * Narrow an issue list by a free-text query (the panel's search field).
 * Case-insensitive substring match against number (with or without a leading
 * `#`), title, body, and labels. A blank/whitespace query is an identity
 * filter — the field starts empty and must not hide anything.
 */
export function filterIssues(issues: readonly Issue[], query: string): Issue[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...issues];
  const needle = q.startsWith("#") ? q.slice(1) : q;
  return issues.filter(
    (issue) =>
      String(issue.number).includes(needle) ||
      issue.title.toLowerCase().includes(q) ||
      issue.body.toLowerCase().includes(q) ||
      issue.labels.some((label) => label.toLowerCase().includes(q)),
  );
}

/**
 * Distinct author logins present in an issue list, sorted case-insensitively.
 * Issues without an author (forges/paths that don't supply one) contribute nothing.
 * Source for the author filter's radio options — computed from the RAW list so
 * picking one author doesn't make the others vanish from the picker.
 */
export function distinctAuthors(issues: readonly Issue[]): string[] {
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.author) seen.add(issue.author);
  }
  return [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Distinct label names present in an issue list, sorted case-insensitively, EXCLUDING
 * the `shepherd:active` system label (the dedicated "hide in progress" toggle already
 * governs it, so it doesn't belong in the categorization picker). Source for the label
 * filter's toggle chips — computed from the RAW list for the same reason as
 * {@link distinctAuthors}.
 *
 * `opts.excludeBlocked` additionally skips any blocked-word label (per {@link isBlocked}) —
 * the dedicated "hide blocked" toggle already governs those. Default false: unchanged
 * behaviour for existing callers.
 */
export function distinctLabels(
  issues: readonly Issue[],
  opts?: { excludeBlocked?: boolean },
): string[] {
  const excludeBlocked = opts?.excludeBlocked ?? false;
  const seen = new Set<string>();
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      if (label === ACTIVE_LABEL) continue;
      if (excludeBlocked && isBlocked([label])) continue;
      seen.add(label);
    }
  }
  return [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Merge every issue's `labelColors` into one name → hex map, for the filter popover
 * (which lists distinct label names across the whole backlog and wants a color per
 * name, not per issue). Simple last-wins merge; issues without `labelColors` (forge
 * didn't supply them, or a stale payload predating the field) contribute nothing.
 */
export function labelColorMap(issues: readonly Issue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) {
    if (!issue.labelColors) continue;
    for (const [name, hex] of Object.entries(issue.labelColors)) {
      map[name] = hex;
    }
  }
  return map;
}

/**
 * Narrow an issue list to a single author. Keeps issues whose `author` equals the
 * selected login; a `null` selection is an identity filter (no author chosen). An issue
 * with no author is dropped when a specific author is selected — correct, since it can't
 * match. The `?? []`-free comparison is safe: `author` is a scalar, absent → undefined.
 */
export function filterByAuthor(issues: readonly Issue[], author: string | null): Issue[] {
  if (author == null) return [...issues];
  return issues.filter((issue) => issue.author === author);
}

/**
 * Narrow an issue list to those carrying ALL selected labels (AND semantics, mirroring
 * GitHub's multi-label filtering). An empty selection is an identity filter. The `?? []`
 * guard tolerates a stale payload predating the `labels` field.
 */
export function filterByLabels(issues: readonly Issue[], selected: ReadonlySet<string>): Issue[] {
  if (selected.size === 0) return [...issues];
  return issues.filter((issue) => {
    const labels = issue.labels ?? [];
    for (const want of selected) {
      if (!labels.includes(want)) return false;
    }
    return true;
  });
}

// ── Default issue filter (#3007/#3019) ──────────────────────────────────────────────────
// Mirrors src/issue-filter.ts (the server applies the same rules to Up Next); keep in sync:
//   - mine: viewer known AND (assignee OR author). A null viewer fails open (scope and
//     `forks: own` hide nothing).
//   - scope: all | mine_unassigned (mine or unassigned) | mine.
//   - forks (repo is a fork): all | own (only mine) | hide (everything).
//   - repo override (#3020) replaces scope + forks for its repo: all | mine_unassigned | mine
//     (as the scope) | hide (everything).
//   - hiddenLabels: case-insensitive intersection drops the issue.
//   - attributed to the FIRST rule that drops it: repo override (else scope → forks) → labels.

export type DefaultFilterRule = "scope" | "forks" | "labels" | "repo";

export interface DefaultFilterContext {
  viewer: string | null;
  isFork: boolean;
  /** This repo's override, when it has one. */
  override?: IssueFilterRepoOverride;
}

/** Assigned to or authored by the viewer. The `?? []` guard tolerates a stale payload. */
export function isMine(issue: Issue, viewer: string | null): boolean {
  if (viewer == null) return false;
  return (issue.assignees ?? []).includes(viewer) || issue.author === viewer;
}

function scopeHides(issue: Issue, viewer: string | null, scope: IssueFilterSettings["scope"]) {
  if (scope === "all" || viewer == null || isMine(issue, viewer)) return false;
  return scope === "mine" || (issue.assignees ?? []).length > 0;
}

function overrideHides(issue: Issue, viewer: string | null, override: IssueFilterRepoOverride) {
  return override === "hide" || scopeHides(issue, viewer, override);
}

function forksHides(issue: Issue, ctx: DefaultFilterContext, forks: IssueFilterSettings["forks"]) {
  if (!ctx.isFork || forks === "all") return false;
  if (forks === "hide") return true;
  return ctx.viewer != null && !isMine(issue, ctx.viewer);
}

function labelsHide(issue: Issue, hidden: ReadonlySet<string>) {
  return hidden.size > 0 && (issue.labels ?? []).some((l) => hidden.has(l.toLowerCase()));
}

type RuleFilter = Pick<IssueFilterSettings, "scope" | "forks" | "hiddenLabels">;

/**
 * Apply the default filter's scope → forks → labels rules, returning each stage so an empty
 * list can be attributed to the rule that emptied it. With a repo override, `afterScope` and
 * `afterForks` both hold what the override keeps. `exemptFromScope` keeps a row the scope rule
 * (or a mine override) would drop — the Backlog's flagged epics (#1616), whose pill names who
 * owns them; a `hide` override drops them too.
 */
export function applyDefaultFilter(
  issues: readonly Issue[],
  ctx: DefaultFilterContext,
  filter: RuleFilter,
  exemptFromScope: (issue: Issue) => boolean = () => false,
): { afterScope: Issue[]; afterForks: Issue[]; afterLabels: Issue[] } {
  const override = ctx.override;
  const hidden = new Set(filter.hiddenLabels.map((l) => l.toLowerCase()));
  if (override) {
    const kept = issues.filter(
      (i) => !overrideHides(i, ctx.viewer, override) || (override !== "hide" && exemptFromScope(i)),
    );
    return {
      afterScope: kept,
      afterForks: kept,
      afterLabels: kept.filter((i) => !labelsHide(i, hidden)),
    };
  }
  const afterScope = issues.filter(
    (i) => !scopeHides(i, ctx.viewer, filter.scope) || exemptFromScope(i),
  );
  const afterForks = afterScope.filter((i) => !forksHides(i, ctx, filter.forks));
  const afterLabels = afterForks.filter((i) => !labelsHide(i, hidden));
  return { afterScope, afterForks, afterLabels };
}

/** Which default-filter rule emptied a non-empty list, or null when it didn't. */
export function defaultFilterEmptiedBy(
  total: number,
  stages: ReturnType<typeof applyDefaultFilter>,
  ctx: DefaultFilterContext,
  filter: RuleFilter,
): DefaultFilterRule | null {
  if (total === 0) return null;
  if (ctx.override) {
    if (stages.afterScope.length === 0) return "repo";
    return stages.afterLabels.length === 0 ? "labels" : null;
  }
  if (stages.afterScope.length === 0 && ctx.viewer != null && filter.scope !== "all")
    return "scope";
  if (stages.afterScope.length > 0 && stages.afterForks.length === 0) return "forks";
  if (stages.afterForks.length > 0 && stages.afterLabels.length === 0) return "labels";
  return null;
}

/** The empty-state copy for a list the default filter emptied. */
export function defaultFilterEmptyMessage(
  rule: DefaultFilterRule,
  scope: IssueFilterSettings["scope"],
): string {
  if (rule === "repo") return m.issues_filter_all_repo_override();
  if (rule === "forks") return m.issues_filter_all_forks();
  if (rule === "labels") return m.issues_filter_all_hidden_labels();
  return scope === "mine"
    ? m.issues_filter_all_not_mine()
    : m.issues_filter_all_assigned_to_others();
}

/**
 * The assignee logins of an issue that are NOT the viewer — the "someone else is
 * assigned" list that drives the plain-issue "assigned to X" pill (#1694), mirroring
 * the epic `assignedOthers` computation (src/epic-core.ts).
 *
 * Returns `[]` when `viewer` is null: this is specifically the "others" list, and
 * claiming "assigned to others" without knowing who "me" is would mislabel the
 * operator's own issues. A null viewer does NOT mean "show nothing" — the row falls
 * back to a neutral assignee listing (see IssueRow) built from `issue.assignees`
 * directly; only the "others" framing is withheld until the viewer is known.
 *
 * The `?? []` guard tolerates a stale payload predating the `assignees` field.
 */
export function assignedOthers(issue: Issue, viewer: string | null): string[] {
  if (viewer == null) return [];
  return (issue.assignees ?? []).filter((login) => login !== viewer);
}

/**
 * Narrow an issue list to "hide in progress": drop issues already claimed by a
 * running session (labeled `shepherd:active`). Viewer-agnostic — it keys off a
 * label, not assignees.
 *
 * Fails open — returns every issue unchanged — when `enabled` is false. The
 * `?? []` guard tolerates a stale payload that predates the `labels` field, so
 * the helper can never throw on a missing array.
 */
export function hideActive(issues: readonly Issue[], enabled: boolean): Issue[] {
  if (!enabled) return [...issues];
  return issues.filter((issue) => !(issue.labels ?? []).includes(ACTIVE_LABEL));
}

/**
 * Narrow an issue list to hide native sub-issues (children of a GitHub epic),
 * nudging the operator to start an epic drain instead of draining a child alone.
 *
 * Hides an issue only when it is a native sub-issue (`subIssues.has(number)`) AND
 * not itself an epic parent (`!epicParents.has(number)`) — so a mid-level epic
 * (a sub-issue that is also a parent) stays visible as a drain entry point.
 *
 * Fails open — returns every issue unchanged — when `enabled` is false or
 * `subIssues` is empty (non-GitHub forge / drain-absent / epics not yet loaded).
 */
export function hideSubIssues(
  issues: readonly Issue[],
  enabled: boolean,
  subIssues: ReadonlySet<number>,
  epicParents: ReadonlySet<number>,
): Issue[] {
  if (!enabled) return [...issues];
  return issues.filter((issue) => !(subIssues.has(issue.number) && !epicParents.has(issue.number)));
}

/**
 * Reorder an issue list so epic parents (issues whose number is in `epicParents`)
 * come first, followed by everything else. Stable — the relative order within
 * each group is preserved (so the forge's newest-first ordering survives inside
 * both groups). Returns a new array; the input is not mutated.
 *
 * A no-op (identity copy) when there are no epic parents in the list.
 */
export function sortEpicsFirst(
  issues: readonly Issue[],
  epicParents: ReadonlySet<number>,
): Issue[] {
  const epics: Issue[] = [];
  const rest: Issue[] = [];
  for (const issue of issues) {
    (epicParents.has(issue.number) ? epics : rest).push(issue);
  }
  return [...epics, ...rest];
}

// ── Repo overview (#2638) ─────────────────────────────────────────────────────────────────

/** When an issue last changed: the forge's `updatedAt`, else (older payload, or a forge that
 *  doesn't report it) its creation. */
export function lastChange(issue: Issue): number {
  return issue.updatedAt ?? issue.createdAt;
}

/** "Älteste zuerst": least recently changed first. Stable; returns a new array. */
export function sortOldestFirst(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) => lastChange(a) - lastChange(b));
}

/** An issue counts as lying around once it has gone this many days without a change. */
export const STALE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface StaleSummary {
  /** Issues unchanged for over {@link STALE_DAYS} days. */
  stale: number;
  total: number;
  /** The least recently changed issue and its days without a change; null when none. */
  oldest: { issue: Issue; days: number } | null;
}

export function staleSummary(issues: readonly Issue[], now: number): StaleSummary {
  let stale = 0;
  let oldest: Issue | null = null;
  for (const issue of issues) {
    if (now - lastChange(issue) > STALE_DAYS * DAY_MS) stale++;
    if (!oldest || lastChange(issue) < lastChange(oldest)) oldest = issue;
  }
  return {
    stale,
    total: issues.length,
    oldest: oldest
      ? { issue: oldest, days: Math.floor((now - lastChange(oldest)) / DAY_MS) }
      : null,
  };
}

/** Open issues per label, most first (ties by name). Only `labels` count — pass the list's
 *  label filter options, so every entry is one the filter can actually apply. */
export function labelCounts(
  issues: readonly Issue[],
  labels: readonly string[],
): { label: string; count: number }[] {
  return labels
    .map((label) => ({
      label,
      count: issues.filter((i) => (i.labels ?? []).includes(label)).length,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface RunningIssue {
  issue: Issue;
  /** The live session working it; null when only the claim label says it runs. */
  sessionId: string | null;
  desig: string | null;
  /** The list's filters currently hide it. */
  hidden: boolean;
}

/** Issues being worked right now: a live session links to them, or the drain's claim label
 *  ({@link ACTIVE_LABEL}) marks them. Listed even when the list's filters hide them — the
 *  overview says what runs, independent of what the list shows. */
export function runningIssues(
  issues: readonly Issue[],
  sessionFor: (issue: number) => { id: string; desig: string } | null,
  visible: ReadonlySet<number>,
): RunningIssue[] {
  return issues.flatMap((issue) => {
    const session = sessionFor(issue.number);
    if (!session && !(issue.labels ?? []).includes(ACTIVE_LABEL)) return [];
    return [
      {
        issue,
        sessionId: session?.id ?? null,
        desig: session?.desig ?? null,
        hidden: !visible.has(issue.number),
      },
    ];
  });
}

/** One row of the backlog issue list (#2617): an epic header, one of an expanded epic's
 *  children (or its loading placeholder while the record is fetched), or a single issue. */
export type IssueListRow =
  | { kind: "epic"; key: string; issue: Issue; expanded: boolean }
  | { kind: "child"; key: string; parent: number; child: EpicChild }
  | { kind: "loading"; key: string; parent: number }
  | { kind: "single"; key: string; issue: Issue };

/** A resolved list selection — what the reading detail renders. */
export type IssueSelection =
  | { kind: "epic"; issue: Issue }
  | { kind: "child"; parent: number; child: EpicChild }
  | { kind: "single"; issue: Issue };

export const epicKey = (n: number) => `e:${n}`;
export const childKey = (parent: number, n: number) => `c:${parent}:${n}`;
const singleKey = (n: number) => `s:${n}`;

/**
 * Flatten the (already filtered, epics-first) issue list into list rows: each epic parent is
 * followed by its children (in epic order) while expanded, then every remaining issue that is
 * NOT a sub-issue follows as a single. Sub-issues live only inside their epic — `subIssues` is
 * the server's set (native sub-issues + open markdown epic members), so no child is listed twice.
 * An expanded epic whose record isn't loaded yet gets one non-selectable loading row.
 */
export function buildIssueRows(
  visible: readonly Issue[],
  epicParents: ReadonlySet<number>,
  subIssues: ReadonlySet<number>,
  expanded: ReadonlySet<number>,
  childrenOf: (parent: number) => readonly EpicChild[] | undefined,
): IssueListRow[] {
  const rows: IssueListRow[] = [];
  const singles: IssueListRow[] = [];
  for (const issue of visible) {
    if (!epicParents.has(issue.number)) {
      if (!subIssues.has(issue.number))
        singles.push({ kind: "single", key: singleKey(issue.number), issue });
      continue;
    }
    const open = expanded.has(issue.number);
    rows.push({ kind: "epic", key: epicKey(issue.number), issue, expanded: open });
    if (!open) continue;
    const children = childrenOf(issue.number);
    if (!children) {
      rows.push({ kind: "loading", key: `l:${issue.number}`, parent: issue.number });
      continue;
    }
    for (const child of [...children].sort((a, b) => a.order - b.order)) {
      rows.push({
        kind: "child",
        key: childKey(issue.number, child.number),
        parent: issue.number,
        child,
      });
    }
  }
  return [...rows, ...singles];
}

/**
 * An epic child's title without the prefix that only repeats its epic — `Stack-Angleichung
 * (#158): Foo` inside epic #158 reads `Foo` in the list, where the group header already names
 * the epic. Strips up to and including the first `(#<parent>):`; any other title (another
 * epic's number, no prefix, nothing left after the prefix) is returned unchanged.
 */
export function stripEpicPrefix(title: string, parent: number): string {
  const marker = `(#${parent}):`;
  const at = title.indexOf(marker);
  if (at === -1) return title;
  const rest = title.slice(at + marker.length).trim();
  return rest === "" ? title : rest;
}

/** Enter / Space on a focused list option (a click can focus a tabindex=-1 row) selects it —
 *  the keyboard twin of the row's click; ↑/↓ bubble on to the listbox. */
export function activate(e: KeyboardEvent, select: () => void): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  select();
}

/**
 * Move the list selection by `delta` rows (↑ = -1, ↓ = +1), skipping loading rows and clamping at
 * both ends. With no (or a vanished) current selection, ↓ lands on the first row and ↑ on the
 * last. Returns null only when there is nothing selectable.
 */
export function stepSelection(
  rows: readonly IssueListRow[],
  current: string | null,
  delta: number,
): string | null {
  const keys = rows.filter((r) => r.kind !== "loading").map((r) => r.key);
  if (keys.length === 0) return null;
  const at = current == null ? -1 : keys.indexOf(current);
  if (at === -1) return delta < 0 ? keys[keys.length - 1] : keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, at + delta))];
}

/**
 * Resolve a selection key against the live data (not the rendered rows), so a selection
 * survives its epic collapsing. A child that is itself an epic parent resolves to that epic.
 * Returns null when the key no longer points at anything (issue closed, record gone).
 */
export function resolveSelection(
  key: string | null,
  issues: readonly Issue[],
  epicParents: ReadonlySet<number>,
  childrenOf: (parent: number) => readonly EpicChild[] | undefined,
): IssueSelection | null {
  if (key == null) return null;
  const [kind, a, b] = key.split(":");
  const byNumber = (n: number) => issues.find((i) => i.number === n);
  if (kind === "e" || kind === "s") {
    const issue = byNumber(Number(a));
    if (!issue) return null;
    // Classify by the CURRENT epic set, not the key's prefix: an entry picked while the epic
    // summaries were still loading was keyed as a single, and must not keep offering a manual
    // task once it turns out to be an epic parent.
    return epicParents.has(issue.number) ? { kind: "epic", issue } : { kind: "single", issue };
  }
  if (kind === "c") {
    const parent = Number(a);
    const child = childrenOf(parent)?.find((c) => c.number === Number(b));
    if (!child) return null;
    const asEpic = epicParents.has(child.number) ? byNumber(child.number) : undefined;
    return asEpic ? { kind: "epic", issue: asEpic } : { kind: "child", parent, child };
  }
  return null;
}

// ── Visible filters + list hints (#2639) ──────────────────────────────────────────────────

/** One active filter shown as a removable chip under the search field. */
export interface FilterChip {
  id: string;
  label: string;
  clear: () => void;
}

/** The default issue filter a chip can show and clear (the shared issueFilterSettings store). */
export interface ChipFilter {
  filter: IssueFilterSettings;
  update(patch: Partial<IssueFilterSettings>): void;
}

/**
 * Every filter that currently hides issues, as removable chips — including the default-on
 * rules, so hidden content is never invisible. The scope rule only counts when `mineOffered` (a
 * known viewer; otherwise it fails open and hides nothing), the fork rule only in a fork repo.
 * Sub-issues get no chip: the panel lists them inside their epic and offers no toggle for them.
 */
export function activeFilterChips(opts: {
  toggles: ChipFilter;
  mineOffered: boolean;
  isFork: boolean;
  author: string | null;
  labels: Iterable<string>;
  clearAuthor: () => void;
  clearLabel: (label: string) => void;
}): FilterChip[] {
  const { filter, update } = opts.toggles;
  const chips: FilterChip[] = [];
  if (filter.hideActive)
    chips.push({
      id: "active",
      label: m.issues_filter_chip_active(),
      clear: () => update({ hideActive: false }),
    });
  if (filter.hideBlocked)
    chips.push({
      id: "blocked",
      label: m.issues_filter_chip_blocked(),
      clear: () => update({ hideBlocked: false }),
    });
  if (opts.mineOffered && filter.scope !== "all")
    chips.push({
      id: "others",
      label:
        filter.scope === "mine" ? m.upnext_filter_chip_scope_mine() : m.issues_filter_chip_others(),
      clear: () => update({ scope: "all" }),
    });
  if (opts.isFork && filter.forks !== "all")
    chips.push({
      id: "forks",
      label:
        filter.forks === "hide"
          ? m.upnext_filter_chip_forks_hide()
          : m.upnext_filter_chip_forks_own(),
      clear: () => update({ forks: "all" }),
    });
  for (const label of filter.hiddenLabels)
    chips.push({
      id: `hidden:${label}`,
      label: m.upnext_filter_chip_label({ label }),
      clear: () =>
        update({
          hiddenLabels: filter.hiddenLabels.filter((l) => l.toLowerCase() !== label.toLowerCase()),
        }),
    });
  if (opts.author != null)
    chips.push({
      id: "author",
      label: m.issues_filter_chip_author({ name: opts.author }),
      clear: opts.clearAuthor,
    });
  for (const label of opts.labels)
    chips.push({ id: `label:${label}`, label, clear: () => opts.clearLabel(label) });
  return chips;
}

/**
 * "{shown} of {total}" for the list: `total` counts the fetched open top-level issues (epic
 * parents + singles, i.e. not sub-issues) before any filter or search; `shown` counts the epic
 * and single rows the list renders. Null when nothing is hidden.
 */
export function shownOfTotal(
  rows: readonly IssueListRow[],
  issues: readonly Issue[],
  epicParents: ReadonlySet<number>,
  subIssues: ReadonlySet<number>,
): { shown: number; total: number } | null {
  const total = issues.filter((i) => epicParents.has(i.number) || !subIssues.has(i.number)).length;
  const shown = rows.filter((r) => r.kind === "epic" || r.kind === "single").length;
  return shown < total ? { shown, total } : null;
}

/** The list's keyboard hint line: only the keys that do something right now. */
export function shortcutHints(opts: { hasEpics: boolean; selected: boolean }): string {
  return [
    m.issuespanel_hint_select(),
    ...(opts.hasEpics ? [m.issuespanel_hint_expand()] : []),
    m.issuespanel_hint_start(),
    ...(opts.selected ? [m.issuespanel_hint_esc()] : []),
  ].join(" · ");
}
