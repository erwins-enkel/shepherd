import type { GitForge, OpenPrSnapshot, PrStatus, PullRequest } from "./forge/types";
import { currentGhCaller } from "./forge/gh-caller";
import { graphRateLimit } from "./forge/rate-limit";
import { Semaphore } from "./semaphore";
import type { GithubCacheEntry, GithubReadCache } from "./github-read-cache";

/** Matches the pr-poller's full-sweep cadence so a poller-warmed entry is reused
 *  by the PRs tab across a whole interval without re-fetching. */
export const SNAPSHOT_TTL_MS = 120_000;

/** Delays of the re-reads that settle PRs GitHub still computes mergeability for, by attempt —
 *  so at most this many per PR head and prs content key. */
export const SETTLE_DELAYS_MS = [5_000, 30_000];

type CacheEntry = GithubCacheEntry<OpenPrSnapshot>;
type Schedule = (fn: () => void, ms: number) => void;

const defaultSchedule: Schedule = (fn, ms) => {
  setTimeout(fn, ms).unref?.();
};

/** An open PR whose checks, mergeability or merge state can still move without bumping its
 *  `updatedAt` — so a snapshot holding it can be stale under an unchanged fingerprint (#2799). */
function isTransientPrStatus(st: PrStatus): boolean {
  return (
    st.state === "open" &&
    (st.checks === "pending" ||
      (st.runningChecks?.length ?? 0) > 0 ||
      st.mergeable == null ||
      st.mergeStateStatus === "unknown" ||
      st.mergeStateStatus === "unstable")
  );
}

/**
 * Per-repo open-PR snapshot cache. Keyed by `forge.slug` (NOT repoPath) so
 * two worktrees of the same remote repo share one cached fetch. Two consumers
 * — the pr-poller batch and GET /api/prs — share a single `gh pr list` call
 * until its PR fingerprint changes (or per TTL window without fingerprint coverage).
 */
export class OpenPrSnapshotService {
  /** TTL read-through cache: slug → {at, value}. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight: slug → raw in-flight Promise (resolves with value or rejects). */
  private readonly inflight = new Map<string, Promise<OpenPrSnapshot>>();
  /** Bounds simultaneous fetches. */
  private readonly gate: Semaphore;
  private readonly revisions = new Map<string, number>();
  /** slug → `number:headSha` → when a snapshot first held that PR transient. */
  private readonly transientSeen = new Map<string, Map<string, number>>();
  /** slug → when a head read last disagreed with the cached snapshot ({@link noteHeadRead}). */
  private readonly staleAt = new Map<string, number>();
  /** slug → the prs content key its settle attempts count under, and `number:headSha` → attempts. */
  private readonly settleTries = new Map<
    string,
    { contentKey: string | null; tries: Map<string, number> }
  >();
  /** Slugs with a settle re-read scheduled. */
  private readonly settlePending = new Set<string>();
  private readonly listeners = new Set<(slug: string) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    maxConcurrency = 6,
    private readonly readCache?: GithubReadCache,
    private readonly schedule: Schedule = defaultSchedule,
  ) {
    this.gate = new Semaphore(maxConcurrency);
  }

  /**
   * Read-through: serves an unchanged PR fingerprint, else applies SNAPSHOT_TTL_MS without
   * coverage or fetches (single-flight). Returns null when the forge can't supply a
   * snapshot (null slug or no listOpenPrSnapshot method). A `background` read is served the
   * last snapshot, of any age or source, while GraphQL is limited: its REST refetch costs
   * a multiple of the GraphQL read (#2660). Operator-facing reads omit it.
   */
  async get(forge: GitForge, opts?: { background?: boolean }): Promise<OpenPrSnapshot | null> {
    if (!this.isCapable(forge)) return null;
    const slug = forge.slug!;
    this.syncReadCache(slug);
    const entry = this.entry(forge);
    if (opts?.background && entry && graphRateLimit.blocked()) return entry.value;
    const fpKey = forge.kind === "github" ? this.readCache?.contentKey("prs", slug) : null;
    if (
      entry &&
      this.readCache &&
      forge.kind === "github" &&
      fpKey != null &&
      entry.contentKey === fpKey
    ) {
      if (this.readCache.expired(entry) && this.readCache.canRefresh())
        void this.load(slug, forge, true);
      return entry.value;
    }
    if (entry && fpKey == null && this.now() - entry.at < SNAPSHOT_TTL_MS) {
      if (!graphRateLimit.blocked() || entry.value.source === "rest") return entry.value;
    }
    return this.load(slug, forge, false);
  }

  /**
   * Force a fetch regardless of TTL (still single-flight-deduped). On error
   * keeps the last-known-good value when one exists (preserve-on-error);
   * otherwise resolves to null. Returns null for incapable forges.
   */
  async refresh(forge: GitForge): Promise<OpenPrSnapshot | null> {
    if (!this.isCapable(forge)) return null;
    this.syncReadCache(forge.slug!);
    return this.load(forge.slug!, forge, true);
  }

  /**
   * Synchronous cache-only peek — last cached value for forge.slug, or null. Never fetches.
   * Without `maxAgeMs` any age is served; with it, an older entry reads as null.
   */
  peek(forge: GitForge, maxAgeMs?: number): OpenPrSnapshot | null {
    if (!this.isCapable(forge)) return null;
    const entry = this.entry(forge);
    if (!entry || (maxAgeMs !== undefined && this.now() - entry.at > maxAgeMs)) return null;
    return entry.value;
  }

  /**
   * Cache-only: the cached snapshot and when it was fetched, but only while {@link isCurrent}
   * holds for it (same PR fingerprint, or inside SNAPSHOT_TTL_MS without one). Never fetches.
   */
  peekCurrent(forge: GitForge): { at: number; value: OpenPrSnapshot } | null {
    if (!this.isCapable(forge)) return null;
    const entry = this.entry(forge);
    if (!entry || !this.isCurrent(forge, entry.value)) return null;
    return { at: entry.at, value: entry.value };
  }

  /** A preserved or superseded fetch must not certify session state under a newer key. */
  isCurrent(forge: GitForge, snapshot: OpenPrSnapshot): boolean {
    const entry = this.entry(forge);
    const fpKey = forge.kind === "github" ? this.readCache?.contentKey("prs", forge.slug!) : null;
    return (
      entry?.value === snapshot &&
      (fpKey != null ? entry.contentKey === fpKey : this.now() - entry.at < SNAPSHOT_TTL_MS)
    );
  }

  /**
   * Cache-only: true when the cached snapshot holds a transient PR ({@link isTransientPrStatus})
   * first seen transient less than `windowMs` ago. The window bounds the refetches a PR stuck
   * pending can cause; a new head restarts it.
   */
  hasTransient(forge: GitForge, windowMs: number): boolean {
    if (!this.isCapable(forge)) return false;
    const entry = this.entry(forge);
    if (!entry) return false;
    const prev = this.transientSeen.get(forge.slug!);
    const seen = new Map<string, number>();
    let live = false;
    for (const st of entry.value.statuses.values()) {
      if (!isTransientPrStatus(st)) continue;
      const id = `${st.number}:${st.headSha}`;
      const since = prev?.get(id) ?? entry.at;
      seen.set(id, since);
      if (this.now() - since < windowMs) live = true;
    }
    this.transientSeen.set(forge.slug!, seen);
    return live;
  }

  /**
   * Record a head read newer than the cached snapshot (the poller's targeted poll). When it
   * disagrees with the snapshot's entry for that head — state, head, checks or mergeability —
   * the snapshot is {@link isStale} until a fetch that started after the read lands, so a PR that
   * settled outside the transient window doesn't stay pending in the PRs tab.
   */
  noteHeadRead(forge: GitForge, head: string, st: PrStatus): void {
    if (!this.isCapable(forge)) return;
    const cached = this.entry(forge)?.value.statuses.get(head);
    if (
      cached &&
      (cached.state !== st.state ||
        cached.headSha !== st.headSha ||
        cached.checks !== st.checks ||
        cached.mergeable !== st.mergeable ||
        cached.mergeStateStatus !== st.mergeStateStatus)
    )
      this.staleAt.set(forge.slug!, this.now());
  }

  /** Subscribe to cache writes — a fetched snapshot or a {@link patchPr} — by slug. */
  onUpdate(listener: (slug: string) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Swap one PR's row in the cached snapshot for a newer read of it (`read` null: it is no longer
   * open, so it is dropped), keeping the snapshot's fetch time and content key. A PR the snapshot
   * doesn't hold stays out. No-op without a cached snapshot.
   */
  patchPr(
    forge: GitForge,
    number: number,
    read: { pr: PullRequest; status: PrStatus } | null,
  ): void {
    if (!this.isCapable(forge)) return;
    const slug = forge.slug!;
    const entry = this.entry(forge);
    if (!entry) return;
    const prs = entry.value.prs.flatMap((p) => (p.number !== number ? [p] : read ? [read.pr] : []));
    const statuses = new Map(entry.value.statuses);
    for (const [head, st] of entry.value.statuses) {
      if (st.number !== number) continue;
      if (read) statuses.set(head, read.status);
      else statuses.delete(head);
    }
    const value = { ...entry.value, prs, statuses };
    this.cache.set(slug, { ...entry, value });
    if (forge.kind === "github")
      this.readCache?.put("prs", slug, entry.contentKey, value, "", entry.at);
    this.notify(slug);
  }

  /** True after {@link noteHeadRead} saw the cached snapshot disagree with a newer head read. */
  isStale(forge: GitForge): boolean {
    return this.isCapable(forge) && this.staleAt.has(forge.slug!);
  }

  /**
   * Drop the cached entry (and any in-flight fetch pointer) for forge.slug so the
   * NEXT get() is a guaranteed miss that starts a fresh fetch. Call after a write
   * that mutates the open-PR set (e.g. a merge) so a client refetch can't read the
   * stale snapshot. No-op for incapable forges.
   *
   * Clearing the inflight pointer means a get() after this won't join a fetch that
   * started BEFORE the write (which would still carry the pre-write list); the
   * promise-identity guard in load() then prevents that abandoned fetch from
   * writing its stale value back once it resolves.
   */
  invalidate(forge: GitForge): void {
    if (!this.isCapable(forge)) return;
    const slug = forge.slug!;
    this.cache.delete(slug);
    this.inflight.delete(slug);
    this.staleAt.delete(slug);
    if (forge.kind === "github") this.readCache?.invalidate(slug, ["prs", "session"]);
  }

  private entry(forge: GitForge): CacheEntry | null {
    return this.readCache && forge.kind === "github"
      ? this.readCache.get("prs", forge.slug!)
      : (this.cache.get(forge.slug!) ?? null);
  }

  private syncReadCache(slug: string): void {
    if (!this.readCache) return;
    const revision = this.readCache.revision(slug);
    if (revision !== (this.revisions.get(slug) ?? 0)) this.inflight.delete(slug);
    this.revisions.set(slug, revision);
  }

  private notify(slug: string): void {
    for (const listener of this.listeners) {
      try {
        listener(slug);
      } catch (err) {
        console.warn("[open-pr-snapshot] update listener:", err);
      }
    }
  }

  /**
   * GitHub computes mergeability on demand: the read that finds it UNKNOWN starts the computation
   * and a later read returns it. Settling moves no fingerprint, so the snapshot would hold the
   * UNKNOWN until the repo changes. Re-read once more after a delay, at most
   * {@link SETTLE_DELAYS_MS} times per PR head and prs content key. A REST listing carries no
   * mergeability, so it never arms this.
   */
  private scheduleSettle(
    slug: string,
    forge: GitForge,
    snap: OpenPrSnapshot,
    contentKey: string | null,
  ): void {
    if (forge.kind !== "github" || snap.source === "rest" || this.settlePending.has(slug)) return;
    const prev = this.settleTries.get(slug);
    const carried = prev?.contentKey === contentKey ? prev.tries : new Map<string, number>();
    const tries = new Map<string, number>();
    for (const pr of snap.prs) {
      if (pr.mergeable != null) continue;
      const id = `${pr.number}:${pr.headSha ?? ""}`;
      tries.set(id, carried.get(id) ?? 0);
    }
    this.settleTries.set(slug, { contentKey, tries });
    const due = [...tries].filter(([, n]) => n < SETTLE_DELAYS_MS.length);
    if (due.length === 0) return;
    const attempt = Math.min(...due.map(([, n]) => n));
    for (const [id, n] of due) tries.set(id, n + 1);
    this.settlePending.add(slug);
    this.schedule(() => {
      this.settlePending.delete(slug);
      if (graphRateLimit.blocked() || (this.readCache && !this.readCache.canRefresh())) return;
      void this.refresh(forge);
    }, SETTLE_DELAYS_MS[attempt]!);
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
      const revision = this.readCache?.revision(slug);
      const fpKey =
        forge.kind === "github" ? (this.readCache?.contentKey("prs", slug) ?? null) : null;
      // Shared raw fetch: writes to cache on success, clears inflight on
      // both branches, and re-throws on failure so each caller can apply
      // its OWN preserve-on-error policy below.
      //
      // Both the cache write and the inflight clear are guarded on promise
      // identity: if invalidate() (or a newer fetch) has replaced this slug's
      // inflight pointer since we started, this fetch is stale (its list
      // predates the write that invalidated). It must neither write that stale
      // value back nor clear a newer fetch's inflight slot.
      const caller = currentGhCaller();
      const startedAt = this.now();
      const p: Promise<OpenPrSnapshot> = this.gate
        .run(() => forge.listOpenPrSnapshot!())
        .then(
          (v) => {
            // Which caller pays for each fetch (#2799) — rare now that reads key on the fingerprint.
            console.log(
              `[open-pr-snapshot] ${slug}: ${v.prs.length} open PRs (${v.source ?? "graphql"}) for ${caller}`,
            );
            if (this.inflight.get(slug) === p && revision === this.readCache?.revision(slug)) {
              this.cache.set(slug, { at: this.now(), value: v, contentKey: fpKey });
              if (forge.kind === "github") this.readCache?.put("prs", slug, fpKey, v);
              if ((this.staleAt.get(slug) ?? Infinity) <= startedAt) this.staleAt.delete(slug);
              this.inflight.delete(slug);
              this.notify(slug);
              this.scheduleSettle(slug, forge, v, fpKey);
            }
            return v;
          },
          (err) => {
            if (this.inflight.get(slug) === p) this.inflight.delete(slug);
            throw err;
          },
        );
      raw = p;
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
        const prev = this.entry(forge);
        return preserveOnError && prev ? prev.value : null;
      },
    );
  }
}
