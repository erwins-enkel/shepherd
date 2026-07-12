import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Stub localStorage + matchMedia BEFORE importing the module: the singleton's
// read() + narrow-seed run at construction (import) time, so the globals must be
// in place first (mirrors build-queue-collapse.svelte.test.ts's localStorage stub).
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

// Controllable matchMedia: `mqMatches` drives `.matches`; `fire()` invokes the
// registered change listeners (simulating a viewport crossing 768px).
let mqMatches = false;
const listeners = new Set<() => void>();
const mql = {
  get matches() {
    return mqMatches;
  },
  addEventListener: (_e: string, cb: () => void) => {
    listeners.add(cb);
  },
  removeEventListener: (_e: string, cb: () => void) => {
    listeners.delete(cb);
  },
};
function fire() {
  for (const cb of listeners) cb();
}
// @ts-expect-error stubbing global
globalThis.matchMedia = () => mql;

import { diffView, readDiffView } from "./diff-view.svelte";

const KEY = "shepherd:diff-view";

beforeEach(() => {
  localStorageMock.clear();
  mqMatches = false;
  listeners.clear();
  diffView.set("split");
  diffView.narrow = false;
  localStorageMock.clear(); // drop the write from the reset above
});

afterEach(() => {
  listeners.clear();
});

describe("diffView store", () => {
  it("defaults to split when localStorage is empty", () => {
    expect(diffView.pref).toBe("split");
  });

  it("readDiffView() returns split for an absent key", () => {
    expect(readDiffView()).toBe("split");
  });

  it("readDiffView() returns split for a garbage value", () => {
    store[KEY] = "sideways";
    expect(readDiffView()).toBe("split");
  });

  it("set('unified') persists and reads back", () => {
    diffView.set("unified");
    expect(store[KEY]).toBe("unified");
    expect(diffView.pref).toBe("unified");
    expect(readDiffView()).toBe("unified");
  });

  it("toggle() flips split -> unified -> split", () => {
    expect(diffView.pref).toBe("split");
    diffView.toggle();
    expect(diffView.pref).toBe("unified");
    diffView.toggle();
    expect(diffView.pref).toBe("split");
  });

  it("resolved mirrors pref on a wide viewport", () => {
    diffView.set("split");
    expect(diffView.resolved).toBe("split");
    diffView.set("unified");
    expect(diffView.resolved).toBe("unified");
  });

  it("forces resolved to unified on a narrow viewport even if pref is split", () => {
    diffView.set("split");
    const dispose = diffView.init();
    mqMatches = true;
    fire();
    expect(diffView.narrow).toBe(true);
    expect(diffView.resolved).toBe("unified");
    // stored pref is untouched — a split preference survives the narrow override
    expect(diffView.pref).toBe("split");
    dispose();
  });

  it("init() returns a disposer that unregisters the change listener", () => {
    const dispose = diffView.init();
    dispose();
    mqMatches = true;
    fire(); // listener gone -> narrow stays false
    expect(diffView.narrow).toBe(false);
  });
});
