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
