import { describe, expect, it } from "vitest";
import {
  classifyClientError,
  errorText,
  RELOAD_GUARD_KEY,
  shouldAutoReload,
} from "$lib/client-error";

/** Minimal in-memory stand-in for `sessionStorage`. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
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

describe("shouldAutoReload", () => {
  it("reloads once for a chunk error, then never again in the same tab", () => {
    const storage = fakeStorage();
    expect(shouldAutoReload("chunk", storage)).toBe(true);
    expect(storage.getItem(RELOAD_GUARD_KEY)).toBe("1");
    // The whole guard: a flaky link must not loop the tab.
    expect(shouldAutoReload("chunk", storage)).toBe(false);
  });

  it("never reloads for a non-chunk error", () => {
    expect(shouldAutoReload("unknown", fakeStorage())).toBe(false);
  });

  it("does not reload when storage is missing or throws", () => {
    expect(shouldAutoReload("chunk", null)).toBe(false);
    const hostile = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(shouldAutoReload("chunk", hostile)).toBe(false);
  });
});
