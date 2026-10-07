import type { RepoFingerprint } from "./forge/github-fingerprint";
import { issuesFreshness } from "./forge/repo-freshness";
import type { EpicStructure, Issue, LinkedPr, OpenPrSnapshot, RepoCounts } from "./forge/types";

/** The combined sub-issue and blocker scan (#2808). */
export interface IssueRelations {
  summaries: Map<number, { total: number; completed: number }>;
  subIssueNumbers: Set<number>;
  childrenByParent: Map<number, number[]>;
  blockedByOpen: Map<number, number[]>;
}

interface CacheValues {
  fingerprint: RepoFingerprint;
  issues: Issue[];
  counts: RepoCounts;
  prs: OpenPrSnapshot;
  links: Map<number, LinkedPr[]>;
  relations: IssueRelations;
  epic: EpicStructure;
  viewer: string;
  /** The session_git_cache row was actually read under this content key. */
  session: string;
  /** First transient observation is `at`; unrelated PR reads/writes must not renew it. */
  transient: { number?: number; headSha?: string };
}
export type GithubCacheKind = keyof CacheValues;
export interface GithubCacheRow {
  slug: string;
  kind: GithubCacheKind;
  entryKey: string;
  version: number;
  contentKey: string | null;
  fetchedAt: number;
  dataJson: string;
}
export interface GithubCacheStore {
  listGithubReadCache(): GithubCacheRow[];
  putGithubReadCache(row: GithubCacheRow): void;
  deleteGithubReadCache(slug: string, kind: GithubCacheKind, entryKey?: string): void;
}
export interface GithubCacheEntry<T> {
  at: number;
  contentKey: string | null;
  value: T;
}

const VERSION = 1;
const GITHUB_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
export const issuesKey = (f: RepoFingerprint) => `${f.openIssues}|${f.issuesUpdatedAt}`;
export const countsKey = (f: RepoFingerprint) =>
  `${f.openIssues}|${f.openPrs}|${f.prsUpdatedAt}|${f.ciState}`;
const prsKey = (f: RepoFingerprint) => `${f.openPrs}|${f.prsUpdatedAt}`;
const key = (kind: string, slug: string, entryKey: string) =>
  JSON.stringify([kind, slug, entryKey]);

/** Shared read data for every adapter of the same GitHub slug. Disk rows carry content keys;
 * revisions are process-local guards against a read racing an own write. */
export class GithubReadCache {
  private readonly entries = new Map<string, GithubCacheEntry<unknown>>();
  private readonly revisions = new Map<string, number>();
  readonly now: () => number;
  readonly canRefresh: () => boolean;

  constructor(
    private readonly store: GithubCacheStore,
    opts: { now?: () => number; canRefresh?: () => boolean } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.canRefresh = opts.canRefresh ?? (() => true);
    for (const row of store.listGithubReadCache()) {
      try {
        if (row.version !== VERSION) throw new Error("incompatible GitHub cache version");
        const value = decode(row.kind, row.dataJson);
        this.entries.set(key(row.kind, row.slug, row.entryKey), {
          at: row.fetchedAt,
          contentKey: row.contentKey,
          value,
        });
      } catch {
        store.deleteGithubReadCache(row.slug, row.kind, row.entryKey);
      }
    }
  }

  get<K extends GithubCacheKind>(
    kind: K,
    slug: string,
    entryKey = "",
  ): GithubCacheEntry<CacheValues[K]> | null {
    return (
      (this.entries.get(key(kind, slug, entryKey)) as GithubCacheEntry<CacheValues[K]>) ?? null
    );
  }

  put<K extends GithubCacheKind>(
    kind: K,
    slug: string,
    contentKey: string | null,
    value: CacheValues[K],
    entryKey = "",
    at = this.now(),
  ): void {
    this.store.putGithubReadCache({
      slug,
      kind,
      entryKey,
      version: VERSION,
      contentKey,
      fetchedAt: at,
      dataJson: encode(kind, value),
    });
    this.entries.set(key(kind, slug, entryKey), { at, contentKey, value });
  }

  fingerprints(): Array<{ slug: string; fp: RepoFingerprint; observedAt: number }> {
    const rows: Array<{ slug: string; fp: RepoFingerprint; observedAt: number }> = [];
    for (const [k, entry] of this.entries) {
      const [kind, slug] = JSON.parse(k) as [string, string];
      if (kind === "fingerprint")
        rows.push({ slug, fp: entry.value as RepoFingerprint, observedAt: entry.at });
    }
    return rows;
  }

  contentKey(kind: "issues" | "counts" | "prs", slug: string): string | null {
    const fp = this.get("fingerprint", slug)?.value;
    if (fp && issuesFreshness(slug, issuesKey(fp)) === null) return null;
    return fp
      ? kind === "issues"
        ? issuesKey(fp)
        : kind === "counts"
          ? countsKey(fp)
          : prsKey(fp)
      : null;
  }

  expired(entry: GithubCacheEntry<unknown>): boolean {
    return this.now() - entry.at >= GITHUB_CACHE_MAX_AGE_MS;
  }

  revision(slug: string): number {
    return this.revisions.get(slug) ?? 0;
  }

  delete(kind: GithubCacheKind, slug: string, entryKey: string): void {
    this.store.deleteGithubReadCache(slug, kind, entryKey);
    this.entries.delete(key(kind, slug, entryKey));
  }

  invalidate(slug: string, kinds: GithubCacheKind[]): void {
    for (const kind of kinds) {
      this.store.deleteGithubReadCache(slug, kind);
      for (const k of this.entries.keys()) {
        const [storedKind, storedSlug] = JSON.parse(k) as [string, string];
        if (storedKind === kind && storedSlug === slug) this.entries.delete(k);
      }
    }
    this.revisions.set(slug, this.revision(slug) + 1);
  }
}

/** Only cache-owned Maps/Sets are encoded; issue bodies and other GitHub data stay plain JSON. */
function encode<K extends GithubCacheKind>(kind: K, value: CacheValues[K]): string {
  if (kind === "prs") {
    const v = value as OpenPrSnapshot;
    return JSON.stringify({ ...v, statuses: [...v.statuses] });
  }
  if (kind === "relations") {
    const v = value as IssueRelations;
    return JSON.stringify({
      summaries: [...v.summaries],
      subIssueNumbers: [...v.subIssueNumbers],
      childrenByParent: [...v.childrenByParent],
      blockedByOpen: [...v.blockedByOpen],
    });
  }
  if (kind === "epic") {
    const v = value as EpicStructure;
    return JSON.stringify({ ...v, blockedBy: [...v.blockedBy] });
  }
  if (kind === "links") return JSON.stringify([...(value as Map<number, LinkedPr[]>)]);
  return JSON.stringify(value);
}

type ValueCheck = (value: unknown) => boolean;
const string: ValueCheck = (v) => typeof v === "string";
const nonempty: ValueCheck = (v) => typeof v === "string" && v.length > 0;
const number: ValueCheck = (v) => typeof v === "number" && Number.isFinite(v);
const boolean: ValueCheck = (v) => typeof v === "boolean";
const array =
  (check: ValueCheck): ValueCheck =>
  (v) =>
    Array.isArray(v) && v.every(check);
const nullable =
  (check: ValueCheck): ValueCheck =>
  (v) =>
    v === null || check(v);
const oneOf =
  (...values: string[]): ValueCheck =>
  (v) =>
    typeof v === "string" && values.includes(v);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const record =
  (check: ValueCheck): ValueCheck =>
  (v) =>
    object(v) && Object.values(v).every(check);
const map = (key: ValueCheck, value: ValueCheck): ValueCheck =>
  array((v) => Array.isArray(v) && v.length === 2 && key(v[0]) && value(v[1]));
function shape(
  required: Record<string, ValueCheck>,
  optional: Record<string, ValueCheck> = {},
): ValueCheck {
  return (v) =>
    object(v) &&
    Object.entries(required).every(([k, check]) => check(v[k])) &&
    Object.entries(optional).every(([k, check]) => v[k] === undefined || check(v[k]));
}
const reviewState = oneOf("approved", "changes_requested", "commented");
const checks = oneOf("none", "pending", "success", "failure");
const review = shape({ state: reviewState, author: string, submittedAt: number });
const mergeState = oneOf(
  "behind",
  "blocked",
  "clean",
  "dirty",
  "draft",
  "has_hooks",
  "unknown",
  "unstable",
);
const issue = shape(
  {
    number,
    title: string,
    body: string,
    url: string,
    labels: array(string),
    createdAt: number,
    assignees: array(string),
  },
  {
    updatedAt: number,
    author: string,
    authorAssociation: string,
    labelColors: record(string),
    blockedBy: array(number),
    closed: boolean,
  },
);
const job = shape(
  { name: string, state: checks },
  { url: string, isDeploy: boolean, startedAt: number, completedAt: number },
);
const prOptional = {
  number,
  url: string,
  title: string,
  createdAt: number,
  mergeable: nullable(boolean),
  runningChecks: array(string),
  headSha: string,
  latestReview: review,
  reviewerStates: record(shape({ state: reviewState, latestAt: nullable(number) })),
  requestedReviewers: array(string),
  authorLogin: string,
  isFork: boolean,
  isDraft: boolean,
  mergeStateStatus: mergeState,
  baseRefName: string,
  awaitingWorkflowApproval: boolean,
};
const prStatus = shape(
  { state: oneOf("none", "open", "merged", "closed"), checks, deployConfigured: boolean },
  { ...prOptional, jobs: array(job) },
);
const pull = shape(
  {
    number,
    title: string,
    url: string,
    author: string,
    kind: oneOf("regular", "release", "dependabot"),
    createdAt: number,
    isDraft: boolean,
    mergeable: nullable(boolean),
    checks,
    jobs: array(job),
  },
  {
    ...prOptional,
    nonDefaultBase: string,
    headRefName: string,
    mergeMethod: oneOf("merge", "squash", "rebase"),
  },
);
const validators: Record<GithubCacheKind, ValueCheck> = {
  fingerprint: shape({
    openIssues: number,
    issuesUpdatedAt: string,
    openPrs: number,
    prsUpdatedAt: string,
    ciState: string,
  }),
  issues: array(issue),
  counts: shape({
    openIssues: nullable(number),
    openPRs: nullable(number),
    ciStatus: nullable(oneOf("success", "failure", "pending")),
    prKinds: nullable(shape({ release: number, dependabot: number, regular: number })),
  }),
  prs: shape(
    { prs: array(pull), statuses: map(string, prStatus), capped: boolean },
    { source: oneOf("graphql", "rest") },
  ),
  links: map(number, array(shape({ prNumber: number, author: string }))),
  relations: shape({
    summaries: map(number, shape({ total: number, completed: number })),
    subIssueNumbers: array(number),
    childrenByParent: map(number, array(number)),
    blockedByOpen: map(number, array(number)),
  }),
  epic: shape({
    parent: nullable(issue),
    subIssues: array(
      shape({
        number,
        title: string,
        url: string,
        body: string,
        closed: boolean,
        labels: array(string),
      }),
    ),
    blockedBy: map(number, array(number)),
  }),
  viewer: nonempty,
  session: nonempty,
  transient: shape({}, { number, headSha: string }),
};

function decode(kind: GithubCacheKind, json: string): unknown {
  const v = JSON.parse(json);
  if (!Object.hasOwn(validators, kind) || !validators[kind](v))
    throw new Error("invalid GitHub cache data");
  switch (kind) {
    case "prs":
      return { ...v, statuses: new Map(v.statuses) };
    case "relations":
      return {
        summaries: new Map(v.summaries),
        subIssueNumbers: new Set(v.subIssueNumbers),
        childrenByParent: new Map(v.childrenByParent),
        blockedByOpen: new Map(v.blockedByOpen),
      };
    case "epic":
      return { ...v, blockedBy: new Map(v.blockedBy) };
    case "links":
      return new Map(v);
    default:
      return v;
  }
}
