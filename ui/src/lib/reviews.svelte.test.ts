import { test, expect, vi, beforeEach } from "vitest";
import type { ReviewVerdict } from "./types";

vi.mock("./api", () => ({
  getReviews: vi.fn(),
  getRepoConfig: vi.fn(),
  putRepoConfig: vi.fn(),
}));

import { reviews, repoConfig } from "./reviews.svelte";
import { getReviews, getRepoConfig, putRepoConfig } from "./api";

const verdict = (id: string): ReviewVerdict => ({
  sessionId: id,
  headSha: "abc123",
  decision: "changes_requested",
  summary: "test summary",
  body: "test body",
  updatedAt: 0,
});

beforeEach(() => {
  reviews.map = {};
  repoConfig.enabled = {};
  vi.clearAllMocks();
});

test("apply sets a verdict", () => {
  const v = verdict("s1");
  reviews.apply({ id: "s1", review: v });
  expect(reviews.map["s1"]).toBe(v);
});

test("apply with null removes the entry", () => {
  reviews.map = { s1: verdict("s1") };
  reviews.apply({ id: "s1", review: null });
  expect(reviews.map["s1"]).toBeUndefined();
});

test("drop removes an existing entry", () => {
  reviews.map = { s1: verdict("s1") };
  reviews.drop("s1");
  expect(reviews.map["s1"]).toBeUndefined();
});

test("drop is a no-op for unknown id", () => {
  reviews.map = { s1: verdict("s1") };
  reviews.drop("s2");
  expect(reviews.map["s1"]).toBeDefined();
});

test("repoConfig.isEnabled returns true for unknown repo (default-on)", () => {
  expect(repoConfig.isEnabled("/some/unknown/repo")).toBe(true);
});

test("repoConfig.isEnabled reflects set value", () => {
  repoConfig.enabled = { "/repo": false };
  expect(repoConfig.isEnabled("/repo")).toBe(false);
});

test("repoConfig.toggle flips enabled state", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({ criticEnabled: false });
  repoConfig.enabled = { "/repo": true };
  await repoConfig.toggle("/repo");
  expect(repoConfig.isEnabled("/repo")).toBe(false);
});

test("repoConfig.toggle defaults to false when state unknown (default-on)", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({ criticEnabled: false });
  // unknown repo → isEnabled returns true → toggle should flip to false
  await repoConfig.toggle("/new-repo");
  expect(repoConfig.isEnabled("/new-repo")).toBe(false);
});

test("reviews.load populates map from api", async () => {
  const v = verdict("s2");
  vi.mocked(getReviews).mockResolvedValue({ s2: v });
  await reviews.load();
  expect(reviews.map["s2"]).toEqual(v);
});

test("repoConfig.ensure fetches and caches", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue({ criticEnabled: false });
  await repoConfig.ensure("/repo");
  expect(repoConfig.isEnabled("/repo")).toBe(false);
  // second call should NOT fetch again
  await repoConfig.ensure("/repo");
  expect(getRepoConfig).toHaveBeenCalledTimes(1);
});
