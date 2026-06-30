/**
 * Live GitHub rate-limit readings for Shepherd's usage view.
 *
 * GitHub maintains *separate* hourly buckets for its REST API (`resources.core`,
 * used by `gh run` and `gh api <rest-path>`) and its GraphQL API
 * (`resources.graphql`, used by `gh pr`/`issue`/`repo`/`search` and the backlog
 * counts query). When the GraphQL bucket is exhausted, PR/issue polling silently
 * stops while REST-backed actions keep working — confusing unless the two budgets
 * are shown apart.
 *
 * `gh api rate_limit` returns every bucket in one call and — crucially — does
 * **not** itself count against any bucket, so we can poll it for display even
 * while a bucket is at zero. We pair the live readings with Shepherd's own
 * GraphQL backoff state ({@link graphRateLimit}) so the UI can explain *why*
 * polling is paused, not just that a budget is low.
 */

import { graphRateLimit, type RateLimitSnapshot } from "./rate-limit";

/** A single GitHub rate-limit bucket (REST core / GraphQL / search). */
export interface GhRateBucket {
  /** Per-hour ceiling for this bucket. */
  limit: number;
  /** Points/requests consumed this window. */
  used: number;
  /** Points/requests left this window. */
  remaining: number;
  /** Epoch-ms timestamp at which the bucket refills. */
  resetAt: number;
}

/** Snapshot of the GitHub rate-limit buckets relevant to Shepherd, plus the
 *  GraphQL backoff state that gates background polling. */
export interface GithubRateLimitPayload {
  /** REST bucket (`resources.core`). Null if the response lacked it. */
  rest: GhRateBucket | null;
  /** GraphQL bucket (`resources.graphql`). Null if the response lacked it. */
  graphql: GhRateBucket | null;
  /** Search bucket (`resources.search`). Null if the response lacked it. */
  search: GhRateBucket | null;
  /** Epoch-ms when these readings were fetched. */
  fetchedAt: number;
  /** Shepherd's GraphQL backoff state — non-null `pausedUntil`/`blocked`
   *  explains a polling pause even before a bucket is fully empty. */
  backoff: RateLimitSnapshot;
}

type GhRun = (args: string[]) => Promise<string>;

/** Short TTL so repeated UI opens / refresh clicks don't spawn a `gh` subprocess
 *  per request. `gh api rate_limit` is quota-exempt, so this is purely to bound
 *  subprocess churn, not to conserve budget. */
const TTL_MS = 15_000;

let cache: { at: number; payload: GithubRateLimitPayload } | null = null;

/** Parse one `resources.<name>` object into a bucket, tolerating missing fields. */
function parseBucket(raw: unknown): GhRateBucket | null {
  const b = raw as Record<string, unknown> | undefined;
  if (!b || typeof b.remaining !== "number") return null;
  return {
    limit: typeof b.limit === "number" ? b.limit : 0,
    used: typeof b.used === "number" ? b.used : 0,
    remaining: b.remaining,
    // GitHub returns `reset` as epoch *seconds*; surface epoch-ms for the UI.
    resetAt: typeof b.reset === "number" ? b.reset * 1_000 : 0,
  };
}

/**
 * Fetch the current GitHub REST + GraphQL + search rate-limit buckets via
 * `gh api rate_limit`, cached for {@link TTL_MS}. The GraphQL backoff snapshot is
 * always read live (it's free). Throws if `gh` fails or returns unparseable JSON.
 *
 * @param run  injected `gh` runner (production passes the shared async runner).
 * @param now  injectable clock for deterministic tests.
 */
export async function fetchGithubRateLimit(
  run: GhRun,
  now: () => number = () => Date.now(),
): Promise<GithubRateLimitPayload> {
  const t = now();
  if (cache && t - cache.at < TTL_MS) {
    // Refresh only the (free) backoff view so a cached buckets reading still
    // reflects a backoff that engaged since the last `gh` call.
    return { ...cache.payload, backoff: graphRateLimit.snapshot() };
  }

  const out = await run(["api", "rate_limit"]);
  const json = JSON.parse(out) as { resources?: Record<string, unknown> };
  const r = json.resources ?? {};
  const payload: GithubRateLimitPayload = {
    rest: parseBucket(r.core),
    graphql: parseBucket(r.graphql),
    search: parseBucket(r.search),
    fetchedAt: t,
    backoff: graphRateLimit.snapshot(),
  };
  cache = { at: t, payload };
  return payload;
}

/** Test-only: drop the module cache so each case starts cold. */
export function __resetGithubRateLimitCache(): void {
  cache = null;
}
