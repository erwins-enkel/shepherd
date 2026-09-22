import { test, expect } from "bun:test";
import {
  cacheWriteUnits,
  coldResumeUnits,
  weightedUnits,
  WARM_PREFIX_TOKENS,
} from "../src/pricing";

test("cacheWriteUnits — opus 5m-only: 1M tokens = 6.25 units", () => {
  expect(cacheWriteUnits({ cacheWrite5m: 1_000_000, cacheWrite1h: 0 }, "claude-opus-4-8")).toBe(
    6.25,
  );
});

test("cacheWriteUnits — opus 1h-only: 1M tokens = 10 units", () => {
  expect(cacheWriteUnits({ cacheWrite5m: 0, cacheWrite1h: 1_000_000 }, "claude-opus-4-8")).toBe(10);
});

test("cacheWriteUnits — both zero → 0 (no contamination from other kinds)", () => {
  expect(cacheWriteUnits({ cacheWrite5m: 0, cacheWrite1h: 0 }, "claude-opus-4-8")).toBe(0);
});

test("weightsFor — sentinel id like <synthetic> defaults silently, real unknown id warns once", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));
  try {
    // Sentinel ids fall back to default weights without a warning.
    cacheWriteUnits({ cacheWrite5m: 0, cacheWrite1h: 0 }, "<synthetic>");
    expect(warns).toHaveLength(0);
    // A genuinely-unknown real model id still warns (regression watchdog intact).
    cacheWriteUnits({ cacheWrite5m: 0, cacheWrite1h: 0 }, "totally-made-up-model-x");
    expect(warns.some((w) => w.includes("totally-made-up-model-x"))).toBe(true);
  } finally {
    console.warn = orig;
  }
});

// ── Fable cache-read split (Fable 5 vs 5.1) ─────────────────────────────────
// Fable 5.1 lists cache reads at $0.25/Mtok; Fable 5 charged $1. Both share
// $10/$50 in/out and the same cache-WRITE rates, so cache read is the only
// number that can go wrong — and it is the dominant token class in long
// sessions, so a wrong weight visibly corrupts /usage money.
const cacheRead = (model: string) =>
  weightedUnits(
    { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0 },
    model,
  );

test("cache read — pinned Fable 5.1 id costs $0.25/Mtok", () => {
  expect(cacheRead("claude-fable-5-1")).toBe(0.25);
});

test("cache read — the floating `fable` alias is priced as the CURRENT Fable (5.1)", () => {
  // The alias resolves to whatever the CLI calls the latest Fable, so pricing it
  // at the retired Fable 5 rate would overstate every new session 4x.
  expect(cacheRead("fable")).toBe(0.25);
});

test("cache read — retired Fable 5 records keep their own $1/Mtok rate", () => {
  expect(cacheRead("claude-fable-5")).toBe(1);
  // Provider-prefixed forms end in `-5` too and must land on the same row.
  expect(cacheRead("us.anthropic.claude-fable-5")).toBe(1);
});

test("cache read — the anchored `-5` row does not swallow later Fable ids", () => {
  // `/fable-5$/i` must not match `claude-fable-5-1`; an unknown future id falls
  // through to the current-generation row, not to the retired prices.
  expect(cacheRead("claude-fable-5-1")).not.toBe(cacheRead("claude-fable-5"));
  expect(cacheRead("claude-fable-6")).toBe(0.25);
});

test("Fable in/out and cache-write rates are identical across both rows", () => {
  const bundle = {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite5m: 1_000_000,
    cacheWrite1h: 1_000_000,
  };
  expect(weightedUnits(bundle, "claude-fable-5-1")).toBe(weightedUnits(bundle, "claude-fable-5"));
  expect(cacheWriteUnits({ cacheWrite5m: 1_000_000, cacheWrite1h: 0 }, "claude-fable-5-1")).toBe(
    12.5,
  );
});

// ── Opus 5.5 ────────────────────────────────────────────────────────────────
// Opus 5.5 lists at $4/$20 with cache reads at 5% of input, against the $5/$25 + 10% the earlier
// Opus generation charges. The generic /opus/i row would swallow it and overstate every record by
// 25%, so the narrower row's PLACEMENT and its MATCH SHAPE are both load-bearing.

/** One Mtok of every token class — a fingerprint of the whole weight row, so a test comparing two
 *  ids proves they landed on the SAME row rather than merely agreeing on one number. */
const allClasses = (model: string) =>
  weightedUnits(
    {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
    },
    model,
  );

test("Opus 5.5 prices at $4 in / $20 out / $0.20 cache read per Mtok", () => {
  expect(
    weightedUnits(
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      "claude-opus-5-5",
    ),
  ).toBe(4);
  expect(
    weightedUnits(
      { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      "claude-opus-5-5",
    ),
  ).toBe(20);
  expect(cacheRead("claude-opus-5-5")).toBe(0.2);
  expect(cacheWriteUnits({ cacheWrite5m: 1_000_000, cacheWrite1h: 0 }, "claude-opus-5-5")).toBe(5);
  expect(cacheWriteUnits({ cacheWrite5m: 0, cacheWrite1h: 1_000_000 }, "claude-opus-5-5")).toBe(8);
});

test("Opus 5.5 — the dated, -v1 and provider-prefixed wire ids all price the same", () => {
  // These are the shapes that actually reach weightsFor: usage.ts reads `message.model` off a
  // transcript record, and a `$`-anchored match would drop every one onto the generic Opus row.
  const base = allClasses("claude-opus-5-5");
  for (const id of [
    "claude-opus-5-5-20260922",
    "claude-opus-5-5-20260922-v1",
    "claude-opus-5-5-v1",
    "us.anthropic.claude-opus-5-5",
    "anthropic.claude-opus-5-5",
    "claude-opus-5-5@20260922",
  ])
    expect(allClasses(id)).toBe(base);
});

test("Opus 5.5 — the row does not swallow other Opus ids", () => {
  const opus5 = allClasses("claude-opus-5");
  expect(allClasses("claude-opus-5-5")).not.toBe(opus5);
  // Earlier/other generations keep the $5/$25 row, dated forms included.
  for (const id of ["claude-opus-5", "claude-opus-5-20260401", "claude-opus-4-8", "opus"])
    expect(allClasses(id)).toBe(opus5);
  // The lookahead is what keeps a longer numeric suffix off the 5.5 price.
  expect(allClasses("claude-opus-5-50")).toBe(opus5);
});

test("an unknown model still prices sonnet-like after the Opus 5.5 row was inserted", () => {
  // DEFAULT used to be read out of TABLE by INDEX, so inserting any row above sonnet silently
  // repriced every unrecognised model. It is a named constant now; this pins that.
  const unknown = {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  expect(weightedUnits(unknown, "totally-unknown-model")).toBe(3 + 15);
  expect(weightedUnits(unknown, "claude-sonnet-5")).toBe(3 + 15);
  expect(weightedUnits(unknown, "<synthetic>")).toBe(3 + 15);
});

// ── coldResumeUnits (#2042) ─────────────────────────────────────────────────
// The estimate behind the HUD's cold-resume marker. Its accuracy is what makes showing a NUMBER
// defensible rather than a bare warning icon, so the arithmetic is pinned exactly.

test("coldResumeUnits — 180k opus on the 1h TTL: 24k re-read + 156k re-written", () => {
  // 24_000 * 0.5 + 156_000 * 10 = 1_572_000 → 1.572 units.
  expect(coldResumeUnits(180_000, "claude-opus-5", "1h")).toBeCloseTo(1.572, 6);
});

test("coldResumeUnits — the same context WARM costs ~17x less", () => {
  const warm = weightedUnits(
    { input: 0, output: 0, cacheRead: 180_000, cacheWrite5m: 0, cacheWrite1h: 0 },
    "claude-opus-5",
  );
  expect(warm).toBeCloseTo(0.09, 6);
  expect(coldResumeUnits(180_000, "claude-opus-5", "1h") / warm).toBeGreaterThan(17);
});

test("coldResumeUnits — the 5m TTL is cheaper than 1h for the same context", () => {
  // api-key mode gets the five-minute TTL, whose write rate is 6.25 vs 10 on opus.
  // 24_000 * 0.5 + 156_000 * 6.25 = 987_000 → 0.987 units.
  expect(coldResumeUnits(180_000, "claude-opus-5", "5m")).toBeCloseTo(0.987, 6);
  expect(coldResumeUnits(180_000, "claude-opus-5", "5m")).toBeLessThan(
    coldResumeUnits(180_000, "claude-opus-5", "1h"),
  );
});

test("coldResumeUnits — context at or below the warm prefix prices ENTIRELY at the read rate", () => {
  // No negative remainder, and the TTL cannot matter when nothing is rewritten.
  expect(coldResumeUnits(WARM_PREFIX_TOKENS, "claude-opus-5", "1h")).toBeCloseTo(0.012, 6);
  expect(coldResumeUnits(10_000, "claude-opus-5", "1h")).toBe(
    coldResumeUnits(10_000, "claude-opus-5", "5m"),
  );
  expect(coldResumeUnits(10_000, "claude-opus-5", "1h")).toBeCloseTo(0.005, 6);
});

test("coldResumeUnits — zero/negative context is free, never NaN", () => {
  expect(coldResumeUnits(0, "claude-opus-5", "1h")).toBe(0);
  expect(coldResumeUnits(-1, "claude-opus-5", "1h")).toBe(0);
});

test("coldResumeUnits — the SAME context costs different money per model", () => {
  // Why the marker's floor is a unit threshold, not a token count: 150k context is 1.272 units on
  // opus but 0.2544 on haiku — a token-count floor would mean a ~5x different amount of money.
  expect(coldResumeUnits(150_000, "claude-opus-5", "1h")).toBeCloseTo(1.272, 6);
  expect(coldResumeUnits(150_000, "claude-haiku-4-5-20251001", "1h")).toBeCloseTo(0.2544, 6);
  expect(coldResumeUnits(150_000, "claude-fable-5-1", "1h")).toBeCloseTo(2.526, 6);
});
