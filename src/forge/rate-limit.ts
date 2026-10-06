/**
 * Rate-limit tracking for Shepherd's GitHub integration.
 *
 * GitHub GraphQL has its own 5,000-points-per-hour bucket, separate from the
 * REST bucket used by `gh run` and `gh api <rest-path>` — and GitHub limits REST
 * writes on a counter of their own, exhausted independently of REST reads (#2805).
 * This module tracks each ({@link graphRateLimit}, {@link restRateLimit},
 * {@link restWriteRateLimit}) and exposes a shared backoff signal that pollers
 * consult before issuing new requests.
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

// ── BucketRateLimit ───────────────────────────────────────────────────────────

/**
 * Singleton-friendly tracker for one GitHub rate-limit bucket.
 *
 * Construct with an injectable `now` function for deterministic testing:
 *
 *   const rl = new BucketRateLimit({ now: () => fakeTime });
 *
 * The module-level {@link graphRateLimit}, {@link restRateLimit} and
 * {@link restWriteRateLimit} exports are the singletons used in production.
 */
export class BucketRateLimit {
  private readonly _now: () => number;
  private readonly _floor: number;
  private readonly _defaultCooldownMs: number;
  private readonly _maxCooldownMs: number;
  private readonly _label: string;

  private _remaining: number | null = null;
  private _resetAt: number | null = null;
  private _pausedUntil: number | null = null;
  /** Consecutive windows that lapsed straight into another limit error, with no
   *  success in between — drives the escalating cooldown. */
  private _strikes = 0;

  /**
   * True after we have emitted the "engaged" log, false after we emit the
   * "cleared" log. Guards against duplicate edge logs.
   */
  private _notifiedBlocked = false;

  /**
   * @param opts.label         Bucket name for the edge logs ("GraphQL" by default).
   * @param opts.maxCooldownMs Ceiling for the escalating cooldown. Defaults to
   *   `defaultCooldownMs`, i.e. no escalation.
   */
  constructor(opts?: {
    now?: () => number;
    floor?: number;
    defaultCooldownMs?: number;
    maxCooldownMs?: number;
    label?: string;
  }) {
    this._now = opts?.now ?? (() => Date.now());
    this._floor = opts?.floor ?? 100;
    this._defaultCooldownMs = opts?.defaultCooldownMs ?? 60_000;
    this._maxCooldownMs = opts?.maxCooldownMs ?? this._defaultCooldownMs;
    this._label = opts?.label ?? "GraphQL";
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
      this.noteSuccess();
    }
  }

  /**
   * Record positive evidence that the bucket answers (a call on it succeeded):
   * clears the backoff and resets the escalation.
   */
  noteSuccess(): void {
    this._strikes = 0;
    this._clear();
  }

  /**
   * Record a detected rate-limit error from `gh`.
   *
   * Sets `pausedUntil = max(existing, now() + cooldown)`. A longer existing
   * cooldown is never shortened. Without a `Retry-After`, the cooldown starts at
   * `defaultCooldownMs` and doubles (up to `maxCooldownMs`) each time a window
   * lapses straight into another limit error. Errors from calls that were already
   * in flight when the window opened do not escalate it.
   *
   * @param retryAfterSec Optional `Retry-After` header value in seconds.
   * @param cause         What tripped it (the call and its stderr line), appended to the
   *   "engaged" log so every engagement is explained (#2805).
   */
  noteLimitError(retryAfterSec?: number, cause?: string): void {
    if (retryAfterSec !== undefined) {
      this._engage(this._now() + retryAfterSec * 1_000, cause);
      return;
    }
    if (!this.blocked()) this._strikes++;
    const cooldownMs = Math.min(
      this._defaultCooldownMs * 2 ** Math.max(0, this._strikes - 1),
      this._maxCooldownMs,
    );
    this._engage(this._now() + cooldownMs, cause);
  }

  /**
   * Returns true when there is an active backoff window (the bucket is believed
   * to be exhausted or rate-limited and `now()` is still inside the cooldown
   * period).
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
   * once on the unblocked→blocked edge, using the observable `blocked()` state
   * so a re-engagement after natural expiry also logs correctly.
   */
  private _engage(until: number, cause?: string): void {
    const wasBlocked = this.blocked();
    const next = this._pausedUntil != null ? Math.max(this._pausedUntil, until) : until;
    this._pausedUntil = next;

    // Log on every unblocked→blocked transition (fresh engagement or
    // re-engagement after natural expiry). `wasBlocked` is the authoritative
    // edge trigger — no secondary `_notifiedBlocked` guard needed here.
    if (!wasBlocked) {
      console.warn(
        `[rate-limit] ${this._label} backoff engaged until ${new Date(next).toISOString()}${cause ? ` — ${cause}` : ""}`,
      );
      this._notifiedBlocked = true;
    }
  }

  /**
   * Clear the backoff window. Logs once on the blocked→unblocked edge (only
   * when the backoff was actively blocking at the time of the call, and we
   * previously emitted the "engaged" log). A healthy reading that arrives after
   * a cooldown has already elapsed naturally does NOT emit a spurious "cleared"
   * log.
   */
  private _clear(): void {
    const wasBlocked = this.blocked();
    this._pausedUntil = null;
    if (wasBlocked && this._notifiedBlocked) {
      console.warn(`[rate-limit] ${this._label} backoff cleared`);
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
export const graphRateLimit: BucketRateLimit = new BucketRateLimit();

/**
 * The REST (`core`) bucket's READ tracker (#2656, #2805) — only REST reads
 * ({@link isRestReadCall}) engage, clear or are gated by it. REST calls carry no
 * budget reading Shepherd can parse, `gh` prints no reset time, and
 * `gh api rate_limit` is no health check (it is limit-exempt and was seen
 * reporting 5000/5000 while every real REST call 403'd) — so the window escalates
 * from 60s to 15 min while probes keep failing, and the first success clears it.
 */
export const restRateLimit: BucketRateLimit = new BucketRateLimit({
  label: "REST read",
  maxCooldownMs: 15 * 60_000,
});

/**
 * The REST WRITE tracker (#2805). GitHub limits REST writes on a counter of their
 * own: a POST was seen 403ing at 5000/5000 while GETs on the same token read
 * 34/5000. So a write's limit error engages only this tracker and never blocks
 * reads. The runner doesn't gate writes on it (an operator's write runs and
 * surfaces its error); periodic background writes skip while it is blocked.
 * Escalates like {@link restRateLimit}.
 */
export const restWriteRateLimit: BucketRateLimit = new BucketRateLimit({
  label: "REST write",
  maxCooldownMs: 15 * 60_000,
});

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

/** `gh api` flags that consume the following argument. */
const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--input",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** The endpoint of a `gh api …` invocation — its first positional argument. */
function apiEndpoint(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (API_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/**
 * Returns true iff the given `gh` arguments draw on the REST (`core`) bucket:
 * `gh api <rest-path>` and the REST-backed `gh run` / `gh workflow`. False for
 * GraphQL, for the limit-exempt `rate_limit` endpoint, and for everything else.
 */
export function isRestBucketCall(args: string[]): boolean {
  const sub = args[0];
  if (sub === "run" || sub === "workflow") return true;
  if (sub !== "api") return false;
  const endpoint = apiEndpoint(args);
  return endpoint !== undefined && endpoint !== "graphql" && endpoint !== "rate_limit";
}

/** `gh api` flags that make the request carry a body — and so default it to POST. */
const API_BODY_FLAGS = ["-f", "--raw-field", "-F", "--field", "--input"];

/**
 * Returns true iff the call is a REST-bucket READ: a `gh api` GET (explicit, or
 * implied — `gh api` defaults to POST once fields or `--input` are passed) or
 * `gh run list` / `gh run view`. Only these may be skipped during a REST backoff;
 * writes always go through, and are tracked apart ({@link restWriteRateLimit}).
 */
export function isRestReadCall(args: string[]): boolean {
  if (!isRestBucketCall(args)) return false;
  if (args[0] === "run") return args[1] === "list" || args[1] === "view";
  if (args[0] !== "api") return false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-X" || args[i] === "--method") return args[i + 1]?.toUpperCase() === "GET";
  }
  return !args.some((a) => API_BODY_FLAGS.includes(a));
}

/**
 * A short, log-safe name for a `gh` call (#2805): `gh api <METHOD> <endpoint>` for
 * `gh api` (the method as `gh` will send it), otherwise `gh <sub> <action>`, e.g.
 * `gh run rerun`. Never includes a flag value, so field bodies stay out of logs.
 */
export function ghCallSummary(args: string[]): string {
  if (args[0] !== "api") {
    const action = args[1] && !args[1].startsWith("-") ? ` ${args[1]}` : "";
    return `gh ${args[0] ?? ""}${action}`;
  }
  const m = args.findIndex((a) => a === "-X" || a === "--method");
  const method =
    m >= 0
      ? (args[m + 1]?.toUpperCase() ?? "?")
      : args.some((a) => API_BODY_FLAGS.includes(a))
        ? "POST"
        : "GET";
  return `gh api ${method} ${apiEndpoint(args) ?? "?"}`;
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
