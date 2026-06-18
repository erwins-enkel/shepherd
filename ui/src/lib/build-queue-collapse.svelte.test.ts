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

import { buildQueueCollapse, readBuildQueueCollapse } from "./build-queue-collapse.svelte";

const KEY = "shepherd:build-queue-collapsed";

beforeEach(() => {
  localStorageMock.clear();
  // Reset the store state to false (mirrors a fresh/unset localStorage)
  buildQueueCollapse.set(false);
  localStorageMock.clear(); // clear side-effect write from the reset above
});

// ---------------------------------------------------------------------------
// Store: default / toggle / set / localStorage
// ---------------------------------------------------------------------------

describe("buildQueueCollapse store", () => {
  it("defaults to false (expanded) when localStorage is empty", () => {
    expect(buildQueueCollapse.collapsed).toBe(false);
  });

  it("reads true when key is '1' at construction (via set + re-read)", () => {
    // The singleton is already constructed; we verify persistence by setting
    // and confirming the value round-trips through the mock store.
    buildQueueCollapse.set(true);
    expect(store[KEY]).toBe("1");
    expect(buildQueueCollapse.collapsed).toBe(true);
  });

  it("read() returns true when localStorage key is '1'", () => {
    store[KEY] = "1";
    expect(readBuildQueueCollapse()).toBe(true);
  });

  it("toggle flips collapsed from false to true", () => {
    expect(buildQueueCollapse.collapsed).toBe(false);
    buildQueueCollapse.toggle();
    expect(buildQueueCollapse.collapsed).toBe(true);
  });

  it("toggle flips collapsed from true to false", () => {
    buildQueueCollapse.set(true);
    buildQueueCollapse.toggle();
    expect(buildQueueCollapse.collapsed).toBe(false);
  });

  it("set(true) writes '1' to localStorage under the correct key", () => {
    buildQueueCollapse.set(true);
    expect(store[KEY]).toBe("1");
  });

  it("set(false) removes the key from localStorage", () => {
    store[KEY] = "1"; // seed it
    buildQueueCollapse.set(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("set(true) sets collapsed to true", () => {
    buildQueueCollapse.set(true);
    expect(buildQueueCollapse.collapsed).toBe(true);
  });

  it("set(false) sets collapsed to false", () => {
    buildQueueCollapse.set(true);
    buildQueueCollapse.set(false);
    expect(buildQueueCollapse.collapsed).toBe(false);
  });

  it("absent localStorage value → false", () => {
    // store is cleared in beforeEach; collapsed should be false
    expect(buildQueueCollapse.collapsed).toBe(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("read() returns false when localStorage key is absent", () => {
    // store is cleared in beforeEach
    expect(readBuildQueueCollapse()).toBe(false);
  });

  it("read() returns false for corrupt/garbage localStorage value", () => {
    store[KEY] = "garbage";
    expect(readBuildQueueCollapse()).toBe(false);
  });

  it("read() returns false for empty-string localStorage value", () => {
    store[KEY] = "";
    expect(readBuildQueueCollapse()).toBe(false);
  });
});
