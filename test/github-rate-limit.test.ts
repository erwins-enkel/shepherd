/**
 * Tests for src/forge/github-rate-limit.ts — REST bucket from response headers, GraphQL bucket from
 * the in-query reading (never `gh api rate_limit`, #2743), TTL caching and the callers tally.
 *
 * A deterministic clock (`now`) is injected so the TTL window is testable without
 * wall-clock dependence. The module cache is reset before each test.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchGithubRateLimit,
  parseRestRateHeaders,
  __resetGithubRateLimitCache,
} from "../src/forge/github-rate-limit";
import { restRateLimit, restWriteRateLimit } from "../src/forge/rate-limit";
import { GraphqlSpendLedger, graphqlSpend } from "../src/forge/github-spend";

// `gh api -i --method HEAD user` output (epoch *seconds* for reset).
const SAMPLE = [
  "HTTP/2.0 200 OK",
  "Access-Control-Expose-Headers: ETag, X-RateLimit-Limit, X-RateLimit-Remaining",
  "X-Ratelimit-Limit: 5000",
  "X-Ratelimit-Remaining: 4827",
  "X-Ratelimit-Reset: 1782756461",
  "X-Ratelimit-Resource: core",
  "X-Ratelimit-Used: 173",
  "",
].join("\r\n");

beforeEach(() => __resetGithubRateLimitCache());
// The REST trackers are process singletons; clear any backoff a case engaged.
afterEach(() => {
  restRateLimit.noteSuccess();
  restWriteRateLimit.noteSuccess();
});

describe("fetchGithubRateLimit — sources (#2743)", () => {
  it("reads REST from one HEAD /user's headers, never rate_limit", async () => {
    const calls: string[][] = [];
    const out = await fetchGithubRateLimit(
      async (args) => {
        calls.push(args);
        return SAMPLE;
      },
      () => 1000,
      new GraphqlSpendLedger(),
    );
    expect(calls).toEqual([["api", "-i", "--method", "HEAD", "user"]]);
    expect(out.rest).toEqual({ limit: 5000, used: 173, remaining: 4827, resetAt: 1782756461000 });
    expect(out.fetchedAt).toBe(1000);
  });

  it("reads GraphQL from the ledger's latest in-query reading", async () => {
    const resetAt = Date.now() + 3_000_000;
    const spend = new GraphqlSpendLedger();
    expect(
      (
        await fetchGithubRateLimit(
          async () => SAMPLE,
          () => 1000,
          spend,
        )
      ).graphql,
    ).toBeNull();
    spend.noteReading({ used: 120, remaining: 4880, resetAt });
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
      spend,
    );
    expect(out.graphql).toEqual({ limit: 5000, used: 120, remaining: 4880, resetAt });
  });

  it("carries the window's callers", async () => {
    const spend = new GraphqlSpendLedger();
    spend.noteCall("drain", { graphqlPoints: 2, rest: false });
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
      spend,
    );
    expect(out.callers).toEqual([{ caller: "drain", calls: 1, graphqlPoints: 2, restCalls: 0 }]);
  });

  it("a failed probe leaves REST null instead of throwing", async () => {
    const out = await fetchGithubRateLimit(
      async () => {
        throw new Error("gh boom");
      },
      () => 1000,
    );
    expect(out.rest).toBeNull();
  });

  it("parseRestRateHeaders rejects another resource or missing headers", () => {
    expect(parseRestRateHeaders(SAMPLE.replace("core", "graphql"))).toBeNull();
    expect(parseRestRateHeaders("HTTP/2.0 200 OK\r\n")).toBeNull();
  });
});

describe("fetchGithubRateLimit — parsing", () => {
  it("includes the GraphQL backoff snapshot", async () => {
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    expect(out.backoff).toHaveProperty("blocked");
    expect(out.backoff).toHaveProperty("remaining");
  });

  it("includes the REST backoff snapshot (#2662)", async () => {
    // `gh api rate_limit` can report a full REST budget while every real REST call
    // 403s, so the payload must carry Shepherd's own REST backoff alongside it.
    restRateLimit.noteLimitError(120);
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    expect(out.restBackoff.blocked).toBe(true);
    expect(out.restBackoff.pausedUntil).toBeGreaterThan(Date.now());
  });

  it("carries the REST read and write backoffs apart (#2805)", async () => {
    restWriteRateLimit.noteLimitError(120);
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    expect(out.restWriteBackoff.blocked).toBe(true);
    expect(out.restWriteBackoff.pausedUntil).toBeGreaterThan(Date.now());
    expect(out.restBackoff.blocked).toBe(false);
  });

  it("returns null buckets when the headers are absent", async () => {
    const out = await fetchGithubRateLimit(
      async () => JSON.stringify({ resources: {} }),
      () => 1000,
    );
    expect(out.rest).toBeNull();
    expect(out.graphql).toBeNull();
  });
});

describe("fetchGithubRateLimit — caching", () => {
  it("serves a cached reading inside the TTL window (no second gh call)", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return SAMPLE;
    };
    await fetchGithubRateLimit(run, () => 1000);
    await fetchGithubRateLimit(run, () => 1000 + 5_000); // within 15s TTL
    expect(calls).toBe(1);
  });

  it("refreshes the REST backoff on a cached reading", async () => {
    await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    restRateLimit.noteLimitError(120); // engages after the cached `gh` call
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000 + 5_000,
    );
    expect(out.restBackoff.blocked).toBe(true);
  });

  it("refreshes the REST write backoff on a cached reading (#2805)", async () => {
    await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    restWriteRateLimit.noteLimitError(120);
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000 + 5_000,
    );
    expect(out.restWriteBackoff.blocked).toBe(true);
    expect(out.restBackoff.blocked).toBe(false);
  });

  it("carries the live GraphQL spend split, cold and cached (#2840)", async () => {
    // A window of its own, so whatever the process-wide ledger held before can't leak in.
    const resetAt = Date.now() + 3_600_000 + 17_000;
    graphqlSpend.noteReading({ used: 100, resetAt });
    const cold = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    expect(cold.graphqlSplit).toMatchObject({ resetAt, ownPoints: 0, otherPoints: 0 });
    graphqlSpend.noteOwnSpend(4);
    graphqlSpend.noteReading({ used: 110, resetAt });
    const cached = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000 + 5_000,
    );
    expect(cached.graphqlSplit).toMatchObject({ resetAt, ownPoints: 4, otherPoints: 6 });
  });

  it("re-fetches once the TTL has elapsed", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return SAMPLE;
    };
    await fetchGithubRateLimit(run, () => 1000);
    await fetchGithubRateLimit(run, () => 1000 + 20_000); // past 15s TTL
    expect(calls).toBe(2);
  });
});
