import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() call
// at init doesn't touch a real or missing localStorage. (Mirrors
// herd-width.svelte.test.ts.)
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

import {
  terminalFontSize,
  clampTerminalFontSize,
  FONT_MIN,
  FONT_MAX,
} from "./terminal-font-size.svelte";

const KEY = "shepherd:terminal-font-size";

beforeEach(() => {
  localStorageMock.clear();
  terminalFontSize.reset();
  localStorageMock.clear(); // clear side-effect write from the reset above
});

// ---------------------------------------------------------------------------
// Pure clamp
// ---------------------------------------------------------------------------

describe("clampTerminalFontSize", () => {
  it("clamps below the minimum up to FONT_MIN", () => {
    expect(clampTerminalFontSize(2)).toBe(FONT_MIN);
    expect(clampTerminalFontSize(FONT_MIN - 1)).toBe(FONT_MIN);
  });

  it("clamps above the maximum down to FONT_MAX", () => {
    expect(clampTerminalFontSize(999)).toBe(FONT_MAX);
    expect(clampTerminalFontSize(FONT_MAX + 1)).toBe(FONT_MAX);
  });

  it("passes a value inside the range through WITHOUT rounding", () => {
    expect(clampTerminalFontSize(13)).toBe(13);
    expect(clampTerminalFontSize(12.5)).toBe(12.5); // fractional default survives
  });

  it("keeps the exact bounds", () => {
    expect(clampTerminalFontSize(FONT_MIN)).toBe(FONT_MIN);
    expect(clampTerminalFontSize(FONT_MAX)).toBe(FONT_MAX);
  });
});

// ---------------------------------------------------------------------------
// Store: set / reset / localStorage
// ---------------------------------------------------------------------------

describe("terminalFontSize store", () => {
  it("starts null (per-device default) with unset localStorage", () => {
    expect(terminalFontSize.size).toBe(null);
  });

  it("set() clamps, updates size and persists immediately", () => {
    terminalFontSize.set(15);
    expect(terminalFontSize.size).toBe(15);
    expect(store[KEY]).toBe("15");
  });

  it("set() clamps out-of-range values (and persists the clamped value)", () => {
    terminalFontSize.set(1);
    expect(terminalFontSize.size).toBe(FONT_MIN);
    expect(store[KEY]).toBe(String(FONT_MIN));
    terminalFontSize.set(500);
    expect(terminalFontSize.size).toBe(FONT_MAX);
    expect(store[KEY]).toBe(String(FONT_MAX));
  });

  it("reset() clears size and removes the stored value", () => {
    terminalFontSize.set(18);
    expect(store[KEY]).toBe("18");
    terminalFontSize.reset();
    expect(terminalFontSize.size).toBe(null);
    expect(store[KEY]).toBeUndefined();
  });
});
