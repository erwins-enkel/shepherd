/**
 * Default issue filter (#3007/#3017): the operator's persisted "which issues do I see" setting and
 * its pure predicate. NO I/O. Up Next applies it server-side (src/up-next-core.ts) so every client
 * shows the same queue and counts.
 *
 * The rules — mirrored by the web Backlog (ui/src/lib/components/issues-panel.ts, slice 3) and the
 * Swift client (slice 5); keep them in sync:
 *   - mine(issue, viewer): viewer != null AND (assignees includes viewer OR author === viewer).
 *     Epic units use the PARENT's assignees, author and labels.
 *   - viewer == null fails open: scope and `forks: own` hide nothing in that repo (as #824 did).
 *   - scope: `all` keeps everything; `mine_unassigned` keeps mine or unassigned; `mine` keeps mine.
 *   - forks (repo is a fork when forge.isFork): `all` keeps everything; `own` keeps only mine in a
 *     fork repo; `hide` drops the fork repo entirely.
 *   - hiddenLabels: case-insensitive intersection with the item's labels drops it.
 *   - repoOverrides (#3020): a per-repo value REPLACES scope and forks for that repo — `all` keeps
 *     everything (upstream included), `mine_unassigned`/`mine` act as that scope, `hide` drops the
 *     repo. Keys are realpath repo paths (like repo_config); an absent key = the global rules.
 *   - A hidden item is attributed to the FIRST rule that drops it: repo override (or scope → forks)
 *     → labels.
 * hideActive / hideSubIssues / hideBlocked apply to Backlog/New Task only; Up Next always hides
 * active, sub-issue and blocked work.
 */

export const ISSUE_FILTER_SETTING = "issueFilter";

export const ISSUE_FILTER_SCOPES = ["all", "mine_unassigned", "mine"] as const;
export const ISSUE_FILTER_FORKS = ["all", "own", "hide"] as const;
export type IssueFilterScope = (typeof ISSUE_FILTER_SCOPES)[number];
export type IssueFilterForks = (typeof ISSUE_FILTER_FORKS)[number];
const ISSUE_FILTER_REPO_OVERRIDES = ["all", "mine_unassigned", "mine", "hide"] as const;
export type IssueFilterRepoOverride = (typeof ISSUE_FILTER_REPO_OVERRIDES)[number];
export type IssueFilterRule = "scope" | "forks" | "labels" | "repo";

export interface IssueFilterSettings {
  scope: IssueFilterScope;
  forks: IssueFilterForks;
  hiddenLabels: string[];
  hideActive: boolean;
  hideSubIssues: boolean;
  hideBlocked: boolean;
  /** repoPath (realpath) → override; an absent repo follows scope/forks. */
  repoOverrides: Record<string, IssueFilterRepoOverride>;
}

/** Reproduces the pre-#3007 behavior (#824's "mine & unassigned", nothing else hidden). */
export const DEFAULT_ISSUE_FILTER: IssueFilterSettings = {
  scope: "mine_unassigned",
  forks: "all",
  hiddenLabels: [],
  hideActive: false,
  hideSubIssues: true,
  hideBlocked: true,
  repoOverrides: {},
};

const ISSUE_FILTER_MAX_LABELS = 50;
const ISSUE_FILTER_MAX_OVERRIDES = 500;
const ISSUE_FILTER_MAX_KEY_LENGTH = 4096;

/** The issue facts the predicate reads (the parent's, for an epic unit). */
export interface IssueFilterSubject {
  assignees: string[];
  author?: string;
  labels: string[];
}

export interface IssueFilterContext {
  /** The operator's login on the repo's forge; null = unknown (fails open). */
  viewer: string | null;
  isFork: boolean;
  /** This repo's override, when it has one. */
  override?: IssueFilterRepoOverride;
}

export function isMine(subject: IssueFilterSubject, viewer: string | null): boolean {
  if (viewer == null) return false;
  return subject.assignees.includes(viewer) || subject.author === viewer;
}

function scopeHides(
  subject: IssueFilterSubject,
  viewer: string | null,
  scope: IssueFilterScope,
): boolean {
  if (scope === "all" || viewer == null) return false;
  if (isMine(subject, viewer)) return false;
  return scope === "mine" || subject.assignees.length > 0;
}

function forksHides(
  subject: IssueFilterSubject,
  ctx: IssueFilterContext,
  forks: IssueFilterForks,
): boolean {
  if (!ctx.isFork || forks === "all") return false;
  if (forks === "hide") return true;
  return ctx.viewer != null && !isMine(subject, ctx.viewer);
}

function labelsHide(subject: IssueFilterSubject, hiddenLabels: string[]): boolean {
  if (hiddenLabels.length === 0) return false;
  const hidden = new Set(hiddenLabels.map((l) => l.toLowerCase()));
  return subject.labels.some((l) => hidden.has(l.toLowerCase()));
}

function overrideHides(
  subject: IssueFilterSubject,
  viewer: string | null,
  override: IssueFilterRepoOverride,
): boolean {
  if (override === "hide") return true;
  return scopeHides(subject, viewer, override);
}

/** The first rule (repo override, else scope → forks; then labels) that hides the subject, or
 *  null when it stays visible. */
export function hiddenByRule(
  subject: IssueFilterSubject,
  ctx: IssueFilterContext,
  filter: Pick<IssueFilterSettings, "scope" | "forks" | "hiddenLabels">,
): IssueFilterRule | null {
  if (ctx.override) {
    if (overrideHides(subject, ctx.viewer, ctx.override)) return "repo";
  } else {
    if (scopeHides(subject, ctx.viewer, filter.scope)) return "scope";
    if (forksHides(subject, ctx, filter.forks)) return "forks";
  }
  if (labelsHide(subject, filter.hiddenLabels)) return "labels";
  return null;
}

type ParseResult = { ok: true; value: IssueFilterSettings } | { ok: false; error: string };
type FieldParser = (raw: unknown) => { ok: true; value: unknown } | { ok: false; error: string };

function enumField(field: string, allowed: readonly string[]): FieldParser {
  return (raw) =>
    typeof raw === "string" && allowed.includes(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `issueFilter.${field} must be one of ${allowed.join(", ")}` };
}

function boolField(field: string): FieldParser {
  return (raw) =>
    typeof raw === "boolean"
      ? { ok: true, value: raw }
      : { ok: false, error: `issueFilter.${field} must be a boolean` };
}

/** Trim, drop blanks, de-duplicate case-insensitively (first spelling wins), cap at 50. */
function parseLabels(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.some((l) => typeof l !== "string")) {
    return { ok: false, error: "issueFilter.hiddenLabels must be an array of strings" };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw as string[]) {
    const label = item.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return { ok: true, value: out.slice(0, ISSUE_FILTER_MAX_LABELS) };
}

/** A repo → override map. Unknown repo keys are kept (a repo can vanish and come back); unknown
 *  values are refused. The patch value replaces the whole map. */
function parseRepoOverrides(
  raw: unknown,
): { ok: true; value: Record<string, IssueFilterRepoOverride> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "issueFilter.repoOverrides must be an object" };
  }
  const entries = Object.entries(raw);
  if (entries.length > ISSUE_FILTER_MAX_OVERRIDES) {
    return {
      ok: false,
      error: `issueFilter.repoOverrides allows at most ${ISSUE_FILTER_MAX_OVERRIDES} repos`,
    };
  }
  const out: [string, IssueFilterRepoOverride][] = [];
  for (const [key, value] of entries) {
    if (!key || key.length > ISSUE_FILTER_MAX_KEY_LENGTH) {
      return { ok: false, error: "issueFilter.repoOverrides has an invalid repo key" };
    }
    if (
      typeof value !== "string" ||
      !(ISSUE_FILTER_REPO_OVERRIDES as readonly string[]).includes(value)
    ) {
      return {
        ok: false,
        error: `issueFilter.repoOverrides values must be one of ${ISSUE_FILTER_REPO_OVERRIDES.join(", ")}`,
      };
    }
    out.push([key, value as IssueFilterRepoOverride]);
  }
  // fromEntries defines own properties, so a `__proto__` key stays plain data.
  return { ok: true, value: Object.fromEntries(out) };
}

const FIELD_PARSERS: Record<keyof IssueFilterSettings, FieldParser> = {
  scope: enumField("scope", ISSUE_FILTER_SCOPES),
  forks: enumField("forks", ISSUE_FILTER_FORKS),
  hiddenLabels: parseLabels,
  hideActive: boolField("hideActive"),
  hideSubIssues: boolField("hideSubIssues"),
  hideBlocked: boolField("hideBlocked"),
  repoOverrides: parseRepoOverrides,
};

/** Validate a partial patch and merge it onto `current`. Unknown keys and bad values are refused. */
export function parseIssueFilterPatch(raw: unknown, current: IssueFilterSettings): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "issueFilter must be an object" };
  }
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(FIELD_PARSERS, key)) {
      return { ok: false, error: `issueFilter.${key} is not a known field` };
    }
    const parsed = FIELD_PARSERS[key as keyof IssueFilterSettings](value);
    if (!parsed.ok) return parsed;
    next[key] = parsed.value;
  }
  return { ok: true, value: next as unknown as IssueFilterSettings };
}

function defaults(): IssueFilterSettings {
  return structuredClone(DEFAULT_ISSUE_FILTER);
}

/** The persisted setting merged onto the defaults, or the defaults when unset or unreadable. */
export function storedIssueFilter(stored: string | null | undefined): IssueFilterSettings {
  if (!stored) return defaults();
  try {
    const parsed = parseIssueFilterPatch(JSON.parse(stored), defaults());
    if (parsed.ok) return parsed.value;
  } catch {
    // corrupt row → default below
  }
  return defaults();
}
