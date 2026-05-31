import { test, expect } from "bun:test";
import { loadIcons, setIcon } from "../src/project-icons";
import { validateIconPatch } from "../src/validate";

function fakeStore() {
  const m = new Map<string, string>();
  return {
    getSetting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

test("loadIcons defaults to an empty map", () => {
  expect(loadIcons(fakeStore())).toEqual({});
});

test("setIcon adds an entry and loadIcons round-trips it", () => {
  const store = fakeStore();
  const map = setIcon(store, "/home/u/Work/shepherd", "📦");
  expect(map).toEqual({ "/home/u/Work/shepherd": "📦" });
  expect(loadIcons(store)).toEqual({ "/home/u/Work/shepherd": "📦" });
});

test("setIcon with empty emoji clears the entry", () => {
  const store = fakeStore();
  setIcon(store, "/p", "🚀");
  const map = setIcon(store, "/p", "");
  expect(map).toEqual({});
});

test("loadIcons tolerates corrupt JSON", () => {
  const store = fakeStore();
  store.setSetting("projectIcons", "{not json");
  expect(loadIcons(store)).toEqual({});
});

test("validateIconPatch accepts a valid patch", () => {
  expect(validateIconPatch({ path: "/p", emoji: "📦" })).toEqual({ path: "/p", emoji: "📦" });
});

test("validateIconPatch accepts an empty emoji (clear)", () => {
  expect(validateIconPatch({ path: "/p", emoji: "" })).toEqual({ path: "/p", emoji: "" });
});

test("validateIconPatch rejects bad payloads", () => {
  expect(validateIconPatch(null)).toBeNull();
  expect(validateIconPatch({ path: "", emoji: "📦" })).toBeNull(); // empty path
  expect(validateIconPatch({ path: "/p" })).toBeNull(); // missing emoji
  expect(validateIconPatch({ path: "/p", emoji: "a".repeat(9) })).toBeNull(); // > 8 code points
  expect(validateIconPatch({ path: "/p", emoji: "\x01" })).toBeNull(); // control char
});

test("loadIcons returns {} for valid JSON that is not a plain object", () => {
  const store = fakeStore();
  store.setSetting("projectIcons", "[]");
  expect(loadIcons(store)).toEqual({});
  store.setSetting("projectIcons", "42");
  expect(loadIcons(store)).toEqual({});
});

test("validateIconPatch trims surrounding whitespace from emoji", () => {
  expect(validateIconPatch({ path: "/p", emoji: " 📦 " })).toEqual({ path: "/p", emoji: "📦" });
});

test("setIcon silently ignores new paths beyond MAX_ENTRIES, but updates existing", () => {
  const store = fakeStore();
  for (let i = 0; i < 500; i++) {
    setIcon(store, `/p${i}`, "🔵");
  }
  const afterCap = setIcon(store, "/new", "🚀");
  expect("/new" in afterCap).toBe(false);
  const afterUpdate = setIcon(store, "/p0", "🎨");
  expect(afterUpdate["/p0"]).toBe("🎨");
});
