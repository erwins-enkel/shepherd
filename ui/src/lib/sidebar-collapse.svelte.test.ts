import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() call
// at init doesn't touch a real or missing localStorage.
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

import { sidebarCollapse, sidebarShouldCollapse } from "./sidebar-collapse.svelte";

const KEY = "shepherd:sidebar-collapsed";

beforeEach(() => {
  localStorageMock.clear();
  // Reset the store state to false (mirrors a fresh/unset localStorage)
  sidebarCollapse.set(false);
  localStorageMock.clear(); // clear side-effect write from the reset above
});

// ---------------------------------------------------------------------------
// Predicate truth table
// ---------------------------------------------------------------------------

describe("sidebarShouldCollapse", () => {
  it("returns true only for touch=true, mobile=false, collapsed=true", () => {
    expect(sidebarShouldCollapse(true, false, true)).toBe(true);
  });

  it("returns false for mouse-primary desktop (touch=false)", () => {
    expect(sidebarShouldCollapse(false, false, true)).toBe(false);
    expect(sidebarShouldCollapse(false, true, true)).toBe(false);
    expect(sidebarShouldCollapse(false, false, false)).toBe(false);
    expect(sidebarShouldCollapse(false, true, false)).toBe(false);
  });

  it("returns false for phone (touch=true, mobile=true)", () => {
    expect(sidebarShouldCollapse(true, true, true)).toBe(false);
    expect(sidebarShouldCollapse(true, true, false)).toBe(false);
  });

  it("returns false when not opted in (collapsed=false)", () => {
    expect(sidebarShouldCollapse(true, false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store: toggle / set / localStorage
// ---------------------------------------------------------------------------

describe("sidebarCollapse store", () => {
  it("toggle flips collapsed from false to true", () => {
    expect(sidebarCollapse.collapsed).toBe(false);
    sidebarCollapse.toggle();
    expect(sidebarCollapse.collapsed).toBe(true);
  });

  it("toggle flips collapsed from true to false", () => {
    sidebarCollapse.set(true);
    sidebarCollapse.toggle();
    expect(sidebarCollapse.collapsed).toBe(false);
  });

  it("set(true) writes '1' to localStorage under the correct key", () => {
    sidebarCollapse.set(true);
    expect(store[KEY]).toBe("1");
  });

  it("set(false) removes the key from localStorage", () => {
    store[KEY] = "1"; // seed it
    sidebarCollapse.set(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("set(true) sets collapsed to true", () => {
    sidebarCollapse.set(true);
    expect(sidebarCollapse.collapsed).toBe(true);
  });

  it("set(false) sets collapsed to false", () => {
    sidebarCollapse.set(true);
    sidebarCollapse.set(false);
    expect(sidebarCollapse.collapsed).toBe(false);
  });
});
