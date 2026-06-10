import { test, expect, spyOn } from "bun:test";
import { SessionStore } from "../src/store";
import { loadSteers, saveSteers, DEFAULT_STEERS } from "../src/steers";

test("loadSteers seeds + persists the defaults on first read", () => {
  const store = new SessionStore(":memory:");
  const got = loadSteers(store);
  expect(got.length).toBe(DEFAULT_STEERS.length);
  expect(got.map((s) => s.label)).toEqual(DEFAULT_STEERS.map((s) => s.label));
  // every seeded steer has a uuid id and explicit surfaces
  for (const s of got) {
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.inSteerBar).toBe(true);
    expect(s.onIssues).toBe(false);
  }
  // persisted, so a second read is stable (same ids)
  expect(loadSteers(store)).toEqual(got);
});

test("loadSteers seeds the standard issue action from the config fallback on a fresh DB", () => {
  const store = new SessionStore(":memory:");
  const got = loadSteers(store, "check this issue");
  const action = got[got.length - 1]!;
  expect(got.length).toBe(DEFAULT_STEERS.length + 1);
  expect(action.label).toBe("Standard");
  expect(action.emoji).toBe("⚡");
  expect(action.text).toBe("check this issue");
  expect(action.inSteerBar).toBe(false);
  expect(action.onIssues).toBe(true);
});

test("loadSteers prefers the operator's stored standardCommand over the config fallback", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("standardCommand", "my custom prompt");
  const got = loadSteers(store, "config default");
  expect(got[got.length - 1]!.text).toBe("my custom prompt");
});

test("loadSteers folds the legacy standardCommand into an existing list exactly once", () => {
  const store = new SessionStore(":memory:");
  saveSteers(store, [{ id: "a", label: "x", text: "y", inSteerBar: true, onIssues: false }]);
  store.setSetting("standardCommand", "legacy prompt");
  const got = loadSteers(store);
  expect(got.length).toBe(2);
  expect(got[1]!.text).toBe("legacy prompt");
  expect(got[1]!.onIssues).toBe(true);
  // migration is one-time: deleting the migrated action must not resurrect it
  saveSteers(store, [{ id: "a", label: "x", text: "y", inSteerBar: true, onIssues: false }]);
  expect(loadSteers(store).length).toBe(1);
});

test("loadSteers warns (and keeps the marker) when the cap blocks the legacy fold", () => {
  const store = new SessionStore(":memory:");
  const full = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`,
    label: `l${i}`,
    text: `t${i}`,
    inSteerBar: true,
    onIssues: false,
  }));
  saveSteers(store, full);
  store.setSetting("standardCommand", "legacy prompt");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const got = loadSteers(store);
    expect(got.length).toBe(40); // cap honored — nothing appended
    expect(warn).toHaveBeenCalledTimes(1); // ...but the drop is loud, not silent
    expect(String(warn.mock.calls[0]![0])).toContain("legacy prompt");
    expect(store.getSetting("steersIssueActionsMigrated")).toBe("1");
    expect(store.getSetting("standardCommand")).toBe("legacy prompt"); // kept for manual recovery
    // marker set → a later read neither re-warns nor re-attempts the fold
    expect(loadSteers(store).length).toBe(40);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("loadSteers backfills distinct default emojis onto legacy steers exactly once", () => {
  const store = new SessionStore(":memory:");
  store.setSetting(
    "steers",
    JSON.stringify([
      { id: "a", label: "x", text: "y" },
      { id: "b", label: "p", text: "q" },
      { id: "c", label: "k", text: "v", emoji: "🦊" }, // already has one — left intact
    ]),
  );
  const got = loadSteers(store);
  // every legacy (emoji-less) entry gets one, and they differ from each other
  expect(got[0]!.emoji).toBeTruthy();
  expect(got[1]!.emoji).toBeTruthy();
  expect(got[0]!.emoji).not.toBe(got[1]!.emoji);
  expect(got[2]!.emoji).toBe("🦊"); // pre-set emoji untouched
  // persisted + one-time: a re-read is stable and never re-assigns
  expect(loadSteers(store)).toEqual(got);
});

test("loadSteers fills surface defaults on legacy entries (pre-emoji/scopes)", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("steers", JSON.stringify([{ id: "a", label: "x", text: "y" }]));
  store.setSetting("steersIssueActionsMigrated", "1");
  expect(loadSteers(store)).toEqual([
    { id: "a", label: "x", text: "y", inSteerBar: true, onIssues: false },
  ]);
});

test("loadSteers returns the stored list verbatim", () => {
  const store = new SessionStore(":memory:");
  const list = [{ id: "a", label: "x", text: "y", emoji: "🧪", inSteerBar: true, onIssues: true }];
  saveSteers(store, list);
  expect(loadSteers(store)).toEqual(list);
});

test("loadSteers returns [] on corrupt JSON", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("steers", "{not json");
  expect(loadSteers(store)).toEqual([]);
});
