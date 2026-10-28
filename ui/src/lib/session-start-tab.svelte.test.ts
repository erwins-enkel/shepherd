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

import { sessionStartTab, readSessionStartTab, resolveStartTab } from "./session-start-tab.svelte";

const KEY = "shepherd:session-start-tab";

beforeEach(() => {
  sessionStartTab.set("auto");
  localStorageMock.clear();
});

describe("resolveStartTab", () => {
  it("auto: desktop opens the terminal, phone or touch the chat", () => {
    expect(resolveStartTab("auto", { mobile: false, touch: false })).toBe("term");
    expect(resolveStartTab("auto", { mobile: true, touch: false })).toBe("chat");
    expect(resolveStartTab("auto", { mobile: false, touch: true })).toBe("chat");
  });

  it("an explicit choice wins on every device", () => {
    expect(resolveStartTab("chat", { mobile: false, touch: false })).toBe("chat");
    expect(resolveStartTab("term", { mobile: true, touch: true })).toBe("term");
  });
});

describe("sessionStartTab store", () => {
  it("defaults to auto", () => {
    expect(sessionStartTab.pref).toBe("auto");
    expect(readSessionStartTab()).toBe("auto");
  });

  it("reads a stored choice and ignores junk", () => {
    store[KEY] = "chat";
    expect(readSessionStartTab()).toBe("chat");
    store[KEY] = "preview";
    expect(readSessionStartTab()).toBe("auto");
  });

  it("set persists the choice; auto clears it", () => {
    sessionStartTab.set("term");
    expect(sessionStartTab.pref).toBe("term");
    expect(store[KEY]).toBe("term");
    sessionStartTab.set("auto");
    expect(store[KEY]).toBeUndefined();
  });
});
