import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() at init doesn't touch
// a real or missing localStorage. (Mirrors herd-width.svelte.test.ts.)
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
  ASSISTANT_MIN,
  FOLD_AT,
  SESSION_MIN,
  assistantLayout,
  assistantShareStyle,
  parseAssistantShare,
  resolveAssistantDrag,
} from "./assistant-layout.svelte";

const SHARE_KEY = "shepherd:assistant-share";
const FOLDED_KEY = "shepherd:assistant-folded";

beforeEach(() => {
  assistantLayout.reset();
  localStorageMock.clear();
});

describe("resolveAssistantDrag", () => {
  it("follows the pointer between the panel's floor and the terminal's floor", () => {
    expect(resolveAssistantDrag(500, 1000)).toEqual({ folded: false, share: 0.5 });
  });

  it("keeps the panel at least ASSISTANT_MIN wide", () => {
    expect(resolveAssistantDrag(200, 1000)).toEqual({ folded: false, share: ASSISTANT_MIN / 1000 });
  });

  it("stops at SESSION_MIN of terminal until the drag passes FOLD_AT", () => {
    // Terminal would be 200px: between FOLD_AT and SESSION_MIN the edge holds at the maximum.
    expect(resolveAssistantDrag(800, 1000)).toEqual({
      folded: false,
      share: (1000 - SESSION_MIN) / 1000,
    });
    expect(resolveAssistantDrag(1000 - FOLD_AT, 1000)).toEqual({
      folded: false,
      share: (1000 - SESSION_MIN) / 1000,
    });
  });

  it("folds the terminal once it would be narrower than FOLD_AT", () => {
    expect(resolveAssistantDrag(1000 - FOLD_AT + 1, 1000)).toEqual({ folded: true });
    expect(resolveAssistantDrag(1400, 1000)).toEqual({ folded: true });
  });

  it("keeps the panel's floor when the shared width can't fit both floors, and still folds", () => {
    // 600px shared: 360 panel leaves the terminal 240 — under SESSION_MIN, so the panel can't grow.
    expect(resolveAssistantDrag(400, 600)).toEqual({ folded: false, share: ASSISTANT_MIN / 600 });
    expect(resolveAssistantDrag(600 - FOLD_AT + 1, 600)).toEqual({ folded: true });
  });
});

describe("assistantShareStyle", () => {
  it("splits the two tracks in per-mille fr, the panel keeping its floor", () => {
    expect(assistantShareStyle(0.4)).toBe(
      `--session-w:minmax(0,600fr);--assistant-w:minmax(${ASSISTANT_MIN}px,400fr)`,
    );
  });
});

describe("parseAssistantShare", () => {
  it("keeps a share strictly between 0 and 1", () => {
    expect(parseAssistantShare("0.42")).toBe(0.42);
  });

  it("rejects a missing, malformed or out-of-range value", () => {
    expect(parseAssistantShare(null)).toBeNull();
    expect(parseAssistantShare("")).toBeNull();
    expect(parseAssistantShare("wide")).toBeNull();
    expect(parseAssistantShare("0")).toBeNull();
    expect(parseAssistantShare("1")).toBeNull();
    expect(parseAssistantShare("-0.2")).toBeNull();
    expect(parseAssistantShare("Infinity")).toBeNull();
  });
});

describe("assistantLayout", () => {
  it("starts at the default width, unfolded", () => {
    expect(assistantLayout.share).toBeNull();
    expect(assistantLayout.folded).toBe(false);
  });

  it("updates live while dragging and persists only on commit", () => {
    assistantLayout.drag(500, 1000, null);
    expect(assistantLayout.share).toBe(0.5);
    expect(localStorageMock.getItem(SHARE_KEY)).toBeNull();

    assistantLayout.commit();
    expect(localStorageMock.getItem(SHARE_KEY)).toBe("0.5");
    expect(localStorageMock.getItem(FOLDED_KEY)).toBeNull();
  });

  it("folding keeps the width from before the drag to unfold to", () => {
    assistantLayout.drag(400, 1000, null);
    assistantLayout.commit();
    // A new drag from share 0.4 sweeps through the maximum into the fold.
    assistantLayout.drag(680, 1000, 0.4);
    assistantLayout.drag(950, 1000, 0.4);
    expect(assistantLayout.folded).toBe(true);
    expect(assistantLayout.share).toBe(0.4);

    assistantLayout.commit();
    expect(localStorageMock.getItem(FOLDED_KEY)).toBe("1");
    expect(localStorageMock.getItem(SHARE_KEY)).toBe("0.4");
  });

  it("dragging back out of the fold unfolds at the pointer's width", () => {
    assistantLayout.drag(950, 1000, 0.4);
    assistantLayout.drag(600, 1000, 0.4);
    expect(assistantLayout.folded).toBe(false);
    expect(assistantLayout.share).toBe(0.6);
  });

  it("unfold persists and keeps the width", () => {
    assistantLayout.drag(450, 1000, null);
    assistantLayout.drag(950, 1000, 0.45);
    assistantLayout.commit();

    assistantLayout.unfold();
    expect(assistantLayout.folded).toBe(false);
    expect(assistantLayout.share).toBe(0.45);
    expect(localStorageMock.getItem(FOLDED_KEY)).toBeNull();
    expect(localStorageMock.getItem(SHARE_KEY)).toBe("0.45");
  });

  it("a fold from the default width unfolds to the default", () => {
    assistantLayout.drag(950, 1000, null);
    assistantLayout.commit();
    expect(assistantLayout.share).toBeNull();
    expect(localStorageMock.getItem(SHARE_KEY)).toBeNull();
    expect(localStorageMock.getItem(FOLDED_KEY)).toBe("1");
  });

  it("reset returns to the default width, unfolded, and clears both keys", () => {
    assistantLayout.drag(950, 1000, 0.5);
    assistantLayout.commit();

    assistantLayout.reset();
    expect(assistantLayout.share).toBeNull();
    expect(assistantLayout.folded).toBe(false);
    expect(localStorageMock.getItem(SHARE_KEY)).toBeNull();
    expect(localStorageMock.getItem(FOLDED_KEY)).toBeNull();
  });
});
