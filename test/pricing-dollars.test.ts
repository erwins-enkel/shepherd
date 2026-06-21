import { test, expect } from "bun:test";
import { dollars, weightedUnits } from "../src/pricing";

// Hand-computed expected USD values from Anthropic list prices:
// Opus: $5/Mtok input, $25/Mtok output
// Sonnet: $3/Mtok input, $15/Mtok output

test("pure-input Opus 1M tokens → $5.00", () => {
  const c = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(dollars(c, "claude-opus-4-8")).toBe(5);
  expect(dollars(c, "claude-opus-4-8")).toBe(weightedUnits(c, "claude-opus-4-8"));
});

test("mixed Opus 1M input + 1M output → $30.00", () => {
  const c = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(dollars(c, "claude-opus-4-8")).toBe(5 + 25); // 30
  expect(dollars(c, "claude-opus-4-8")).toBe(weightedUnits(c, "claude-opus-4-8"));
});

test("Sonnet 2M output tokens → $30.00", () => {
  const c = { input: 0, output: 2_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(dollars(c, "claude-sonnet-4-6")).toBe(2 * 15); // 30
  expect(dollars(c, "claude-sonnet-4-6")).toBe(weightedUnits(c, "claude-sonnet-4-6"));
});
