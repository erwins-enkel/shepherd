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
  /** Single-flight: slug → raw in-flight Promise (resolves with value or rejects). */
  private readonly inflight = new Map<string, Promise<OpenPrSnapshot>>();
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
    let raw = this.inflight.get(slug);
    if (!raw) {
      // Shared raw fetch: writes to cache on success, clears inflight on
      // both branches, and re-throws on failure so each caller can apply
      // its OWN preserve-on-error policy below.
      raw = this.gate
        .run(() => forge.listOpenPrSnapshot!())
        .then(
          (v) => {
            this.cache.set(slug, { at: this.now(), value: v });
            this.inflight.delete(slug);
            return v;
          },
          (err) => {
            this.inflight.delete(slug);
            throw err;
          },
        );
      this.inflight.set(slug, raw);
      // Suppress the unhandled-rejection warning on the shared raw promise;
      // each caller's derived chain below provides the actual handler.
      raw.catch(() => {});
    }

    // Each caller chains its own error policy independently of any other
    // concurrent caller that may have started (or joined) the same fetch.
    return raw.then(
      (v) => v,
      () => {
        const prev = this.cache.get(slug);
        return preserveOnError && prev ? prev.value : null;
      },
    );
  }
}
