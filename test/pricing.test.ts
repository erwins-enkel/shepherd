import { test, expect } from "bun:test";
import { cacheWriteUnits, weightedUnits } from "../src/pricing";

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
