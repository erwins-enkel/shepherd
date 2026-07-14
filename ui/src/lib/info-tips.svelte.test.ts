import { describe, it, expect, beforeEach, vi } from "vitest";

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

// The singleton calls read() at module-evaluation time, so the stub must be in place BEFORE
// the module is evaluated. A static `import` would not do: ESM import declarations are
// hoisted, so the module would be evaluated before any assignment in this file ran — the
// init-time read() would hit a missing localStorage, throw, and get swallowed into `false`,
// which looks like a pass but tests nothing. vi.stubGlobal runs at collection time and each
// test imports the module fresh (below), which is what actually guarantees the ordering.
vi.stubGlobal("localStorage", localStorageMock);

/** Re-evaluate the module so its init-time read() observes the current localStorage. */
async function freshModule() {
  vi.resetModules();
  return import("./info-tips.svelte");
}

const KEY = "shepherd:hide-info-tips";

beforeEach(() => {
  localStorageMock.clear();
});

describe("infoTips store", () => {
  it("defaults to OFF (tips visible) when localStorage is empty", async () => {
    const { infoTips } = await freshModule();
    expect(infoTips.hidden).toBe(false);
  });

  it("initialises to hidden when the key is already '1' (survives a reload)", async () => {
    store[KEY] = "1";
    const { infoTips } = await freshModule();
    expect(infoTips.hidden).toBe(true);
  });

  it("set(true) writes '1' and hides the tips", async () => {
    const { infoTips } = await freshModule();
    infoTips.set(true);
    expect(store[KEY]).toBe("1");
    expect(infoTips.hidden).toBe(true);
  });

  it("set(false) removes the key", async () => {
    store[KEY] = "1";
    const { infoTips } = await freshModule();
    infoTips.set(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("toggle flips the value", async () => {
    const { infoTips } = await freshModule();
    expect(infoTips.hidden).toBe(false);
    infoTips.toggle();
    expect(infoTips.hidden).toBe(true);
    infoTips.toggle();
    expect(infoTips.hidden).toBe(false);
  });
});
