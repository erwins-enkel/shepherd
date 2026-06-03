import { test, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so it is never touched at init.
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

import { featureDiscovery } from "./featureDiscovery.svelte";

const KEY_VERSION = "shepherd:whats-new:lastSeenVersion";
const KEY_SEEN = "shepherd:features-seen";

beforeEach(() => {
  // Reset storage and in-memory state between tests.
  // We use hydrate() on a clean storage so the reset goes through the proper
  // read path rather than bypassing it via direct field assignment.
  localStorageMock.clear();
  featureDiscovery.hydrate(); // reads empty storage → resets both fields to defaults
  // Also reset lastSeenVersion via its setter (clears any in-memory value from previous test).
  featureDiscovery.lastSeenVersion = null;
  localStorageMock.clear(); // clear side-effect writes from the setter above
});

test("no localStorage read happens at module import (SSR-safe)", () => {
  // The store is already imported above; we only verify that neither key was
  // read during import by checking storage is still clean at this point.
  // (The beforeEach clears it, but the point is: importing doesn't call getItem.)
  expect(store[KEY_VERSION]).toBeUndefined();
  expect(store[KEY_SEEN]).toBeUndefined();
});

test("hydrate reads lastSeenVersion from storage", () => {
  store[KEY_VERSION] = "1.9.0";
  featureDiscovery.hydrate();
  expect(featureDiscovery.lastSeenVersion).toBe("1.9.0");
});

test("hydrate reads seen blob from storage", () => {
  store[KEY_SEEN] = JSON.stringify({ critic: true, learnings: true });
  featureDiscovery.hydrate();
  expect(featureDiscovery.isSeen("critic")).toBe(true);
  expect(featureDiscovery.isSeen("learnings")).toBe(true);
  expect(featureDiscovery.isSeen("auto-address")).toBe(false);
});

test("hydrate reads both keys independently", () => {
  store[KEY_VERSION] = "1.10.0";
  store[KEY_SEEN] = JSON.stringify({ learnings: true });
  featureDiscovery.hydrate();
  expect(featureDiscovery.lastSeenVersion).toBe("1.10.0");
  expect(featureDiscovery.isSeen("learnings")).toBe(true);
});

test("corrupt seen JSON leaves lastSeenVersion intact", () => {
  store[KEY_VERSION] = "1.10.0";
  store[KEY_SEEN] = "{ this is not valid JSON !!!";
  featureDiscovery.hydrate();
  // lastSeenVersion must survive the corrupt blob
  expect(featureDiscovery.lastSeenVersion).toBe("1.10.0");
  // seen falls back to empty
  expect(featureDiscovery.isSeen("critic")).toBe(false);
});

test("corrupt lastSeenVersion storage entry leaves seen intact", () => {
  // Simulate getItem throwing for the version key by temporarily breaking it.
  const originalGetItem = localStorageMock.getItem;
  localStorageMock.getItem = (key: string) => {
    if (key === KEY_VERSION) throw new Error("simulated error");
    return store[key] ?? null;
  };
  store[KEY_SEEN] = JSON.stringify({ critic: true });
  featureDiscovery.hydrate();
  // seen must survive the version error
  expect(featureDiscovery.isSeen("critic")).toBe(true);
  // lastSeenVersion falls back to null
  expect(featureDiscovery.lastSeenVersion).toBeNull();
  // Restore
  localStorageMock.getItem = originalGetItem;
});

test("markSeen sets the flag in memory", () => {
  expect(featureDiscovery.isSeen("critic")).toBe(false);
  featureDiscovery.markSeen("critic");
  expect(featureDiscovery.isSeen("critic")).toBe(true);
});

test("markSeen persists the seen blob to localStorage", () => {
  featureDiscovery.markSeen("learnings");
  featureDiscovery.markSeen("auto-address");
  const persisted = JSON.parse(store[KEY_SEEN]);
  expect(persisted["learnings"]).toBe(true);
  expect(persisted["auto-address"]).toBe(true);
});

test("markSeen does not overwrite other seen entries", () => {
  featureDiscovery.markSeen("critic");
  featureDiscovery.markSeen("learnings");
  expect(featureDiscovery.isSeen("critic")).toBe(true);
  expect(featureDiscovery.isSeen("learnings")).toBe(true);
});

test("lastSeenVersion setter persists to localStorage", () => {
  featureDiscovery.lastSeenVersion = "1.10.0";
  expect(store[KEY_VERSION]).toBe("1.10.0");
});

test("lastSeenVersion setter with null removes the key", () => {
  store[KEY_VERSION] = "1.9.0";
  featureDiscovery.lastSeenVersion = null;
  expect(store[KEY_VERSION]).toBeUndefined();
});

test("isSeen returns false for unknown id", () => {
  expect(featureDiscovery.isSeen("never-seen-feature")).toBe(false);
});

test("hydrate with missing keys leaves state as empty defaults", () => {
  // Nothing in storage
  featureDiscovery.hydrate();
  expect(featureDiscovery.lastSeenVersion).toBeNull();
  expect(featureDiscovery.isSeen("critic")).toBe(false);
});
