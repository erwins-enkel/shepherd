import { test, expect, vi, beforeEach } from "vitest";
import type { Recap } from "./types";

vi.mock("./api", () => ({
  getRecaps: vi.fn(),
  getSessionRecap: vi.fn(),
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

test("detail reads stay local and ignore a superseded session response", async () => {
  const { RecapDetailState } = await import("./recaps.svelte");
  const { getSessionRecap } = await import("./api");
  let resolveA!: (value: Recap) => void;
  vi.mocked(getSessionRecap).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveA = resolve;
      }),
  );
  vi.mocked(getSessionRecap).mockResolvedValueOnce({ ...recap("b"), blocks: [] });
  const detail = new RecapDetailState();
  expect(getSessionRecap).not.toHaveBeenCalled();
  const old = detail.load("a", recap("a"));
  await detail.load("b", recap("b"));
  resolveA({ ...recap("a"), blocks: [{ type: "rich-text", id: "old", markdown: "OLD" }] });
  await old;
  expect(detail.current("b", recap("b"))?.blocks).toEqual([]);
  expect(detail.current("a", recap("a"))).toBeUndefined();
  expect(recaps.map).toEqual({});
});

test("detail version changes hide old blocks; close invalidates pending reads; retry recovers", async () => {
  const { RecapDetailState } = await import("./recaps.svelte");
  const { getSessionRecap } = await import("./api");
  const detail = new RecapDetailState();
  vi.mocked(getSessionRecap).mockResolvedValueOnce({ ...recap("a"), blocks: [] });
  await detail.load("a", recap("a"));
  expect(detail.current("a", { ...recap("a"), updatedAt: 2000 })).toBeUndefined();
  vi.mocked(getSessionRecap).mockRejectedValueOnce(new Error("404"));
  await detail.load("a", recap("a"));
  expect(detail.error).toBe(true);
  expect(detail.loading).toBe(false);
  vi.mocked(getSessionRecap).mockResolvedValueOnce(recap("a"));
  await detail.load("a", recap("a"));
  expect(detail.error).toBe(false);
  expect(detail.current("a", recap("a"))?.headline).toBe("All done");
  let resolve!: (value: Recap) => void;
  vi.mocked(getSessionRecap).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = detail.load("a", recap("a"));
  detail.clear();
  resolve(recap("a"));
  await pending;
  expect(detail.current("a", recap("a"))).toBeUndefined();
});

test("a stale detail response is retryable instead of silently hiding the missing diff", async () => {
  const { RecapDetailState } = await import("./recaps.svelte");
  const { getSessionRecap } = await import("./api");
  const summary = { ...recap("a"), updatedAt: 2000 };
  vi.mocked(getSessionRecap).mockResolvedValueOnce(recap("a"));
  const detail = new RecapDetailState();
  await detail.load("a", summary);
  expect(detail.error).toBe(true);
  expect(detail.current("a", summary)).toBeUndefined();
});
