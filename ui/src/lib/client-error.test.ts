import { describe, expect, it } from "vitest";
import {
  classifyClientError,
  errorText,
  RELOAD_COUNT_KEY,
  RELOAD_DELAYS_MS,
  nextAutoReloadDelay,
  resetAutoReload,
} from "#lib/client-error.js";

/** Minimal in-memory stand-in for `sessionStorage`. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("classifyClientError", () => {
  // One real phrasing per engine — the whole point of the module is that matching only the
  // developer's own browser silently mislabels the other two as app bugs.
  it.each([
    [
      "Chromium",
      "TypeError: Failed to fetch dynamically imported module: https://x/_app/immutable/nodes/3.js",
    ],
    ["Firefox", "error loading dynamically imported module"],
    ["Safari", "Importing a module script failed."],
    ["SvelteKit preload", "Unable to preload CSS for /_app/immutable/assets/0.css"],
  ])("labels a %s chunk failure as chunk", (_engine, message) => {
    expect(classifyClientError(new Error(message))).toBe("chunk");
  });

  it("labels a genuine app fault as unknown", () => {
    expect(classifyClientError(new TypeError("x is not a function"))).toBe("unknown");
  });

  it("does not throw on non-Error values", () => {
    expect(classifyClientError(null)).toBe("unknown");
    expect(classifyClientError(undefined)).toBe("unknown");
    expect(classifyClientError({ nope: 1 })).toBe("unknown");
    expect(classifyClientError("Failed to fetch dynamically imported module")).toBe("chunk");
  });
});

describe("errorText", () => {
  it("reads Error, string and message-bearing objects", () => {
    expect(errorText(new Error("boom"))).toBe("Error: boom");
    expect(errorText("boom")).toBe("boom");
    expect(errorText({ message: "boom" })).toBe("boom");
  });

  it("is empty for nullish input", () => {
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
  });
});

describe("nextAutoReloadDelay", () => {
  it("backs off through the schedule, then stops", () => {
    const storage = fakeStorage();
    const delays = RELOAD_DELAYS_MS.map(() => nextAutoReloadDelay("chunk", storage));
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(storage.getItem(RELOAD_COUNT_KEY)).toBe("5");
    // The whole guard: a dead link must not loop the tab.
    expect(nextAutoReloadDelay("chunk", storage)).toBeNull();
  });

  it("starts over after a successful boot resets the count", () => {
    const storage = fakeStorage();
    nextAutoReloadDelay("chunk", storage);
    nextAutoReloadDelay("chunk", storage);
    resetAutoReload(storage);
    expect(nextAutoReloadDelay("chunk", storage)).toBe(2_000);
  });

  it("never reloads for a non-chunk error", () => {
    expect(nextAutoReloadDelay("unknown", fakeStorage())).toBeNull();
  });

  it("does not reload when storage is missing or throws", () => {
    expect(nextAutoReloadDelay("chunk", null)).toBeNull();
    const hostile = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(nextAutoReloadDelay("chunk", hostile)).toBeNull();
    expect(() => resetAutoReload(hostile)).not.toThrow();
  });
});
