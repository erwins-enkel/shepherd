/**
 * GraphQL rate-limit tracking for Shepherd's GitHub integration.
 *
 * GitHub GraphQL has its own 5,000-points-per-hour bucket, separate from the
 * REST bucket used by `gh run` and `gh api <rest-path>`. This module tracks
 * the last-seen budget from `rateLimit` query selections and exposes a shared
 * backoff signal that pollers consult before issuing new requests.
 *
 * Design goals:
 *  - Injectable `now` clock so tests are deterministic (no `Date.now()` calls
 *    inside logic that isn't routed through the injected fn).
 *  - Edge-triggered logging only: one `console.warn` on unblocked→blocked,
 *    one on blocked→unblocked — never once per call.
 *  - Pure helper functions (`isGraphqlBucketCall`, `isRateLimitError`,
 *    `parseRetryAfter`) with no side-effects, easily unit-tested.
 */

// ── Public types ──────────────────────────────────────────────────────────────

/** Immutable view of the current rate-limit state. */
export interface RateLimitSnapshot {
  /** Last-seen `remaining` from the GraphQL `rateLimit` field, or null if
   *  no reading has been recorded yet. */
  remaining: number | null;
  /** Epoch-ms timestamp at which the bucket resets (`rateLimit.resetAt`
   *  parsed via `Date.parse`), or null if unknown. */
  resetAt: number | null;
  /** Epoch-ms until which all GraphQL calls should be paused, or null when
   *  the backoff is not engaged. A non-null value in the past means the
   *  cooldown has naturally elapsed but no healthy reading has cleared it yet
   *  (callers should treat `blocked` rather than inspecting this directly). */
  pausedUntil: number | null;
  /** True iff `pausedUntil` is set and `now() < pausedUntil`. */
  blocked: boolean;
}

// ── GraphRateLimit ────────────────────────────────────────────────────────────

/**
 * Singleton-friendly tracker for the GitHub GraphQL rate-limit bucket.
 *
 * Construct with an injectable `now` function for deterministic testing:
 *
 *   const rl = new GraphRateLimit({ now: () => fakeTime });
 *
 * The module-level `graphRateLimit` export is the singleton used in production.
 */
export class GraphRateLimit {
  private readonly _now: () => number;
  private readonly _floor: number;
  private readonly _defaultCooldownMs: number;

  private _remaining: number | null = null;
  private _resetAt: number | null = null;
  private _pausedUntil: number | null = null;

  /**
   * True after we have emitted the "engaged" log, false after we emit the
   * "cleared" log. Guards against duplicate edge logs.
   */
  private _notifiedBlocked = false;

  constructor(opts?: { now?: () => number; floor?: number; defaultCooldownMs?: number }) {
    this._now = opts?.now ?? (() => Date.now());
    this._floor = opts?.floor ?? 100;
    this._defaultCooldownMs = opts?.defaultCooldownMs ?? 60_000;
  }

  /**
   * Record a fresh `rateLimit` reading from a GraphQL response.
   *
   * - If `remaining` is below the floor we are close to exhaustion: extend
   *   `pausedUntil` to `max(existing, resetAt)` so a longer error cooldown is
   *   never shortened.
   * - If `remaining` is at or above the floor the bucket is healthy: clear the
   *   backoff unconditionally (positive evidence we are not limited).
   */
  note(reading: { remaining: number; resetAt: number /* epoch ms */ }): void {
    const { remaining, resetAt } = reading;
    this._remaining = remaining;
    this._resetAt = resetAt;

    if (remaining < this._floor) {
      // Budget nearly exhausted — wait until the bucket refills.
      this._engage(resetAt);
    } else {
      // Healthy reading: positive evidence we can proceed.
      this._clear();
    }
  }

  /**
   * Record a detected GraphQL rate-limit error from `gh`.
   *
   * Sets `pausedUntil = max(existing, now() + retryAfterMs)` where
   * `retryAfterMs` defaults to `defaultCooldownMs`. A longer existing cooldown
   * is never shortened.
   *
   * @param retryAfterSec Optional `Retry-After` header value in seconds.
   */
  noteLimitError(retryAfterSec?: number): void {
    const cooldownMs =
      retryAfterSec !== undefined ? retryAfterSec * 1_000 : this._defaultCooldownMs;
    this._engage(this._now() + cooldownMs);
  }

  /**
   * Returns true when there is an active backoff window (the GraphQL bucket is
   * believed to be exhausted or rate-limited and `now()` is still inside the
   * cooldown period).
   */
  blocked(): boolean {
    return this._pausedUntil != null && this._now() < this._pausedUntil;
  }

  /** Returns an immutable snapshot of the current state. */
  snapshot(): RateLimitSnapshot {
    return {
      remaining: this._remaining,
      resetAt: this._resetAt,
      pausedUntil: this._pausedUntil,
      blocked: this.blocked(),
    };
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  /**
   * Extend the backoff window to `until` (taking the max of any existing value
   * so a shorter new reading never shortens a longer existing cooldown). Logs
   * once on the unblocked→blocked edge.
   */
  private _engage(until: number): void {
    const next = this._pausedUntil != null ? Math.max(this._pausedUntil, until) : until;
    const wasUnblocked = this._pausedUntil == null;
    this._pausedUntil = next;

    // Log only on the first engagement (transition from no backoff to backoff).
    if (wasUnblocked && !this._notifiedBlocked) {
      console.warn(`[rate-limit] GraphQL backoff engaged until ${new Date(next).toISOString()}`);
      this._notifiedBlocked = true;
    }
  }

  /**
   * Clear the backoff window. Logs once on the blocked→unblocked edge (only
   * when we previously emitted the "engaged" log).
   */
  private _clear(): void {
    const wasSet = this._pausedUntil != null;
    this._pausedUntil = null;
    if (wasSet && this._notifiedBlocked) {
      console.warn(`[rate-limit] GraphQL backoff cleared`);
      this._notifiedBlocked = false;
    }
  }
}

// ── Module singleton ──────────────────────────────────────────────────────────

/**
 * Module-level singleton used by `github.ts` and `index.ts`. All GitHub
 * GraphQL paths that can observe rate-limit signals funnel through this
 * instance so the backoff state is shared across pollers.
 */
export const graphRateLimit: GraphRateLimit = new GraphRateLimit();

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true iff the given `gh` arguments are routed through the GitHub
 * GraphQL bucket (as opposed to the REST bucket).
 *
 * Rules (per issue #1230 analysis):
 *  - `gh api graphql …`   → GraphQL bucket (true)
 *  - `gh api <rest-path>` → REST bucket    (false) — must never trip the backoff
 *  - `gh pr / issue / repo / search …` → GraphQL-backed subcommands (true)
 *  - `gh run …` and everything else → REST or unrelated (false)
 */
export function isGraphqlBucketCall(args: string[]): boolean {
  const sub = args[0];
  if (sub === "api") {
    // Only `gh api graphql` hits the GraphQL bucket; all other `gh api <path>`
    // calls use the REST bucket and must NOT trigger GraphQL backoff.
    return args[1] === "graphql";
  }
  // These high-level subcommands are powered by GraphQL internally.
  return sub === "pr" || sub === "issue" || sub === "repo" || sub === "search";
}

/**
 * Returns true when an error thrown by `gh` indicates a GraphQL primary or
 * secondary rate limit.
 *
 * Matches both `"rate limit"` (primary / API rate limit exceeded) and
 * `"rate_limited"` (secondary rate limit) anywhere in the error text,
 * case-insensitively.
 */
export function isRateLimitError(err: unknown): boolean {
  const text = String(
    (err as Record<string, unknown>)?.stderr ??
      (err as Record<string, unknown>)?.message ??
      String(err),
  ).toLowerCase();
  return text.includes("rate limit") || text.includes("rate_limited");
}

/**
 * Parse a `Retry-After` seconds value from `gh` stderr text.
 *
 * Matches patterns such as:
 *  - `Retry-After: 60`
 *  - `retry after 120`
 *  - `retry-after:30`
 *
 * Returns the numeric seconds value, or `undefined` if not found.
 */
export function parseRetryAfter(text: string): number | undefined {
  const m = /retry[- ]after[:\s]+(\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}
