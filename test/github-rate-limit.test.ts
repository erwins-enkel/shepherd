/**
 * Tests for src/forge/github-rate-limit.ts — live `gh api rate_limit` parsing,
 * TTL caching, and bucket extraction.
 *
 * A deterministic clock (`now`) is injected so the TTL window is testable without
 * wall-clock dependence. The module cache is reset before each test.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { fetchGithubRateLimit, __resetGithubRateLimitCache } from "../src/forge/github-rate-limit";

// A trimmed but realistic `gh api rate_limit` payload (epoch *seconds* for reset).
const SAMPLE = JSON.stringify({
  resources: {
    core: { limit: 5000, used: 173, remaining: 4827, reset: 1782756461 },
    graphql: { limit: 5000, used: 5002, remaining: 0, reset: 1782756188 },
    search: { limit: 30, used: 0, remaining: 30, reset: 1782755499 },
    integration_manifest: { limit: 5000, used: 0, remaining: 5000, reset: 1 },
  },
  rate: { limit: 5000, used: 173, remaining: 4827, reset: 1782756461 },
});

beforeEach(() => __resetGithubRateLimitCache());

describe("fetchGithubRateLimit — parsing", () => {
  it("extracts REST/core, GraphQL and search buckets with reset in epoch-ms", async () => {
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    expect(out.rest).toEqual({ limit: 5000, used: 173, remaining: 4827, resetAt: 1782756461000 });
    expect(out.graphql).toEqual({ limit: 5000, used: 5002, remaining: 0, resetAt: 1782756188000 });
    expect(out.search).toEqual({ limit: 30, used: 0, remaining: 30, resetAt: 1782755499000 });
    expect(out.fetchedAt).toBe(1000);
  });

  it("includes the GraphQL backoff snapshot", async () => {
    const out = await fetchGithubRateLimit(
      async () => SAMPLE,
      () => 1000,
    );
    expect(out.backoff).toHaveProperty("blocked");
    expect(out.backoff).toHaveProperty("remaining");
  });

  it("returns null buckets when resources are absent", async () => {
    const out = await fetchGithubRateLimit(
      async () => JSON.stringify({ resources: {} }),
      () => 1000,
    );
    expect(out.rest).toBeNull();
    expect(out.graphql).toBeNull();
    expect(out.search).toBeNull();
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

  it("propagates a gh failure (no stale cache to fall back on)", async () => {
    await expect(
      fetchGithubRateLimit(
        async () => {
          throw new Error("gh boom");
        },
        () => 1000,
      ),
    ).rejects.toThrow("gh boom");
  });
});
