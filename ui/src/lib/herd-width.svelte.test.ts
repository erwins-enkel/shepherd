import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() call
// at init doesn't touch a real or missing localStorage. (Mirrors
// sidebar-collapse.svelte.test.ts.)
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};
// @ts-expect-error stubbing global
globalThis.localStorage = localStorageMock;

import { herdWidth, clampHerdWidth, HERD_MIN, HERD_MAX } from "./herd-width.svelte";

const KEY = "shepherd:herd-width";

beforeEach(() => {
  localStorageMock.clear();
  herdWidth.reset();
  localStorageMock.clear(); // clear side-effect write from the reset above
});

// ---------------------------------------------------------------------------
// Pure clamp
// ---------------------------------------------------------------------------

describe("clampHerdWidth", () => {
  it("clamps below the minimum up to HERD_MIN", () => {
    expect(clampHerdWidth(100)).toBe(HERD_MIN);
    expect(clampHerdWidth(HERD_MIN - 1)).toBe(HERD_MIN);
  });

  it("clamps above the maximum down to HERD_MAX", () => {
    expect(clampHerdWidth(9999)).toBe(HERD_MAX);
    expect(clampHerdWidth(HERD_MAX + 1)).toBe(HERD_MAX);
  });

  it("passes through and rounds a value inside the range", () => {
    expect(clampHerdWidth(330)).toBe(330);
    expect(clampHerdWidth(330.6)).toBe(331);
  });

  it("keeps the exact bounds", () => {
    expect(clampHerdWidth(HERD_MIN)).toBe(HERD_MIN);
    expect(clampHerdWidth(HERD_MAX)).toBe(HERD_MAX);
  });
});

// ---------------------------------------------------------------------------
// Store: set / commit / reset / localStorage
// ---------------------------------------------------------------------------

describe("herdWidth store", () => {
  it("starts null (responsive default) with unset localStorage", () => {
    expect(herdWidth.width).toBe(null);
  });

  it("set() clamps and updates width without persisting", () => {
    herdWidth.set(400);
    expect(herdWidth.width).toBe(400);
    expect(store[KEY]).toBeUndefined();
  });

  it("set() clamps out-of-range values", () => {
    herdWidth.set(50);
    expect(herdWidth.width).toBe(HERD_MIN);
    herdWidth.set(5000);
    expect(herdWidth.width).toBe(HERD_MAX);
  });

  it("commit() persists the current width under the correct key", () => {
    herdWidth.set(420);
    herdWidth.commit();
    expect(store[KEY]).toBe("420");
  });

  it("commit() no-ops when width is null (never pins the default)", () => {
    expect(herdWidth.width).toBe(null);
    herdWidth.commit();
    expect(store[KEY]).toBeUndefined();
  });

  it("reset() clears width and removes the stored value", () => {
    herdWidth.set(500);
    herdWidth.commit();
    expect(store[KEY]).toBe("500");
    herdWidth.reset();
    expect(herdWidth.width).toBe(null);
    expect(store[KEY]).toBeUndefined();
  });
});
