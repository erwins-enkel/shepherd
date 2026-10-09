import { describe, it, expect } from "vitest";
import type { GhBackoff, GhRateBucket, GithubRateLimit, IssueFetchAttempt } from "#lib/types.js";
import { isRateLimited, rateLimitWait, transportFreeAt } from "./rate-limit-wait";

const NOW = 1_000_000;
const MIN = 60_000;

function bucket(remaining: number, resetAt: number): GhRateBucket {
  return { limit: 5000, used: 5000 - remaining, remaining, resetAt };
}
function backoff(pausedUntil: number | null = null): GhBackoff {
  return { remaining: null, resetAt: null, pausedUntil, blocked: pausedUntil != null };
}
function gh(over: Partial<GithubRateLimit> = {}): GithubRateLimit {
  return {
    rest: bucket(4000, NOW + 50 * MIN),
    graphql: bucket(4000, NOW + 50 * MIN),
    search: null,
    fetchedAt: NOW,
    backoff: backoff(),
    restBackoff: backoff(),
    restWriteBackoff: backoff(),
    graphqlSplit: null,
    ...over,
  };
}
const limited = (transport: IssueFetchAttempt["transport"]): IssueFetchAttempt => ({
  transport,
  reason: "rate_limit",
  detail: "",
});

describe("transportFreeAt", () => {
  it("is the bucket reset while the bucket is empty", () => {
    expect(transportFreeAt("cli", gh({ graphql: bucket(0, NOW + 20 * MIN) }), NOW)).toBe(
      NOW + 20 * MIN,
    );
  });

  // GitHub's REST reading can show a full budget while every REST call is refused
  // (#2662) — Shepherd's backoff is then the only clue to when it answers again.
  it("is the backoff end when the bucket still reads as having budget", () => {
    expect(transportFreeAt("rest", gh({ restBackoff: backoff(NOW + 7 * MIN) }), NOW)).toBe(
      NOW + 7 * MIN,
    );
  });

  it("takes the later of an empty bucket's reset and a longer backoff", () => {
    const r = gh({ graphql: bucket(0, NOW + 5 * MIN), backoff: backoff(NOW + 9 * MIN) });
    expect(transportFreeAt("cli", r, NOW)).toBe(NOW + 9 * MIN);
  });

  it("is null when neither the bucket nor a backoff says it is still limited", () => {
    expect(transportFreeAt("cli", gh(), NOW)).toBeNull();
  });

  it("is null once the refill time has passed", () => {
    expect(transportFreeAt("cli", gh({ graphql: bucket(0, NOW - MIN) }), NOW)).toBeNull();
  });

  it("is null for a transport this build doesn't know", () => {
    expect(transportFreeAt("ssh", gh({ graphql: bucket(0, NOW + MIN) }), NOW)).toBeNull();
  });
});

describe("rateLimitWait", () => {
  // The server falls back from one transport to the other, so the listing answers as
  // soon as EITHER refills.
  it("resumes at the earliest refill across the rate-limited transports", () => {
    const r = gh({ graphql: bucket(0, NOW + 12 * MIN), rest: bucket(0, NOW + 31 * MIN) });
    expect(rateLimitWait([limited("cli"), limited("rest")], r, NOW)).toEqual({
      freeAt: { cli: NOW + 12 * MIN, rest: NOW + 31 * MIN },
      resumeAt: NOW + 12 * MIN,
    });
  });

  it("ignores transports that failed for another reason", () => {
    const r = gh({ graphql: bucket(0, NOW + 12 * MIN), rest: bucket(0, NOW + 3 * MIN) });
    const attempts: IssueFetchAttempt[] = [
      limited("cli"),
      { transport: "rest", reason: "auth", detail: "" },
    ];
    expect(rateLimitWait(attempts, r, NOW)).toEqual({
      freeAt: { cli: NOW + 12 * MIN },
      resumeAt: NOW + 12 * MIN,
    });
  });

  it("is null when no rate-limited transport has a known refill time", () => {
    expect(rateLimitWait([limited("cli")], gh(), NOW)).toBeNull();
  });
});

describe("isRateLimited", () => {
  it("is true when any transport gave up on a rate limit", () => {
    expect(isRateLimited([{ transport: "cli", reason: "auth", detail: "" }, limited("rest")])).toBe(
      true,
    );
  });

  it("is false for other failures and an empty trail", () => {
    expect(isRateLimited([{ transport: "cli", reason: "network", detail: "" }])).toBe(false);
    expect(isRateLimited([])).toBe(false);
  });
});
