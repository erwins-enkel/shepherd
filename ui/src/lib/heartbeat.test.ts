import { describe, it, expect } from "vitest";
import { bucketStrip, STRIP_CELLS, STRIP_WINDOW_MS } from "./heartbeat";

const NOW = 10_000_000;

describe("bucketStrip", () => {
  it("returns exactly STRIP_CELLS cells", () => {
    expect(bucketStrip([], [], NOW)).toHaveLength(STRIP_CELLS);
  });

  it("empty input → all level-0, no error, no now", () => {
    const cells = bucketStrip([], [], NOW);
    expect(cells.every((c) => c.level === 0 && !c.error && !c.now)).toBe(true);
  });

  it("the most recent event lands in the last (rightmost) cell and is marked now", () => {
    const cells = bucketStrip([NOW - 1_000], [], NOW);
    expect(cells[STRIP_CELLS - 1].level).toBe(1);
    expect(cells[STRIP_CELLS - 1].now).toBe(true);
    expect(cells.filter((c) => c.now)).toHaveLength(1);
  });

  it("the oldest in-window event lands at or near the first cell", () => {
    const ts = NOW - (STRIP_WINDOW_MS - 1); // just inside the window
    const cells = bucketStrip([ts], [], NOW);
    expect(cells[0].level).toBe(1);
  });

  it("events at or beyond the window, and future events, are dropped", () => {
    const cells = bucketStrip([NOW - STRIP_WINDOW_MS, NOW + 5_000, 0], [], NOW);
    expect(cells.every((c) => c.level === 0)).toBe(true);
  });

  it("level scales with count and caps at 4 (full 1→2→3→4 ladder)", () => {
    const t = NOW - 1_000; // all in the same (last) cell
    expect(bucketStrip([t], [], NOW)[STRIP_CELLS - 1].level).toBe(1);
    expect(bucketStrip([t, t], [], NOW)[STRIP_CELLS - 1].level).toBe(2);
    expect(bucketStrip([t, t, t], [], NOW)[STRIP_CELLS - 1].level).toBe(3);
    expect(bucketStrip([t, t, t, t, t, t], [], NOW)[STRIP_CELLS - 1].level).toBe(4);
  });

  it("a cell holding an errored ts is marked error", () => {
    const t = NOW - 1_000;
    const cells = bucketStrip([t], [t], NOW);
    expect(cells[STRIP_CELLS - 1].error).toBe(true);
  });

  it("error flag fires on a non-now middle cell, independent of the newest event", () => {
    const cellMs = STRIP_WINDOW_MS / STRIP_CELLS;
    const old = NOW - cellMs * 5; // a middle cell, not the newest
    const recent = NOW - 1_000; // newest → the now cell
    const cells = bucketStrip([old, recent], [old], NOW);
    const errored = cells.find((c) => c.error);
    expect(errored).toBeDefined();
    expect(errored!.now).toBe(false);
    expect(errored!.level).toBeGreaterThan(0);
  });
});
