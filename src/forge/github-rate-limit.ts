/**
 * Live GitHub rate-limit readings for Shepherd's usage view.
 *
 * GitHub maintains *separate* hourly buckets for its REST API (`core`, used by `gh run` and
 * `gh api <rest-path>`) and its GraphQL API (used by `gh pr`/`issue`/`repo` and Shepherd's own
 * queries). When the GraphQL bucket is exhausted, PR/issue polling stops while REST-backed
 * actions keep working — confusing unless the two budgets are shown apart.
 *
 * Both buckets come from what GitHub reports on real requests, never from `gh api rate_limit`,
 * which misreports on this account — a full bucket while real calls 403, reset times that differ
 * from the real window (#2743):
 *  - REST: the `x-ratelimit-*` headers of one `HEAD /user` (one core request per refresh);
 *  - GraphQL: the in-query `rateLimit` reading Shepherd's own queries already carry (free).
 * We pair them with Shepherd's own GraphQL, REST read and REST write backoff state
 * ({@link graphRateLimit}, {@link restRateLimit}, {@link restWriteRateLimit}) so the UI can explain
 * *why* polling is paused, not just that a budget is low, and with the per-caller tally of the
 * current window so a burn can be traced to its source.
 */

import {
  graphqlSpend,
  type GhCallerTally,
  type GraphqlSpendLedger,
  type GraphqlSpendSplit,
} from "./github-spend";
import {
  graphRateLimit,
  restRateLimit,
  restWriteRateLimit,
  type RateLimitSnapshot,
} from "./rate-limit";

/** A single GitHub rate-limit bucket (REST core / GraphQL). */
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
 *  GraphQL and REST read/write backoff state that gates background work and the
 *  GraphQL spend split. */
export interface GithubRateLimitPayload {
  /** REST bucket (`core`), from response headers. Null when the probe failed. */
  rest: GhRateBucket | null;
  /** GraphQL bucket, from the latest in-query reading. Null before one in the live window. */
  graphql: GhRateBucket | null;
  /** Epoch-ms when these readings were fetched. */
  fetchedAt: number;
  /** Shepherd's GraphQL backoff state — non-null `pausedUntil`/`blocked`
   *  explains a polling pause even before a bucket is fully empty. */
  backoff: RateLimitSnapshot;
  /** Shepherd's REST read backoff state — while `blocked`, REST reads (CI status, run
   *  logs, REST issue lists) are skipped, whatever `rest` reports. */
  restBackoff: RateLimitSnapshot;
  /** Shepherd's REST write backoff state (#2805) — while `blocked`, periodic background
   *  writes (CI re-runs, epic stack updates) are skipped; reads and operator writes run. */
  restWriteBackoff: RateLimitSnapshot;
  /** The current GraphQL window split into the Shepherd server's own spend and everything else
   *  on the account (#2840); null before an in-query reading of a live window. */
  graphqlSplit: GraphqlSpendSplit | null;
  /** GitHub calls of the current GraphQL window per caller (#2743), most points first. */
  callers: GhCallerTally[];
}

type GhRun = (args: string[]) => Promise<string>;

/** Short TTL so repeated UI opens / refresh clicks don't spend a REST request each. */
const TTL_MS = 15_000;

/** One cheap REST request whose headers carry the core bucket. */
const REST_PROBE = ["api", "-i", "--method", "HEAD", "user"];

let cache: { at: number; rest: GhRateBucket | null } | null = null;

/** The core bucket from `gh api -i` output's `x-ratelimit-*` headers; null when any is missing or
 *  the response names another resource. */
export function parseRestRateHeaders(out: string): GhRateBucket | null {
  const h = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^x-ratelimit-(limit|used|remaining|reset|resource):\s*(\S+)/i.exec(line);
    if (m) h.set(m[1]!.toLowerCase(), m[2]!);
  }
  if (h.has("resource") && h.get("resource") !== "core") return null;
  const n = (k: string) => Number(h.get(k) ?? NaN);
  const [limit, used, remaining, reset] = [n("limit"), n("used"), n("remaining"), n("reset")];
  if (![limit, used, remaining, reset].every(Number.isFinite)) return null;
  // GitHub sends `reset` as epoch *seconds*; surface epoch-ms for the UI.
  return { limit, used, remaining, resetAt: reset * 1_000 };
}

async function readRestBucket(run: GhRun): Promise<GhRateBucket | null> {
  try {
    return parseRestRateHeaders(await run(REST_PROBE));
  } catch {
    return null; // backoff or failure: the backoff snapshots explain it
  }
}

/** The GraphQL bucket as the latest in-query reading of the live window reported it. */
function graphqlBucket(spend: GraphqlSpendLedger): GhRateBucket | null {
  const r = spend.latestReading();
  return r
    ? { limit: r.used + r.remaining, used: r.used, remaining: r.remaining, resetAt: r.resetAt }
    : null;
}

/**
 * The current REST + GraphQL buckets. The REST probe is cached for {@link TTL_MS}; everything
 * else — the GraphQL reading, backoffs, split and callers — is read live (free). Never throws.
 *
 * @param run    injected `gh` runner (production passes the shared async runner).
 * @param now    injectable clock for deterministic tests.
 * @param spend  the ledger holding the GraphQL readings and callers.
 */
export async function fetchGithubRateLimit(
  run: GhRun,
  now: () => number = () => Date.now(),
  spend: GraphqlSpendLedger = graphqlSpend,
): Promise<GithubRateLimitPayload> {
  const t = now();
  if (!cache || t - cache.at >= TTL_MS) cache = { at: t, rest: await readRestBucket(run) };
  return {
    rest: cache.rest,
    graphql: graphqlBucket(spend),
    fetchedAt: cache.at,
    backoff: graphRateLimit.snapshot(),
    restBackoff: restRateLimit.snapshot(),
    restWriteBackoff: restWriteRateLimit.snapshot(),
    graphqlSplit: spend.split(),
    callers: spend.callers(),
  };
}

/** Test-only: drop the module cache so each case starts cold. */
export function __resetGithubRateLimitCache(): void {
  cache = null;
}
