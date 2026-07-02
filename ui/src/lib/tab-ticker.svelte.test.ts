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

import { tabTicker, readTabTicker } from "./tab-ticker.svelte";

const KEY = "shepherd:tab-glyph-ticker";

beforeEach(() => {
  localStorageMock.clear();
  tabTicker.set(false); // reset singleton
  localStorageMock.clear(); // clear the reset's side-effect write
});

describe("tabTicker store", () => {
  it("defaults to OFF (false) when localStorage is empty", () => {
    expect(tabTicker.enabled).toBe(false);
  });

  it("read() returns true when the key is '1'", () => {
    store[KEY] = "1";
    expect(readTabTicker()).toBe(true);
  });

  it("read() returns false when the key is absent", () => {
    expect(readTabTicker()).toBe(false);
  });

  it("set(true) writes '1' and flips enabled", () => {
    tabTicker.set(true);
    expect(store[KEY]).toBe("1");
    expect(tabTicker.enabled).toBe(true);
  });

  it("set(false) removes the key", () => {
    store[KEY] = "1";
    tabTicker.set(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("toggle flips the value", () => {
    expect(tabTicker.enabled).toBe(false);
    tabTicker.toggle();
    expect(tabTicker.enabled).toBe(true);
    tabTicker.toggle();
    expect(tabTicker.enabled).toBe(false);
  });
});
