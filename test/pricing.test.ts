import { test, expect } from "bun:test";
import { cacheWriteUnits } from "../src/pricing";

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
