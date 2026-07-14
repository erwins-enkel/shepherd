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

import { infoTips, readInfoTips } from "./info-tips.svelte";

const KEY = "shepherd:hide-info-tips";

beforeEach(() => {
  localStorageMock.clear();
  infoTips.set(false); // reset singleton
  localStorageMock.clear(); // clear the reset's side-effect write
});

describe("infoTips store", () => {
  it("defaults to OFF (tips visible) when localStorage is empty", () => {
    expect(infoTips.hidden).toBe(false);
  });

  it("read() returns true when the key is '1'", () => {
    store[KEY] = "1";
    expect(readInfoTips()).toBe(true);
  });

  it("read() returns false when the key is absent", () => {
    expect(readInfoTips()).toBe(false);
  });

  it("set(true) writes '1' and hides the tips", () => {
    infoTips.set(true);
    expect(store[KEY]).toBe("1");
    expect(infoTips.hidden).toBe(true);
  });

  it("set(false) removes the key", () => {
    store[KEY] = "1";
    infoTips.set(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("toggle flips the value", () => {
    expect(infoTips.hidden).toBe(false);
    infoTips.toggle();
    expect(infoTips.hidden).toBe(true);
    infoTips.toggle();
    expect(infoTips.hidden).toBe(false);
  });
});
