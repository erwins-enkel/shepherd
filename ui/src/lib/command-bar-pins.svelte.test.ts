import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() at init is safe.
const store: Record<string, string> = {};
let throwOnWrite = false;
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    if (throwOnWrite) throw new Error("quota");
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
};
// @ts-expect-error stubbing global
globalThis.localStorage = localStorageMock;

import { commandBarPins, MAX_PINS } from "./command-bar-pins.svelte";

const KEY = "shepherd:commandbar-pins";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  throwOnWrite = false;
  commandBarPins.load();
});

describe("commandBarPins", () => {
  it("starts empty with no stored value", () => {
    expect(commandBarPins.keys).toEqual([]);
  });

  it("toggle pins in order and persists, then unpins", () => {
    expect(commandBarPins.toggle("c:usage")).toBe("pinned");
    expect(commandBarPins.toggle("s:a")).toBe("pinned");
    expect(commandBarPins.keys).toEqual(["c:usage", "s:a"]);
    expect(JSON.parse(store[KEY]!)).toEqual(["c:usage", "s:a"]);
    expect(commandBarPins.has("s:a")).toBe(true);

    expect(commandBarPins.toggle("c:usage")).toBe("unpinned");
    expect(commandBarPins.keys).toEqual(["s:a"]);
    expect(commandBarPins.toggle("s:a")).toBe("unpinned");
    expect(store[KEY]).toBeUndefined();
  });

  it(`refuses a pin past ${MAX_PINS} without writing`, () => {
    for (let i = 0; i < MAX_PINS; i++) commandBarPins.toggle(`s:${i}`);
    const before = store[KEY];
    expect(commandBarPins.toggle("c:usage")).toBe("full");
    expect(commandBarPins.keys).toHaveLength(MAX_PINS);
    expect(store[KEY]).toBe(before);
    // unpinning still works at the cap
    expect(commandBarPins.toggle("s:0")).toBe("unpinned");
  });

  it("prune drops rejected keys and writes only on change", () => {
    commandBarPins.toggle("s:a");
    commandBarPins.toggle("r:/x");
    commandBarPins.toggle("c:usage");
    commandBarPins.prune((k) => !k.startsWith("s:"));
    expect(commandBarPins.keys).toEqual(["r:/x", "c:usage"]);
    expect(JSON.parse(store[KEY]!)).toEqual(["r:/x", "c:usage"]);

    store[KEY] = "sentinel";
    commandBarPins.prune(() => true);
    expect(store[KEY]).toBe("sentinel");
  });

  it("load() re-reads storage (survives a reload)", () => {
    store[KEY] = JSON.stringify(["l:next", "d:https://x/y"]);
    commandBarPins.load();
    expect(commandBarPins.keys).toEqual(["l:next", "d:https://x/y"]);
  });

  it.each([
    ["garbage", "not json"],
    ["object", JSON.stringify({ a: 1 })],
    ["number", "3"],
  ])("degrades corrupt storage (%s) to no pins", (_name, raw) => {
    store[KEY] = raw;
    commandBarPins.load();
    expect(commandBarPins.keys).toEqual([]);
  });

  it("drops non-strings and dupes and caps a hand-edited value", () => {
    const many = Array.from({ length: 12 }, (_, i) => `s:${i}`);
    store[KEY] = JSON.stringify(["s:0", 5, null, "", "s:0", ...many]);
    commandBarPins.load();
    expect(commandBarPins.keys).toEqual(many.slice(0, MAX_PINS));
  });

  it("keeps in-memory state when storage throws on write", () => {
    throwOnWrite = true;
    expect(commandBarPins.toggle("c:usage")).toBe("pinned");
    expect(commandBarPins.keys).toEqual(["c:usage"]);
  });
});
