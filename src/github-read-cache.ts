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
export const GITHUB_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
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

function decode(kind: GithubCacheKind, json: string): unknown {
  const v = JSON.parse(json);
  switch (kind) {
    case "prs":
      if (!Array.isArray(v?.prs) || !Array.isArray(v?.statuses) || typeof v?.capped !== "boolean")
        throw new Error("invalid PR snapshot");
      return { ...v, statuses: new Map(v.statuses) };
    case "relations":
      if (
        ![v?.summaries, v?.subIssueNumbers, v?.childrenByParent, v?.blockedByOpen].every(
          Array.isArray,
        )
      )
        throw new Error("invalid issue relations");
      return {
        summaries: new Map(v.summaries),
        subIssueNumbers: new Set(v.subIssueNumbers),
        childrenByParent: new Map(v.childrenByParent),
        blockedByOpen: new Map(v.blockedByOpen),
      };
    case "epic":
      if (!Array.isArray(v?.subIssues) || !Array.isArray(v?.blockedBy) || !("parent" in v))
        throw new Error("invalid epic structure");
      return { ...v, blockedBy: new Map(v.blockedBy) };
    case "links":
      if (!Array.isArray(v)) throw new Error("invalid PR links");
      return new Map(v);
    case "fingerprint":
      if (
        typeof v?.openIssues !== "number" ||
        typeof v?.issuesUpdatedAt !== "string" ||
        typeof v?.openPrs !== "number" ||
        typeof v?.prsUpdatedAt !== "string" ||
        typeof v?.ciState !== "string"
      )
        throw new Error("invalid fingerprint");
      return v;
    case "issues":
      if (!Array.isArray(v)) throw new Error("invalid issue list");
      return v;
    case "counts":
      if (!v || typeof v !== "object") throw new Error("invalid counts");
      return v;
    case "viewer":
      if (typeof v !== "string" || !v) throw new Error("invalid viewer");
      return v;
    case "session":
      if (typeof v !== "string" || !v) throw new Error("invalid session cache key");
      return v;
    default:
      throw new Error("unknown GitHub cache kind");
  }
}
