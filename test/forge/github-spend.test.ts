/**
 * Tests for src/forge/github-spend.ts (#2840) — the in-query `rateLimit` parser, the measured
 * porcelain cost table, and the ledger that splits the GraphQL budget into the Shepherd server's
 * own spend and everything else on the account. The ledger's clock is injected.
 */
import { describe, it, expect } from "bun:test";
import {
  GraphqlSpendLedger,
  parseInQueryRateLimit,
  porcelainCost,
} from "../../src/forge/github-spend";

const RESET = Date.parse("2026-10-06T16:29:29Z");
const MIN = 60_000;

describe("parseInQueryRateLimit", () => {
  it("reads cost, used, remaining and resetAt from compact gh output", () => {
    const out =
      '{"data":{"viewer":{"login":"x"},"rateLimit":{"cost":3,"used":4857,"remaining":143,"resetAt":"2026-10-06T16:29:29Z"}}}';
    expect(parseInQueryRateLimit(out)).toEqual({
      cost: 3,
      used: 4857,
      remaining: 143,
      resetAt: RESET,
    });
  });

  it("tolerates pretty-printed output", () => {
    const out = `{\n  "data": {\n    "rateLimit": {\n      "cost": 1,\n      "used": 10,\n      "remaining": 4990,\n      "resetAt": "2026-10-06T16:29:29Z"\n    }\n  }\n}`;
    expect(parseInQueryRateLimit(out)?.used).toBe(10);
  });

  it("leaves cost and used null when the query didn't select them", () => {
    const out = '{"data":{"rateLimit":{"remaining":4000,"resetAt":"2026-10-06T16:29:29Z"}}}';
    expect(parseInQueryRateLimit(out)).toEqual({
      cost: null,
      used: null,
      remaining: 4000,
      resetAt: RESET,
    });
  });

  it("returns null without a usable reading", () => {
    expect(parseInQueryRateLimit('{"data":{"viewer":{"login":"x"}}}')).toBeNull();
    expect(parseInQueryRateLimit('{"data":{"rateLimit":{"remaining":1}}}')).toBeNull();
    expect(parseInQueryRateLimit("")).toBeNull();
  });

  it("never reads a rateLimit lookalike out of string content (an issue body)", () => {
    const body = JSON.stringify({
      data: {
        repository: {
          issue: { body: '"rateLimit":{"remaining":1,"resetAt":"2026-10-06T16:29:29Z"}' },
        },
      },
    });
    expect(parseInQueryRateLimit(body)).toBeNull();
  });
});

describe("porcelainCost — measured per-page costs (gh 2.93.0, dryRun)", () => {
  const snapshot = (limit: number) => [
    "pr",
    "list",
    "--repo",
    "o/r",
    "--state",
    "open",
    "--json",
    "number,url,statusCheckRollup,reviews,labels",
    "--limit",
    String(limit),
  ];
  const issues = (limit: number) => [
    "issue",
    "list",
    "--repo",
    "o/r",
    "--json",
    "number,title,body,labels,assignees",
    "--limit",
    String(limit),
  ];
  const rows = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i })));

  it("prices the open-PR snapshot by page size", () => {
    expect(porcelainCost(snapshot(20), "[]")).toBe(1);
    expect(porcelainCost(snapshot(30), "[]")).toBe(2);
    expect(porcelainCost(snapshot(50), "[]")).toBe(3);
    expect(porcelainCost(snapshot(100), "[]")).toBe(5);
  });

  it("prices issue lists by page size", () => {
    expect(porcelainCost(issues(50), "[]")).toBe(1);
    expect(porcelainCost(issues(100), "[]")).toBe(2);
  });

  it("charges every page a list fetched", () => {
    expect(porcelainCost(issues(200), rows(40))).toBe(2);
    expect(porcelainCost(issues(200), rows(150))).toBe(4);
    expect(porcelainCost(snapshot(200), rows(101))).toBe(10);
    // Unknown row count (a failed call): one page.
    expect(porcelainCost(issues(200), null)).toBe(2);
  });

  it("prices a --head lookup at 1 even with the snapshot's fields", () => {
    const head = [...snapshot(30), "--head", "shepherd/x"];
    expect(porcelainCost(head, "[]")).toBe(1);
  });

  it("prices a light list at 1 per page", () => {
    const numbers = ["pr", "list", "--repo", "o/r", "--json", "number", "--limit", "200"];
    expect(porcelainCost(numbers, rows(12))).toBe(1);
    expect(porcelainCost(numbers, rows(120))).toBe(2);
  });

  it("prices every other porcelain call at 1", () => {
    expect(porcelainCost(["pr", "view", "5", "--json", "state"], "{}")).toBe(1);
    expect(porcelainCost(["issue", "comment", "5", "--body", "x"], "")).toBe(1);
    expect(porcelainCost(["repo", "view", "o/r"], "{}")).toBe(1);
  });
});

function ledger() {
  let t = Date.parse("2026-10-06T15:40:30Z");
  const l = new GraphqlSpendLedger({ now: () => t });
  return { l, advance: (ms: number) => (t += ms) };
}

describe("GraphqlSpendLedger", () => {
  it("splits Δused between two readings into own spend and everything else", () => {
    const { l, advance } = ledger();
    l.noteReading({ used: 4857, resetAt: RESET });
    advance(30_000);
    l.noteOwnSpend(5);
    l.noteReading({ used: 5001, resetAt: RESET });
    const s = l.split();
    expect(s?.ownPoints).toBe(5);
    expect(s?.otherPoints).toBe(139);
    expect(s?.resetAt).toBe(RESET);
  });

  it("accumulates across readings and reports per-hour rates once 5 min are covered", () => {
    const { l, advance } = ledger();
    l.noteReading({ used: 1000, resetAt: RESET });
    advance(4 * MIN);
    l.noteOwnSpend(40);
    l.noteReading({ used: 1100, resetAt: RESET });
    expect(l.split()?.ownPerHour).toBeNull();
    expect(l.split()?.otherPerHour).toBeNull();
    advance(2 * MIN);
    l.noteOwnSpend(20);
    l.noteReading({ used: 1150, resetAt: RESET });
    const s = l.split()!;
    expect(s.ownPoints).toBe(60);
    expect(s.otherPoints).toBe(90);
    expect(s.ownPerHour).toBe(600); // 60 points over 6 min
    expect(s.otherPerHour).toBe(900);
  });

  it("starts a new tally when the window rolls over", () => {
    const { l, advance } = ledger();
    l.noteReading({ used: 100, resetAt: RESET });
    advance(MIN);
    l.noteOwnSpend(3);
    l.noteReading({ used: 200, resetAt: RESET });
    l.noteOwnSpend(2);
    const next = RESET + 60 * MIN;
    l.noteReading({ used: 2, resetAt: next });
    expect(l.split()).toMatchObject({ resetAt: next, ownPoints: 0, otherPoints: 0 });
  });

  it("restarts the tally when used goes backwards within a window", () => {
    const { l, advance } = ledger();
    l.noteReading({ used: 500, resetAt: RESET });
    advance(MIN);
    l.noteReading({ used: 400, resetAt: RESET });
    advance(MIN);
    l.noteOwnSpend(1);
    l.noteReading({ used: 410, resetAt: RESET });
    expect(l.split()).toMatchObject({ ownPoints: 1, otherPoints: 9 });
  });

  it("never reports negative foreign spend", () => {
    const { l, advance } = ledger();
    l.noteReading({ used: 100, resetAt: RESET });
    advance(MIN);
    l.noteOwnSpend(10); // an over-estimate: GitHub only charged 6
    l.noteReading({ used: 106, resetAt: RESET });
    expect(l.split()?.otherPoints).toBe(0);
  });

  it("has no split before a reading, or once the window has passed", () => {
    const { l, advance } = ledger();
    expect(l.split()).toBeNull();
    l.noteReading({ used: 100, resetAt: RESET });
    expect(l.split()).not.toBeNull();
    advance(RESET - Date.parse("2026-10-06T15:40:30Z"));
    expect(l.split()).toBeNull();
  });

  it("reports the foreign rate only with enough coverage", () => {
    const { l, advance } = ledger();
    l.noteReading({ used: 0, resetAt: RESET });
    advance(6 * MIN);
    l.noteReading({ used: 200, resetAt: RESET });
    expect(l.foreignPerHour(10 * MIN)).toBeNull();
    advance(6 * MIN);
    l.noteReading({ used: 400, resetAt: RESET });
    expect(l.foreignPerHour(10 * MIN)).toBe(2000);
  });
});
