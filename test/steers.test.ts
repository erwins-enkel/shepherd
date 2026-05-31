import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { loadSteers, saveSteers, DEFAULT_STEERS } from "../src/steers";

test("loadSteers seeds + persists the defaults on first read", () => {
  const store = new SessionStore(":memory:");
  const got = loadSteers(store);
  expect(got.length).toBe(DEFAULT_STEERS.length);
  expect(got.map((s) => s.label)).toEqual(DEFAULT_STEERS.map((s) => s.label));
  // every seeded steer has a uuid id
  for (const s of got) expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  // persisted, so a second read is stable (same ids)
  expect(loadSteers(store)).toEqual(got);
});

test("loadSteers returns the stored list verbatim", () => {
  const store = new SessionStore(":memory:");
  const list = [{ id: "a", label: "x", text: "y" }];
  saveSteers(store, list);
  expect(loadSteers(store)).toEqual(list);
});

test("loadSteers returns [] on corrupt JSON", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("steers", "{not json");
  expect(loadSteers(store)).toEqual([]);
});
