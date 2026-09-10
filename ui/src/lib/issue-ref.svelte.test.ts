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

import { issueRef } from "./issue-ref.svelte";

const KEY = "shepherd:hide-card-issue-ref";

beforeEach(() => {
  localStorageMock.clear();
  issueRef.set(true); // reset singleton
  localStorageMock.clear(); // clear the reset's side-effect write
});

describe("issueRef store", () => {
  it("defaults to ON when localStorage is empty", () => {
    expect(issueRef.shown).toBe(true);
  });

  it("set(false) persists the opt-out as '0'", () => {
    issueRef.set(false);
    expect(store[KEY]).toBe("0");
    expect(issueRef.shown).toBe(false);
  });

  // Inverted default: "on" is the absence of the key, never a stored "1" — otherwise a
  // fresh device would read as opted-out.
  it("set(true) removes the key rather than writing one", () => {
    store[KEY] = "0";
    issueRef.set(true);
    expect(store[KEY]).toBeUndefined();
    expect(issueRef.shown).toBe(true);
  });

  it("toggle flips the value", () => {
    expect(issueRef.shown).toBe(true);
    issueRef.toggle();
    expect(issueRef.shown).toBe(false);
    issueRef.toggle();
    expect(issueRef.shown).toBe(true);
  });
});
