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
