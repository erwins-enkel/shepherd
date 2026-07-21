import { test, expect, vi, beforeEach } from "vitest";
import type { Recap } from "./types";

vi.mock("./api", () => ({
  getRecaps: vi.fn(),
}));

import { recaps } from "./recaps.svelte";
import { getRecaps } from "./api";

const recap = (id: string): Recap => ({
  sessionId: id,
  state: "ready",
  headSha: "abc123",
  verdict: "ready",
  headline: "All done",
  body: "Everything went smoothly.",
  openItems: [],
  changedFiles: [],
  spawnSessionId: id,
  cwd: "/repo",
  model: null,
  spawnedAt: 0,
  generatedAt: 1000,
  updatedAt: 1000,
});

beforeEach(() => {
  recaps.map = {};
  vi.clearAllMocks();
});

test("load() populates map from api", async () => {
  const r = recap("s1");
  vi.mocked(getRecaps).mockResolvedValue({ s1: r });
  await recaps.load();
  expect(recaps.map["s1"]).toEqual(r);
});

test("load() swallows api errors (best-effort)", async () => {
  vi.mocked(getRecaps).mockRejectedValue(new Error("network error"));
  await expect(recaps.load()).resolves.toBeUndefined();
  expect(recaps.map).toEqual({});
});

test("apply({id, recap}) adds the recap", () => {
  const r = recap("s1");
  recaps.apply({ id: "s1", recap: r });
  expect(recaps.map["s1"]).toBe(r);
});

test("apply({id, recap: null}) removes an existing entry", () => {
  recaps.map = { s1: recap("s1") };
  recaps.apply({ id: "s1", recap: null });
  expect(recaps.map["s1"]).toBeUndefined();
});

test("apply({id, recap: null}) is a no-op for unknown id", () => {
  recaps.apply({ id: "nope", recap: null });
  expect(recaps.map["nope"]).toBeUndefined();
  expect(Object.keys(recaps.map)).toHaveLength(0);
});

test("drop() removes an existing entry", () => {
  recaps.map = { s1: recap("s1") };
  recaps.drop("s1");
  expect(recaps.map["s1"]).toBeUndefined();
});

test("drop() is a no-op for unknown id", () => {
  recaps.map = { s1: recap("s1") };
  const before = recaps.map;
  recaps.drop("s2");
  // s1 must still be present
  expect(recaps.map["s1"]).toBeDefined();
  // map object is the same reference (no copy was made)
  expect(recaps.map).toBe(before);
});

test("recap upsert rejects a __proto__ id but still stores a real one", () => {
  recaps.apply({ id: "__proto__", recap: recap("__proto__") });
  expect(Object.hasOwn(recaps.map, "__proto__")).toBe(false);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  const r = recap("sess-1");
  recaps.apply({ id: "sess-1", recap: r });
  expect(recaps.map["sess-1"]).toBe(r);
});
