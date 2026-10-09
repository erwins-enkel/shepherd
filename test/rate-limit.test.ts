/**
 * Tests for src/forge/rate-limit.ts — per-bucket (GraphQL / REST) rate-limit tracking.
 *
 * Each test injects a deterministic clock (`now` option) so there is no
 * wall-clock dependency. The module singleton (`graphRateLimit`) is NOT
 * exercised here — we always construct a fresh instance with controlled opts.
 */
import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  BucketRateLimit,
  ghCallSummary,
  isGraphqlBucketCall,
  isRestBucketCall,
  isRestReadCall,
  isRateLimitError,
  parseRetryAfter,
} from "../src/forge/rate-limit";

// ── BucketRateLimit: initial state ─────────────────────────────────────────────

describe("BucketRateLimit — initial state", () => {
  it("starts with all nulls and not blocked", () => {
    const rl = new BucketRateLimit();
    const snap = rl.snapshot();
    expect(snap.remaining).toBeNull();
    expect(snap.resetAt).toBeNull();
    expect(snap.pausedUntil).toBeNull();
    expect(snap.blocked).toBe(false);
    expect(rl.blocked()).toBe(false);
  });
});

// ── BucketRateLimit: note() — healthy reading ──────────────────────────────────

describe("BucketRateLimit — note() healthy reading (remaining >= floor)", () => {
  it("stores remaining and resetAt", () => {
    const rl = new BucketRateLimit({ now: () => 1_000_000 });
    rl.note({ remaining: 200, resetAt: 2_000_000 });
    const snap = rl.snapshot();
    expect(snap.remaining).toBe(200);
    expect(snap.resetAt).toBe(2_000_000);
  });

  it("clears an existing block when remaining >= floor", () => {
    const t = 1_000_000;
    const rl = new BucketRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    // Engage a block via error
    rl.noteLimitError();
    expect(rl.blocked()).toBe(true);
    // A healthy reading clears it
    rl.note({ remaining: 200, resetAt: 2_000_000 });
    expect(rl.blocked()).toBe(false);
    expect(rl.snapshot().pausedUntil).toBeNull();
  });

  it("does not block when remaining equals floor exactly", () => {
    const rl = new BucketRateLimit({ now: () => 0, floor: 100 });
    rl.note({ remaining: 100, resetAt: 9_999_999 });
    expect(rl.blocked()).toBe(false);
  });
});

// ── BucketRateLimit: note() — low reading (remaining < floor) ─────────────────

describe("BucketRateLimit — note() low reading (remaining < floor)", () => {
  it("sets pausedUntil = resetAt when below floor", () => {
    const rl = new BucketRateLimit({ now: () => 1_000_000 });
    rl.note({ remaining: 50, resetAt: 2_000_000 });
    expect(rl.snapshot().pausedUntil).toBe(2_000_000);
  });

  it("marks blocked when now() < pausedUntil", () => {
    const rl = new BucketRateLimit({ now: () => 1_000_000 });
    rl.note({ remaining: 50, resetAt: 2_000_000 });
    expect(rl.blocked()).toBe(true);
  });

  it("is NOT blocked when now() >= pausedUntil (time has passed)", () => {
    const t = 2_000_001;
    const rl = new BucketRateLimit({ now: () => t });
    rl.note({ remaining: 50, resetAt: 2_000_000 });
    expect(rl.blocked()).toBe(false);
  });

  it("takes max of existing pausedUntil and new resetAt (does not shorten)", () => {
    const rl = new BucketRateLimit({ now: () => 0 });
    // First error puts pausedUntil further in the future
    rl.noteLimitError(120); // 120 s = 120_000 ms → pausedUntil = 120_000
    expect(rl.snapshot().pausedUntil).toBe(120_000);
    // note() with a resetAt that is sooner — must NOT shorten
    rl.note({ remaining: 50, resetAt: 60_000 });
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });

  it("updates pausedUntil when new resetAt is later (extends cooldown)", () => {
    const rl = new BucketRateLimit({ now: () => 0 });
    rl.noteLimitError(30); // pausedUntil = 30_000
    rl.note({ remaining: 50, resetAt: 90_000 });
    expect(rl.snapshot().pausedUntil).toBe(90_000);
  });
});

// ── BucketRateLimit: note() — readings from another counter (#2840) ───────────

describe("BucketRateLimit — note() ignores another counter's window (#2840)", () => {
  const WINDOW = 3_600_000;
  const OTHER = 600_000;
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("ignores a reading of another window while the current one is live", () => {
    const rl = new BucketRateLimit({ now: () => 1_000 });
    expect(rl.note({ remaining: 344, resetAt: WINDOW })).toBe(true);
    const before = rl.snapshot();
    expect(rl.note({ remaining: 4842, resetAt: OTHER })).toBe(false);
    expect(rl.snapshot()).toEqual(before);
  });

  it("a low reading from another counter neither engages nor clears the backoff", () => {
    const rl = new BucketRateLimit({ now: () => 1_000 });
    rl.note({ remaining: 4000, resetAt: WINDOW });
    rl.note({ remaining: 5, resetAt: OTHER });
    expect(rl.blocked()).toBe(false);
    rl.note({ remaining: 50, resetAt: WINDOW });
    expect(rl.blocked()).toBe(true);
    rl.note({ remaining: 4900, resetAt: OTHER });
    expect(rl.blocked()).toBe(true);
    expect(rl.snapshot().pausedUntil).toBe(WINDOW);
  });

  it("treats resetAts a few seconds apart as the same window", () => {
    const rl = new BucketRateLimit({ now: () => 1_000 });
    rl.note({ remaining: 4000, resetAt: WINDOW });
    expect(rl.note({ remaining: 3990, resetAt: WINDOW + 2_000 })).toBe(true);
    expect(rl.snapshot().remaining).toBe(3990);
  });

  it("adopts the next window once the current one has passed", () => {
    let t = 1_000;
    const rl = new BucketRateLimit({ now: () => t });
    rl.note({ remaining: 200, resetAt: WINDOW });
    t = WINDOW + 1;
    expect(rl.note({ remaining: 4990, resetAt: 2 * WINDOW })).toBe(true);
    expect(rl.snapshot().resetAt).toBe(2 * WINDOW);
  });

  it("adopts another window after 3 readings in a row agree on it, not after 2", () => {
    const rl = new BucketRateLimit({ now: () => 1_000 });
    rl.note({ remaining: 4842, resetAt: OTHER }); // locked onto the outlier first
    expect(rl.note({ remaining: 344, resetAt: WINDOW })).toBe(false);
    expect(rl.note({ remaining: 340, resetAt: WINDOW })).toBe(false);
    expect(rl.snapshot().resetAt).toBe(OTHER);
    expect(rl.note({ remaining: 336, resetAt: WINDOW })).toBe(true);
    expect(rl.snapshot()).toMatchObject({ remaining: 336, resetAt: WINDOW });
  });

  it("a reading of the current window breaks the streak", () => {
    const rl = new BucketRateLimit({ now: () => 1_000 });
    rl.note({ remaining: 4000, resetAt: WINDOW });
    rl.note({ remaining: 4842, resetAt: OTHER });
    rl.note({ remaining: 4842, resetAt: OTHER });
    rl.note({ remaining: 3990, resetAt: WINDOW });
    expect(rl.note({ remaining: 4842, resetAt: OTHER })).toBe(false);
    expect(rl.snapshot().resetAt).toBe(WINDOW);
  });

  it("logs the first ignored reading of a counter once", () => {
    const rl = new BucketRateLimit({ now: () => 1_000 });
    rl.note({ remaining: 4000, resetAt: WINDOW });
    rl.note({ remaining: 4842, resetAt: OTHER });
    rl.note({ remaining: 3990, resetAt: WINDOW });
    rl.note({ remaining: 4842, resetAt: OTHER });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ignoring a reading from another counter");
  });
});

// ── BucketRateLimit: noteLimitError() ─────────────────────────────────────────

describe("BucketRateLimit — noteLimitError()", () => {
  it("sets pausedUntil to now + defaultCooldownMs when no retryAfter given", () => {
    const rl = new BucketRateLimit({ now: () => 1_000_000, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    expect(rl.snapshot().pausedUntil).toBe(1_060_000);
  });

  it("uses retryAfterSec when supplied", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(90); // 90 seconds
    expect(rl.snapshot().pausedUntil).toBe(90_000);
  });

  it("takes max — does not shorten an existing later pausedUntil", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(120); // pausedUntil = 120_000
    rl.noteLimitError(30); // would set 30_000, must not shorten
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });

  it("extends pausedUntil when new value is later", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError(30); // pausedUntil = 30_000
    rl.noteLimitError(120); // must extend to 120_000
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });

  it("marks blocked after noteLimitError", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    expect(rl.blocked()).toBe(true);
  });
});

// ── BucketRateLimit: snapshot() ────────────────────────────────────────────────

describe("BucketRateLimit — snapshot()", () => {
  it("reflects blocked=true when inside cooldown window", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    const snap = rl.snapshot();
    expect(snap.blocked).toBe(true);
    expect(snap.pausedUntil).toBe(60_000);
  });

  it("reflects blocked=false after the window elapses", () => {
    let t = 0;
    const rl = new BucketRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    t = 60_001;
    const snap = rl.snapshot();
    expect(snap.blocked).toBe(false);
  });
});

// ── BucketRateLimit: logging (edge-triggered, no spam) ────────────────────────

describe("BucketRateLimit — logging", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs once when transitioning from unblocked to blocked", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("[rate-limit]");
  });

  it("does NOT log again on a subsequent blocked call (no per-call spam)", () => {
    const rl = new BucketRateLimit({ now: () => 0, defaultCooldownMs: 60_000 });
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
    const rl = new BucketRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
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
    const rl = new BucketRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
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

  it("appends the cause to the 'engaged' line, and logs the plain line without one (#2805)", () => {
    let t = 0;
    const rl = new BucketRateLimit({ now: () => t, label: "REST write" });
    rl.noteLimitError(undefined, "gh run rerun: gh: API rate limit exceeded (HTTP 403)");
    expect(String(warnSpy.mock.calls[0]?.[0])).toBe(
      "[rate-limit] REST write backoff engaged until 1970-01-01T00:01:00.000Z — gh run rerun: gh: API rate limit exceeded (HTTP 403)",
    );
    t = 70_000; // natural expiry
    rl.noteLimitError(30, undefined);
    expect(String(warnSpy.mock.calls[1]?.[0])).toBe(
      "[rate-limit] REST write backoff engaged until 1970-01-01T00:01:40.000Z",
    );
  });

  it("does NOT log 'cleared' when healthy note() arrives after natural expiry", () => {
    let t = 0;
    const rl = new BucketRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError(); // engaged
    warnSpy.mockClear();
    t = 70_000; // advance past expiry — natural cooldown elapsed
    rl.note({ remaining: 200, resetAt: 999_999 }); // healthy, but block already elapsed
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── BucketRateLimit: REST bucket — label + escalating cooldown (#2656) ───────

describe("BucketRateLimit — REST bucket (label + escalation)", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const rest = (now: () => number) =>
    new BucketRateLimit({
      now,
      label: "REST",
      defaultCooldownMs: 60_000,
      maxCooldownMs: 900_000,
    });

  it("names its bucket in the edge logs", () => {
    const rl = rest(() => 0);
    rl.noteLimitError();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[rate-limit] REST backoff engaged until");
  });

  it("doubles the cooldown each time the window lapses into another limit error, up to the cap", () => {
    // gh surfaces no reset time and `gh api rate_limit` lies (reports a full bucket while
    // every real call 403s), so the only signal is "the probe after the window failed again".
    let t = 0;
    const rl = rest(() => t);
    const windows: number[] = [];
    for (let i = 0; i < 6; i++) {
      rl.noteLimitError();
      const until = rl.snapshot().pausedUntil!;
      windows.push(until - t);
      t = until; // window lapses; the next call is the probe
    }
    expect(windows).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it("concurrent failures inside one window do not escalate", () => {
    const rl = rest(() => 0);
    rl.noteLimitError();
    rl.noteLimitError();
    rl.noteLimitError();
    expect(rl.snapshot().pausedUntil).toBe(60_000);
  });

  it("a success clears the backoff and resets the escalation", () => {
    let t = 0;
    const rl = rest(() => t);
    rl.noteLimitError();
    t = 60_000;
    rl.noteLimitError(); // second strike → 120s
    t = 70_000;
    rl.noteSuccess();
    expect(rl.blocked()).toBe(false);
    rl.noteLimitError();
    expect(rl.snapshot().pausedUntil).toBe(70_000 + 60_000);
  });

  it("an explicit Retry-After wins over the escalation", () => {
    const rl = rest(() => 0);
    rl.noteLimitError(30);
    expect(rl.snapshot().pausedUntil).toBe(30_000);
  });

  it("without maxCooldownMs there is no escalation (the GraphQL default is unchanged)", () => {
    let t = 0;
    const rl = new BucketRateLimit({ now: () => t, defaultCooldownMs: 60_000 });
    rl.noteLimitError();
    t = 60_000;
    rl.noteLimitError();
    expect(rl.snapshot().pausedUntil).toBe(120_000);
  });
});

// ── isRestBucketCall() / isRestReadCall() (#2656) ─────────────────────────────

describe("isRestBucketCall()", () => {
  it("is true for gh api <rest-path>, with or without leading flags", () => {
    expect(isRestBucketCall(["api", "repos/o/r/git/matching-refs/heads/epic/"])).toBe(true);
    expect(
      isRestBucketCall(["api", "--method", "GET", "repos/o/r/issues", "-f", "state=open"]),
    ).toBe(true);
    expect(isRestBucketCall(["api", "--paginate", "--slurp", "repos/o/r/pulls/1/reviews"])).toBe(
      true,
    );
  });

  it("is true for gh run / gh workflow", () => {
    expect(isRestBucketCall(["run", "list", "--repo", "o/r"])).toBe(true);
    expect(isRestBucketCall(["workflow", "run", "deploy.yml"])).toBe(true);
  });

  it("is false for GraphQL, the limit-exempt rate_limit endpoint, and GraphQL subcommands", () => {
    expect(isRestBucketCall(["api", "graphql", "-f", "query=..."])).toBe(false);
    expect(isRestBucketCall(["api", "rate_limit"])).toBe(false);
    expect(isRestBucketCall(["issue", "list", "--repo", "o/r"])).toBe(false);
    expect(isRestBucketCall(["pr", "list"])).toBe(false);
    expect(isRestBucketCall([])).toBe(false);
  });
});

describe("isRestReadCall()", () => {
  it("is true for a GET — explicit, or implied by gh api with no fields", () => {
    expect(isRestReadCall(["api", "--method", "GET", "repos/o/r/issues", "-f", "page=1"])).toBe(
      true,
    );
    expect(isRestReadCall(["api", "repos/o/r/git/ref/heads/main"])).toBe(true);
    expect(isRestReadCall(["api", "-X", "GET", "repos/o/r/pulls"])).toBe(true);
  });

  it("is false for writes — explicit method, or gh api's POST default once fields are passed", () => {
    expect(isRestReadCall(["api", "--method", "POST", "repos/o/r/git/refs", "-f", "ref=x"])).toBe(
      false,
    );
    expect(isRestReadCall(["api", "repos/o/r/issues/1/labels", "-f", "labels[]=x"])).toBe(false);
    expect(isRestReadCall(["api", "-X", "PUT", "repos/o/r/pulls/1/merge"])).toBe(false);
  });

  it("covers gh run list/view as reads and nothing else", () => {
    expect(isRestReadCall(["run", "list", "--repo", "o/r"])).toBe(true);
    expect(isRestReadCall(["run", "view", "1", "--log-failed"])).toBe(true);
    expect(isRestReadCall(["run", "rerun", "1"])).toBe(false);
    expect(isRestReadCall(["api", "graphql", "-f", "query=..."])).toBe(false);
    expect(isRestReadCall(["issue", "list"])).toBe(false);
  });
});

describe("ghCallSummary() (#2805)", () => {
  it("names a gh api call by the method gh will send and its endpoint", () => {
    expect(ghCallSummary(["api", "repos/o/r/git/ref/heads/main"])).toBe(
      "gh api GET repos/o/r/git/ref/heads/main",
    );
    expect(ghCallSummary(["api", "--method", "GET", "repos/o/r/issues", "-f", "page=1"])).toBe(
      "gh api GET repos/o/r/issues",
    );
    expect(ghCallSummary(["api", "repos/o/r/stacks", "-F", "pull_requests[]=9"])).toBe(
      "gh api POST repos/o/r/stacks",
    );
    expect(ghCallSummary(["api", "-X", "patch", "repos/o/r/issues/1", "-f", "title=x"])).toBe(
      "gh api PATCH repos/o/r/issues/1",
    );
  });

  it("names any other call by subcommand and action", () => {
    expect(ghCallSummary(["run", "rerun", "42", "--repo", "o/r", "--failed"])).toBe("gh run rerun");
    expect(ghCallSummary(["workflow", "run", "deploy.yml", "--ref", "main"])).toBe(
      "gh workflow run",
    );
    expect(ghCallSummary(["pr", "--repo", "o/r"])).toBe("gh pr");
  });

  it("never includes a flag value", () => {
    const out = ghCallSummary([
      "api",
      "-H",
      "X-Secret: s3cret",
      "repos/o/r/issues",
      "-f",
      "body=hi",
    ]);
    expect(out).toBe("gh api POST repos/o/r/issues");
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
