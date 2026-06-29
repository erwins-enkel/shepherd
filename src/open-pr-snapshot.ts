import type { GitForge, OpenPrSnapshot } from "./forge/types";
import { Semaphore } from "./semaphore";

/** Matches the pr-poller's full-sweep cadence so a poller-warmed entry is reused
 *  by the PRs tab across a whole interval without re-fetching. */
export const SNAPSHOT_TTL_MS = 120_000;

interface CacheEntry {
  at: number;
  value: OpenPrSnapshot;
}

/**
 * Per-repo open-PR snapshot cache. Keyed by `forge.slug` (NOT repoPath) so
 * two worktrees of the same remote repo share one cached fetch. Two consumers
 * — the pr-poller batch and GET /api/prs — share a single `gh pr list` call
 * per TTL window.
 */
export class OpenPrSnapshotService {
  /** TTL read-through cache: slug → {at, value}. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight: slug → in-flight Promise. */
  private readonly inflight = new Map<string, Promise<OpenPrSnapshot | null>>();
  /** Bounds simultaneous fetches. */
  private readonly gate: Semaphore;

  constructor(
    private readonly now: () => number = Date.now,
    maxConcurrency = 6,
  ) {
    this.gate = new Semaphore(maxConcurrency);
  }

  /**
   * Read-through: returns a cached entry fresher than SNAPSHOT_TTL_MS, else
   * fetches (single-flight). Returns null when the forge can't supply a
   * snapshot (null slug or no listOpenPrSnapshot method).
   */
  async get(forge: GitForge): Promise<OpenPrSnapshot | null> {
    if (!this.isCapable(forge)) return null;
    const slug = forge.slug!;
    const entry = this.cache.get(slug);
    if (entry && this.now() - entry.at < SNAPSHOT_TTL_MS) return entry.value;
    return this.load(slug, forge, false);
  }

  /**
   * Force a fetch regardless of TTL (still single-flight-deduped). On error
   * keeps the last-known-good value when one exists (preserve-on-error);
   * otherwise resolves to null. Returns null for incapable forges.
   */
  async refresh(forge: GitForge): Promise<OpenPrSnapshot | null> {
    if (!this.isCapable(forge)) return null;
    return this.load(forge.slug!, forge, true);
  }

  /**
   * Synchronous cache-only peek — last cached value for forge.slug regardless
   * of TTL freshness, or null. Never fetches.
   */
  peek(forge: GitForge): OpenPrSnapshot | null {
    if (!this.isCapable(forge)) return null;
    return this.cache.get(forge.slug!)?.value ?? null;
  }

  /** True when the forge can supply a snapshot (non-null slug + method present). */
  private isCapable(forge: GitForge): boolean {
    return forge.slug != null && forge.listOpenPrSnapshot !== undefined;
  }

  private load(
    slug: string,
    forge: GitForge,
    preserveOnError: boolean,
  ): Promise<OpenPrSnapshot | null> {
    const existing = this.inflight.get(slug);
    if (existing) return existing;

    const promise = this.gate
      .run(() => forge.listOpenPrSnapshot!())
      .then(
        (v) => {
          this.cache.set(slug, { at: this.now(), value: v });
          this.inflight.delete(slug);
          return v;
        },
        () => {
          this.inflight.delete(slug);
          const prev = this.cache.get(slug);
          if (preserveOnError && prev) return prev.value;
          return null;
        },
      );
    this.inflight.set(slug, promise);
    return promise;
  }
}
