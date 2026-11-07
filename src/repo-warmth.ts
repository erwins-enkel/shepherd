import { AsyncLocalStorage } from "node:async_hooks";

/** Default warm window in days (#2837). */
export const WARM_REPO_DAYS_DEFAULT = 3;
const WARM_REPO_DAYS_MIN = 0;
const WARM_REPO_DAYS_MAX = 30;
export const WARM_REPO_DAYS_SETTING = "warmRepoDays";

/** Snap a raw value into the window's range; non-numbers fall back to `fallback`. */
export function clampWarmRepoDays(value: unknown, fallback = WARM_REPO_DAYS_DEFAULT): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(WARM_REPO_DAYS_MAX, Math.max(WARM_REPO_DAYS_MIN, Math.round(n)));
}

const DAY_MS = 86_400_000;
const MEMO_MS = 15_000;

export interface RepoWarmthDeps {
  /** Warm window in days; 0 turns gating off (every repo is warm). */
  windowDays: () => number;
  /** Tracked repos: raw `listRepos` path and its realpath. */
  listRepos: () => Array<{ path: string; realPath?: string }>;
  /** The repo's GitHub slug, or null for any other forge. */
  slugOf: (path: string) => string | null;
  /** Canonical (realpath) form of a path — the store's key space. */
  canonical: (path: string) => string;
  lastActivityByRepo: () => Record<string, number>;
  repoOpenedSince: (since: number) => Set<string>;
  markRepoOpened: (path: string, at: number) => void;
  /** Repos with auto-drain or the all-PR critic on. */
  automationRepos: () => Iterable<string>;
  /** Repos whose epic run is running or paused. */
  activeEpicRepos: () => Iterable<string>;
  /** Repos with a completed-epic row (landing PR upkeep). */
  epicCompletedRepos: () => Iterable<string>;
  /** Repos of non-archived sessions holding an open PR. */
  openPrRepos: () => Iterable<string>;
  now?: () => number;
}

interface WarmSet {
  at: number;
  paths: Set<string>;
  slugs: Set<string>;
}

const liveScope = new AsyncLocalStorage<boolean>();

/** Run `fn` with cold repos read live (the manual Up Next refresh). */
export function liveColdRead<T>(fn: () => Promise<T>): Promise<T> {
  return liveScope.run(true, fn);
}

/** True inside {@link liveColdRead}. */
export function inLiveColdRead(): boolean {
  return liveScope.getStore() === true;
}

/**
 * The warm repo set (#2837): the only repos background loops read from GitHub. A repo is warm
 * while it had session activity or an operator open inside the window, or while an open PR,
 * auto-drain, the all-PR critic, a running/paused epic or a completed epic keeps it warm.
 * Membership is per path (raw or realpath) and per GitHub slug: a slug is warm when any of its
 * local paths is.
 */
export class RepoWarmthService {
  private memo: WarmSet | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RepoWarmthDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Gating is off (window 0): every repo is warm. */
  gatingOff(): boolean {
    return this.deps.windowDays() <= 0;
  }

  isWarmPath(path: string): boolean {
    if (this.gatingOff()) return true;
    const set = this.compute();
    if (set.paths.has(path) || set.paths.has(this.canonical(path))) return true;
    const slug = this.deps.slugOf(path);
    return slug !== null && set.slugs.has(slug);
  }

  isWarmSlug(slug: string): boolean {
    return this.gatingOff() || this.compute().slugs.has(slug);
  }

  /** The operator opened `path`. Returns true when that promoted a cold repo. */
  touch(path: string): boolean {
    const wasWarm = this.isWarmPath(path);
    this.deps.markRepoOpened(this.canonical(path), this.now());
    this.memo = null;
    return !wasWarm;
  }

  private canonical(path: string): string {
    try {
      return this.deps.canonical(path);
    } catch {
      return path;
    }
  }

  private compute(): WarmSet {
    const now = this.now();
    if (this.memo && now - this.memo.at < MEMO_MS) return this.memo;
    const keys = this.warmKeys(now - this.deps.windowDays() * DAY_MS);
    const paths = new Set(keys);
    const slugs = new Set<string>();
    for (const r of this.deps.listRepos()) {
      const hit = keys.has(r.path) || (r.realPath !== undefined && keys.has(r.realPath));
      if (!hit) continue;
      paths.add(r.path);
      if (r.realPath) paths.add(r.realPath);
      const slug = this.deps.slugOf(r.path);
      if (slug) slugs.add(slug);
    }
    this.memo = { at: now, paths, slugs };
    return this.memo;
  }

  /** Store-space paths warm for any reason, activity at or after `since` included. */
  private warmKeys(since: number): Set<string> {
    const keys = new Set<string>();
    for (const [path, t] of Object.entries(this.deps.lastActivityByRepo()))
      if (t >= since) keys.add(path);
    const keepers = [
      this.deps.repoOpenedSince(since),
      this.deps.automationRepos(),
      this.deps.activeEpicRepos(),
      this.deps.epicCompletedRepos(),
      this.deps.openPrRepos(),
    ];
    for (const source of keepers) for (const p of source) keys.add(p);
    return keys;
  }
}
