import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() at init
// doesn't touch a real or missing localStorage.
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
};
// @ts-expect-error stubbing global
globalThis.localStorage = localStorageMock;

import { subagentsCollapse, readSubagentsCollapse } from "./subagents-collapse.svelte";

const KEY = "shepherd:subagents-collapsed";

beforeEach(() => {
  subagentsCollapse.set(false);
  for (const k of Object.keys(store)) delete store[k];
});

describe("subagentsCollapse store", () => {
  it("defaults to expanded", () => {
    expect(subagentsCollapse.collapsed).toBe(false);
  });

  it("toggle flips and persists", () => {
    subagentsCollapse.toggle();
    expect(subagentsCollapse.collapsed).toBe(true);
    expect(store[KEY]).toBe("1");
    subagentsCollapse.toggle();
    expect(subagentsCollapse.collapsed).toBe(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("read() honors only '1'", () => {
    expect(readSubagentsCollapse()).toBe(false);
    store[KEY] = "garbage";
    expect(readSubagentsCollapse()).toBe(false);
    store[KEY] = "1";
    expect(readSubagentsCollapse()).toBe(true);
  });

  it("tolerates a throwing localStorage", () => {
    const orig = localStorageMock.setItem;
    localStorageMock.setItem = () => {
      throw new Error("quota");
    };
    try {
      subagentsCollapse.set(true);
      expect(subagentsCollapse.collapsed).toBe(true);
    } finally {
      localStorageMock.setItem = orig;
    }
  });
});
