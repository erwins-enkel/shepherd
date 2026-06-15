import { test, expect, vi, beforeEach } from "vitest";
import type { HerdDigest } from "./types";

vi.mock("./api", () => ({
  getHerdDigest: vi.fn(),
}));

import { herdDigest } from "./herd-digest.svelte";
import { getHerdDigest } from "./api";

const digest = (dayKey: string): HerdDigest => ({
  dayKey,
  state: "ready",
  overnight: "All quiet overnight.",
  decisions: [],
  ciRework: [],
  train: "no train",
  focusNext: [],
  attentionFingerprint: {},
  spawnSessionId: "spawn-1",
  cwd: "/repo",
  model: null,
  spawnedAt: 0,
  generatedAt: 1000,
  updatedAt: 1000,
});

beforeEach(() => {
  herdDigest.digest = null;
  herdDigest.loaded = false;
  vi.clearAllMocks();
});

test("load() populates digest from api", async () => {
  const d = digest("2026-06-15");
  vi.mocked(getHerdDigest).mockResolvedValue(d);
  await herdDigest.load();
  expect(herdDigest.digest).toEqual(d);
  expect(herdDigest.loaded).toBe(true);
});

test("load() tolerates a null body (no digest yet)", async () => {
  vi.mocked(getHerdDigest).mockResolvedValue(null);
  await herdDigest.load();
  expect(herdDigest.digest).toBeNull();
  expect(herdDigest.loaded).toBe(true);
});

test("load() swallows api errors (best-effort) but still marks loaded", async () => {
  vi.mocked(getHerdDigest).mockRejectedValue(new Error("network error"));
  await expect(herdDigest.load()).resolves.toBeUndefined();
  expect(herdDigest.digest).toBeNull();
  expect(herdDigest.loaded).toBe(true);
});

test("apply({digest}) sets the digest", () => {
  const d = digest("2026-06-15");
  herdDigest.apply({ digest: d });
  expect(herdDigest.digest).toBe(d);
});

test("apply() replaces an existing digest (newest wins)", () => {
  herdDigest.apply({ digest: digest("2026-06-14") });
  const newer = digest("2026-06-15");
  herdDigest.apply({ digest: newer });
  expect(herdDigest.digest).toBe(newer);
});
