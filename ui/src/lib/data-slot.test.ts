import { describe, expect, it } from "vitest";
import { DATA_SLOTS, dataSlot } from "./data-slot";

describe("dataSlot", () => {
  it("is stable for the same name", () => {
    expect(dataSlot("shepherd")).toBe(dataSlot("shepherd"));
  });

  it("always lands in 1..DATA_SLOTS, including the empty string", () => {
    const names = ["", "a", "shepherd", "herdr", "Ünïcødé", "x".repeat(500)];
    for (let i = 0; i < 200; i++) names.push(`repo-${i}`);
    for (const n of names) {
      const s = dataSlot(n);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(DATA_SLOTS);
    }
  });

  it("spreads names over every slot", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => dataSlot(`repo-${i}`)));
    expect(seen.size).toBe(DATA_SLOTS);
  });
});
