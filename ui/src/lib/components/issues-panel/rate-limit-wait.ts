import type { GhBackoff, GhRateBucket, GithubRateLimit, IssueFetchAttempt } from "#lib/types.js";

/** When an issue listing that GitHub rate-limited can load again. */
export interface RateLimitWait {
  /** Epoch-ms per rate-limited transport whose refill time is known. */
  freeAt: Partial<Record<IssueFetchAttempt["transport"], number>>;
  /** Epoch-ms the listing loads again: the EARLIEST transport refill, because the server
   *  falls back from one transport to the other, so whichever refills first answers. */
  resumeAt: number;
}

/** True when at least one transport behind a failed listing gave up on a rate limit. */
export function isRateLimited(attempts: IssueFetchAttempt[]): boolean {
  return attempts.some((a) => a.reason === "rate_limit");
}

/** `gh issue list` draws on the GraphQL bucket, `gh api` on REST (see IssueLoadAttempts). */
function bucketFor(
  transport: string,
  gh: GithubRateLimit,
): { bucket: GhRateBucket | null; backoff: GhBackoff } | null {
  if (transport === "cli") return { bucket: gh.graphql, backoff: gh.backoff };
  if (transport === "rest") return { bucket: gh.rest, backoff: gh.restBackoff };
  return null;
}

/**
 * When a rate-limited transport answers again: the later of its bucket's reset (only while
 * the bucket is empty) and Shepherd's own backoff on it — the backoff is the only signal
 * when GitHub's reading still shows budget while calls are refused (#2662). Null when
 * neither says it is still limited, or the time has already passed.
 */
export function transportFreeAt(
  transport: string,
  gh: GithubRateLimit,
  now: number,
): number | null {
  const b = bucketFor(transport, gh);
  if (!b) return null;
  const until = Math.max(
    b.bucket && b.bucket.remaining <= 0 ? b.bucket.resetAt : 0,
    b.backoff.pausedUntil ?? 0,
  );
  return until > now ? until : null;
}

/** When the failed listing loads again, or null when no rate-limited transport has a known
 *  refill time (the card then says so instead of guessing). */
export function rateLimitWait(
  attempts: IssueFetchAttempt[],
  gh: GithubRateLimit,
  now: number,
): RateLimitWait | null {
  const freeAt: RateLimitWait["freeAt"] = {};
  for (const a of attempts) {
    if (a.reason !== "rate_limit") continue;
    const t = transportFreeAt(a.transport, gh, now);
    if (t !== null) freeAt[a.transport] = t;
  }
  const times = Object.values(freeAt);
  return times.length > 0 ? { freeAt, resumeAt: Math.min(...times) } : null;
}
