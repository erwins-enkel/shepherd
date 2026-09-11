import type { GitForge, Issue } from "./forge/types";

/**
 * Single-issue reads for the session card's hover preview (#2249 follow-up).
 *
 * `GitForge.getIssue()` is UNCACHED BY CONTRACT — the drain needs a fresh read to see a
 * claim another instance stamped seconds ago, and pays one `gh` subprocess per call for
 * it. A hover trigger must not inherit that cost: pointing at a card is cheap for the
 * operator and expensive for us, and a herd is a wall of cards. So the cache lives HERE,
 * in front of the forge call, rather than inside it — the drain's contract stays intact
 * and only the peek path is throttled.
 *
 * Same shape as `branchStatusCached` in server.ts: TTL hit, in-flight coalescing so
 * concurrent misses for one issue share a single subprocess, prune-then-cap on write.
 * A `null` result is cached too: a gone, unreadable or rate-limited issue must not be
 * re-attempted on every hover.
 */

export const PEEK_TTL_MS = 60_000;
/** Bound the map on a long-running server. Same reasoning as BRANCH_STATUS_CACHE_MAX. */
const PEEK_CACHE_MAX = 256;
/**
 * The preview clamps the body to a handful of lines, so shipping a 100k-char issue body
 * to paint eight lines is pure waste on the wire. Cut it here, once, on the way into the
 * cache.
 */
export const PEEK_BODY_MAX = 2000;

const cache = new Map<string, { at: number; issue: Issue | null }>();
const inflight = new Map<string, Promise<Issue | null>>();

/** Clear the in-memory issue-peek cache — for use in tests only. */
export function clearIssuePeekCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

function truncateBody(issue: Issue): Issue {
  if (issue.body.length <= PEEK_BODY_MAX) return issue;
  return { ...issue, body: issue.body.slice(0, PEEK_BODY_MAX) };
}

/**
 * One issue for the hover preview, or null when the forge can't produce it (no
 * `getIssue` support, gone/unreadable issue, or a failing/rate-limited transport).
 * Never throws: the preview degrades to its launch-time snapshot, it doesn't error.
 */
export async function peekIssue(
  forge: GitForge,
  repoPath: string,
  issueNumber: number,
  now: () => number = Date.now,
): Promise<Issue | null> {
  // No single-issue read on this host (local mode, or a forge without the API): there is
  // nothing to spend and nothing to cache — the answer can't change until the process does.
  if (!forge.getIssue) return null;
  const key = `${repoPath}\0${issueNumber}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < PEEK_TTL_MS) return hit.issue;
  const joined = inflight.get(key);
  if (joined) return joined;
  const p = (async () => {
    let issue: Issue | null;
    try {
      const fetched = await forge.getIssue!(issueNumber);
      issue = fetched ? truncateBody(fetched) : null;
    } catch {
      // getIssue is documented best-effort, but a host that throws must not take the
      // route down with it — a failed peek is an empty preview, not a 500.
      issue = null;
    }
    const at = now();
    for (const [k, v] of cache) {
      if (at - v.at >= PEEK_TTL_MS) cache.delete(k);
    }
    while (cache.size >= PEEK_CACHE_MAX) {
      cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { at, issue });
    return issue;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
