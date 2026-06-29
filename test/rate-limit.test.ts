/**
 * Tests for src/forge/rate-limit.ts — GraphQL bucket rate-limit tracking.
 *
 * Each test injects a deterministic clock (`now` option) so there is no
 * wall-clock dependency. The module singleton (`graphRateLimit`) is NOT
 * exercised here — we always construct a fresh instance with controlled opts.
 */
import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  GraphRateLimit,
  isGraphqlBucketCall,
  isRateLimitError,
  parseRetryAfter,
} from "../src/forge/rate-limit";

// ── GraphRateLimit: initial state ─────────────────────────────────────────────

describe("GraphRateLimit — initial state", () => {
  it("starts with all nulls and not blocked", () => {
    const rl = new GraphRateLimit();
    const snap = rl.snapshot();
    expect(snap.remaining).toBeNull();
    expect(snap.resetAt).toBeNull();
    expect(snap.pausedUntil).toBeNull();
    expect(snap.blocked).toBe(false);
    expect(rl.blocked()).toBe(false);
  });
});

// ── GraphRateLimit: note() — healthy reading ──────────────────────────────────

describe("GraphRateLimit — note() healthy reading (remaining >= floor)", () => {
  it("stores remaining and resetAt", () => {
    const rl = new GraphRateLimit({ now: () => 1_000_000 });
    rl.note({ remaining: 200, resetAt: 2_000_000 });
    const snap = rl.snapshot();
    expect(snap.remaining).toBe(200);
    expect(snap.resetAt).toBe(2_000_000);
  });

  it("clears an existing block when remaining >= floor", () => {
    const t = 1_000_000;
    const rl = new GraphRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    // Engage a block via error
    rl.noteLimitError();
    expect(rl.blocked()).toBe(true);
    // A healthy reading clears it
    rl.note({ remaining: 200, resetAt: 2_000_000 });
    expect(rl.blocked()).toBe(false);
    expect(rl.snapshot().pausedUntil).toBeNull();
  });

  it("does not block when remaining equals floor exactly", () => {
    const rl = new GraphRateLimit({ now: () => 0, floor: 100 });
    rl.note({ remaining: 100, resetAt: 9_999_999 });
    expect(rl.blocked()).toBe(false);
  });
});

// ── GraphRateLimit: note() — low reading (remaining < floor) ─────────────────

describe("GraphRateLimit — note() low reading (remaining < floor)", () => {
  it("sets pausedUntil = resetAt when below floor", () => {
    const rl = new GraphRateLimit({ now: () => 1_000_000 });
    rl.note({ remaining: 50, resetAt: 2_000_000 });
    expect(rl.snapshot().pausedUntil).toBe(2_000_000);
  });

  it("marks blocked when now() < pausedUntil", () => {
    const rl = new GraphRateLimit({ now: () => 1_000_000 });
    rl.note({ remaining: 50, resetAt: 2_000_000 });
    expect(rl.blocked()).toBe(true);
  });

  it("is NOT blocked when now() >= pausedUntil (time has passed)", () => {
    const t = 2_000_001;
    const rl = new GraphRateLimit({ now: () => t });
    rl.note({ remaining: 50, resetAt: 2_000_000 });
    expect(rl.blocked()).toBe(false);
  });

  it("takes max of existing pausedUntil and new resetAt (does not shorten)", () => {
    const rl = new GraphRateLimit({ now: () => 0 });
    // First error puts pausedUntil further in the future
    rl.noteLimitError(120); // 120 s = 120_000 ms → pausedUntil = 120_000
    expect(rl.snapshot().pausedUntil).toBe(120_000);
    // note() with a resetAt that is sooner — must NOT shorten
    rl.note({ remaining: 50, resetAt: 60_000 });
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });

  it("updates pausedUntil when new resetAt is later (extends cooldown)", () => {
    const rl = new GraphRateLimit({ now: () => 0 });
    rl.note({ remaining: 50, resetAt: 60_000 });
    rl.note({ remaining: 50, resetAt: 90_000 });
    expect(rl.snapshot().pausedUntil).toBe(90_000);
  });
});

// ── GraphRateLimit: noteLimitError() ─────────────────────────────────────────

describe("GraphRateLimit — noteLimitError()", () => {
  it("sets pausedUntil to now + defaultCooldownMs when no retryAfter given", () => {
    const rl = new GraphRateLimit({ now: () => 1_000_000, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    expect(rl.snapshot().pausedUntil).toBe(1_060_000);
  });

  it("uses retryAfterSec when supplied", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(90); // 90 seconds
    expect(rl.snapshot().pausedUntil).toBe(90_000);
  });

  it("takes max — does not shorten an existing later pausedUntil", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(120); // pausedUntil = 120_000
    rl.noteLimitError(30); // would set 30_000, must not shorten
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });

  it("extends pausedUntil when new value is later", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(30); // pausedUntil = 30_000
    rl.noteLimitError(120); // must extend to 120_000
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });

  it("marks blocked after noteLimitError", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    expect(rl.blocked()).toBe(true);
  });
});

// ── GraphRateLimit: snapshot() ────────────────────────────────────────────────

describe("GraphRateLimit — snapshot()", () => {
  it("reflects blocked=true when inside cooldown window", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    const snap = rl.snapshot();
    expect(snap.blocked).toBe(true);
    expect(snap.pausedUntil).toBe(60_000);
  });

  it("reflects blocked=false after the window elapses", () => {
    let t = 0;
    const rl = new GraphRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    t = 60_001;
    const snap = rl.snapshot();
    expect(snap.blocked).toBe(false);
  });
});

// ── GraphRateLimit: logging (edge-triggered, no spam) ────────────────────────

describe("GraphRateLimit — logging", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs once when transitioning from unblocked to blocked", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("[rate-limit]");
  });

  it("does NOT log again on a subsequent blocked call (no per-call spam)", () => {
    const rl = new GraphRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(); // transition → should log once
    warnSpy.mockClear();
    // Additional writes that don't change the blocked edge
    rl.noteLimitError(30); // shorter — no-op due to max, no new transition
    rl.blocked();
    rl.snapshot();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs once when the block clears (blocked→unblocked edge)", () => {
    let t = 0;
    const rl = new GraphRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError(); // blocked
    warnSpy.mockClear();
    t = 30_000; // still WITHIN the cooldown window → blocked() is true
    // Trigger a healthy reading while actively blocked → clears
    rl.note({ remaining: 200, resetAt: 999_999 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("[rate-limit]");
  });

  it("logs 'engaged' on re-engagement after natural expiry", () => {
    let t = 0;
    const rl = new GraphRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError(); // first engagement at t=0
    warnSpy.mockClear();
    t = 70_000; // advance past expiry — blocked() is now false
    // Re-engage after natural expiry: must log "engaged" again
    rl.noteLimitError();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("[rate-limit]");
    expect(msg).toContain("engaged");
  });

  it("does NOT log 'cleared' when healthy note() arrives after natural expiry", () => {
    let t = 0;
    const rl = new GraphRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError(); // engaged
    warnSpy.mockClear();
    t = 70_000; // advance past expiry — natural cooldown elapsed
    rl.note({ remaining: 200, resetAt: 999_999 }); // healthy, but block already elapsed
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── isGraphqlBucketCall() ─────────────────────────────────────────────────────

describe("isGraphqlBucketCall()", () => {
  // gh api graphql → GraphQL bucket
  it("returns true for ['api','graphql',...]", () => {
    expect(isGraphqlBucketCall(["api", "graphql", "-f", "query=..."])).toBe(true);
  });

  // gh api <rest-path> → REST bucket, must be false
  it("returns false for ['api','repos/o/r/issues']", () => {
    expect(isGraphqlBucketCall(["api", "repos/o/r/issues"])).toBe(false);
  });

  it("returns false for ['api'] with no second arg", () => {
    expect(isGraphqlBucketCall(["api"])).toBe(false);
  });

  // gh pr / issue / repo / search → GraphQL-backed
  it("returns true for ['pr',...]", () => {
    expect(isGraphqlBucketCall(["pr", "list"])).toBe(true);
  });

  it("returns true for ['issue',...]", () => {
    expect(isGraphqlBucketCall(["issue", "list"])).toBe(true);
  });

  it("returns true for ['repo',...]", () => {
    expect(isGraphqlBucketCall(["repo", "view"])).toBe(true);
  });

  it("returns true for ['search',...]", () => {
    expect(isGraphqlBucketCall(["search", "issues", "..."])).toBe(true);
  });

  // gh run → REST bucket, must be false
  it("returns false for ['run',...]", () => {
    expect(isGraphqlBucketCall(["run", "list"])).toBe(false);
  });

  it("returns false for unknown subcommand", () => {
    expect(isGraphqlBucketCall(["release", "list"])).toBe(false);
  });

  it("returns false for empty args", () => {
    expect(isGraphqlBucketCall([])).toBe(false);
  });
});

// ── isRateLimitError() ────────────────────────────────────────────────────────

describe("isRateLimitError()", () => {
  it("matches 'rate limit' in err.stderr", () => {
    expect(isRateLimitError({ stderr: "API rate limit exceeded" })).toBe(true);
  });

  it("matches 'rate_limited' in err.message", () => {
    expect(isRateLimitError({ message: "You are rate_limited by secondary quota" })).toBe(true);
  });

  it("matches 'secondary rate limit'", () => {
    expect(isRateLimitError({ stderr: "secondary rate limit reached" })).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isRateLimitError({ stderr: "RATE LIMIT EXCEEDED" })).toBe(true);
  });

  it("returns false for an unrelated error", () => {
    expect(isRateLimitError({ stderr: "not found", message: "404" })).toBe(false);
  });

  it("handles plain string errors via String(err)", () => {
    expect(isRateLimitError("rate limit exceeded")).toBe(true);
  });

  it("handles Error objects", () => {
    expect(isRateLimitError(new Error("rate limit hit"))).toBe(true);
  });

  it("returns false for non-rate-limit Error", () => {
    expect(isRateLimitError(new Error("network timeout"))).toBe(false);
  });
});

// ── parseRetryAfter() ─────────────────────────────────────────────────────────

describe("parseRetryAfter()", () => {
  it("parses 'Retry-After: 60'", () => {
    expect(parseRetryAfter("Retry-After: 60")).toBe(60);
  });

  it("parses 'retry after 120'", () => {
    expect(parseRetryAfter("retry after 120")).toBe(120);
  });

  it("parses 'retry-after:30' (no space after colon)", () => {
    expect(parseRetryAfter("retry-after:30")).toBe(30);
  });

  it("parses embedded value in longer text", () => {
    expect(parseRetryAfter("You are rate limited. Retry-After: 45 seconds")).toBe(45);
  });

  it("returns undefined when not present", () => {
    expect(parseRetryAfter("something went wrong")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseRetryAfter("")).toBeUndefined();
  });
});
