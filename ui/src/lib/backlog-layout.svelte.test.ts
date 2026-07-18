import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() calls
// at init don't touch a real or missing localStorage. (Mirrors
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
  backlogLayout,
  parseStored,
  clampModalWidth,
  clampModalHeight,
  clampSidebarWidth,
  MODAL_MIN_W,
  MODAL_MIN_H,
  OVERLAY_PAD,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  DETAIL_MIN,
} from "./backlog-layout.svelte";

const KEY_W = "shepherd:repos-modal-w";
const KEY_H = "shepherd:repos-modal-h";
const KEY_SB = "shepherd:repos-sidebar-w";

beforeEach(() => {
  localStorageMock.clear();
  backlogLayout.resetModal();
  backlogLayout.resetSidebar();
  localStorageMock.clear(); // clear side-effect writes from the resets above
});

// ---------------------------------------------------------------------------
// parseStored — corrupt-storage fallback
// ---------------------------------------------------------------------------

describe("parseStored", () => {
  it("returns null for missing / non-numeric / empty input", () => {
    expect(parseStored(null)).toBe(null);
    expect(parseStored("abc")).toBe(null);
    expect(parseStored("")).toBe(null);
    expect(parseStored("NaN")).toBe(null);
  });

  it("rejects non-positive and out-of-sanity-range values", () => {
    expect(parseStored("0")).toBe(null);
    expect(parseStored("-5")).toBe(null);
    expect(parseStored("20000")).toBe(null); // over the absolute sanity ceiling
  });

  it("passes through a sane positive number (float preserved for later clamp)", () => {
    expect(parseStored("300")).toBe(300);
    expect(parseStored("300.6")).toBe(300.6);
  });
});

// ---------------------------------------------------------------------------
// Pure clamps
// ---------------------------------------------------------------------------

describe("clampModalWidth", () => {
  it("clamps below the minimum up to MODAL_MIN_W", () => {
    expect(clampModalWidth(100, 1920)).toBe(MODAL_MIN_W);
    expect(clampModalWidth(MODAL_MIN_W - 1, 1920)).toBe(MODAL_MIN_W);
  });

  it("clamps to the viewport ceiling minus the overlay padding", () => {
    expect(clampModalWidth(5000, 1200)).toBe(1200 - OVERLAY_PAD);
  });

  it("passes through and rounds a value inside the range", () => {
    expect(clampModalWidth(1000, 1920)).toBe(1000);
    expect(clampModalWidth(1000.6, 1920)).toBe(1001);
  });

  it("never returns below the floor even on a tiny viewport", () => {
    // vw - PAD < MODAL_MIN_W → floor wins (narrow desktop → mobile layout anyway)
    expect(clampModalWidth(500, 400)).toBe(MODAL_MIN_W);
  });
});

describe("clampModalHeight", () => {
  it("clamps below the minimum up to MODAL_MIN_H", () => {
    expect(clampModalHeight(100, 1080)).toBe(MODAL_MIN_H);
  });

  it("clamps to the viewport ceiling minus the overlay padding", () => {
    expect(clampModalHeight(5000, 900)).toBe(900 - OVERLAY_PAD);
  });

  it("passes through inside the range", () => {
    expect(clampModalHeight(700, 1080)).toBe(700);
  });
});

describe("clampSidebarWidth", () => {
  it("clamps below the minimum up to SIDEBAR_MIN", () => {
    expect(clampSidebarWidth(50, 1600)).toBe(SIDEBAR_MIN);
  });

  it("clamps to SIDEBAR_MAX when the split is wide", () => {
    expect(clampSidebarWidth(9999, 4000)).toBe(SIDEBAR_MAX);
  });

  it("leaves the detail pane at least DETAIL_MIN (narrow split lowers the max)", () => {
    // max = min(SIDEBAR_MAX, innerW - DETAIL_MIN) = min(560, 800-380) = 420
    expect(clampSidebarWidth(9999, 800)).toBe(800 - DETAIL_MIN);
  });

  it("passes through and rounds a value inside the range", () => {
    expect(clampSidebarWidth(300, 1600)).toBe(300);
    expect(clampSidebarWidth(300.4, 1600)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Store: set / commit / reset / localStorage
// ---------------------------------------------------------------------------

describe("backlogLayout store", () => {
  it("starts null (defaults) with unset localStorage", () => {
    expect(backlogLayout.width).toBe(null);
    expect(backlogLayout.height).toBe(null);
    expect(backlogLayout.sidebar).toBe(null);
  });

  it("setModal updates without persisting", () => {
    backlogLayout.setModal(1200, 800);
    expect(backlogLayout.width).toBe(1200);
    expect(backlogLayout.height).toBe(800);
    expect(store[KEY_W]).toBeUndefined();
    expect(store[KEY_H]).toBeUndefined();
  });

  it("commitModal persists both dimensions", () => {
    backlogLayout.setModal(1200, 800);
    backlogLayout.commitModal();
    expect(store[KEY_W]).toBe("1200");
    expect(store[KEY_H]).toBe("800");
  });

  it("commitModal no-ops when unset (never pins the default)", () => {
    backlogLayout.commitModal();
    expect(store[KEY_W]).toBeUndefined();
    expect(store[KEY_H]).toBeUndefined();
  });

  it("resetModal clears state + stored values", () => {
    backlogLayout.setModal(1200, 800);
    backlogLayout.commitModal();
    backlogLayout.resetModal();
    expect(backlogLayout.width).toBe(null);
    expect(backlogLayout.height).toBe(null);
    expect(store[KEY_W]).toBeUndefined();
    expect(store[KEY_H]).toBeUndefined();
  });

  it("setSidebar / commitSidebar / resetSidebar round-trip", () => {
    backlogLayout.setSidebar(360);
    expect(backlogLayout.sidebar).toBe(360);
    expect(store[KEY_SB]).toBeUndefined();
    backlogLayout.commitSidebar();
    expect(store[KEY_SB]).toBe("360");
    backlogLayout.resetSidebar();
    expect(backlogLayout.sidebar).toBe(null);
    expect(store[KEY_SB]).toBeUndefined();
  });

  it("commit swallows storage errors (unavailable / private mode)", () => {
    backlogLayout.setModal(1000, 700);
    backlogLayout.setSidebar(300);
    const orig = localStorageMock.setItem;
    localStorageMock.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    expect(() => backlogLayout.commitModal()).not.toThrow();
    expect(() => backlogLayout.commitSidebar()).not.toThrow();
    localStorageMock.setItem = orig;
  });
});
