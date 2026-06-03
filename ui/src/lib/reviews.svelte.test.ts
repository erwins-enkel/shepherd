import { test, expect, vi, beforeEach } from "vitest";
import type { ReviewVerdict } from "./types";

vi.mock("./api", () => ({
  getReviews: vi.fn(),
  getReviewingIds: vi.fn(),
  getRepoConfig: vi.fn(),
  putRepoConfig: vi.fn(),
}));

import { reviews, repoConfig } from "./reviews.svelte";
import { getReviews, getReviewingIds, getRepoConfig, putRepoConfig } from "./api";

const verdict = (id: string): ReviewVerdict => ({
  sessionId: id,
  headSha: "abc123",
  decision: "changes_requested",
  summary: "test summary",
  body: "test body",
  findings: [],
  addressRound: 0,
  addressCap: 3,
  updatedAt: 0,
});

beforeEach(() => {
  reviews.map = {};
  reviews.reviewing = {};
  repoConfig.enabled = {};
  repoConfig.autoAddress = {};
  repoConfig.learnings = {};
  vi.clearAllMocks();
});

test("setReviewing toggles the in-flight flag", () => {
  reviews.setReviewing("s1", true);
  expect(reviews.isReviewing("s1")).toBe(true);
  reviews.setReviewing("s1", false);
  expect(reviews.isReviewing("s1")).toBe(false);
});

test("applying a verdict clears the reviewing flag", () => {
  reviews.setReviewing("s1", true);
  reviews.apply({ id: "s1", review: verdict("s1") });
  expect(reviews.isReviewing("s1")).toBe(false);
});

test("drop clears the reviewing flag", () => {
  reviews.setReviewing("s1", true);
  reviews.drop("s1");
  expect(reviews.isReviewing("s1")).toBe(false);
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
  vi.mocked(putRepoConfig).mockResolvedValue({
    criticEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
  repoConfig.enabled = { "/repo": true };
  await repoConfig.toggle("/repo");
  expect(repoConfig.isEnabled("/repo")).toBe(false);
});

test("repoConfig.toggle defaults to false when state unknown (default-on)", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({
    criticEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
  // unknown repo → isEnabled returns true → toggle should flip to false
  await repoConfig.toggle("/new-repo");
  expect(repoConfig.isEnabled("/new-repo")).toBe(false);
});

test("reviews.load populates map and in-flight ids from api", async () => {
  const v = verdict("s2");
  vi.mocked(getReviews).mockResolvedValue({ s2: v });
  vi.mocked(getReviewingIds).mockResolvedValue(["s3"]);
  await reviews.load();
  expect(reviews.map["s2"]).toEqual(v);
  expect(reviews.isReviewing("s3")).toBe(true);
});

test("repoConfig.ensure fetches and caches", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue({
    criticEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
  await repoConfig.ensure("/repo");
  expect(repoConfig.isEnabled("/repo")).toBe(false);
  // second call should NOT fetch again
  await repoConfig.ensure("/repo");
  expect(getRepoConfig).toHaveBeenCalledTimes(1);
});

test("repoConfig.isAutoAddressEnabled defaults to false for unknown repo", () => {
  expect(repoConfig.isAutoAddressEnabled("/unknown")).toBe(false);
});

test("repoConfig.ensure caches the auto-address flag too", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue({
    criticEnabled: true,
    autoAddressEnabled: true,
    learningsEnabled: true,
  });
  await repoConfig.ensure("/repo");
  expect(repoConfig.isAutoAddressEnabled("/repo")).toBe(true);
});

test("repoConfig.toggleAutoAddress flips the flag and sends only that field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({
    criticEnabled: true,
    autoAddressEnabled: true,
    learningsEnabled: true,
  });
  repoConfig.autoAddress = { "/repo": false };
  await repoConfig.toggleAutoAddress("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoAddressEnabled: true });
  expect(repoConfig.isAutoAddressEnabled("/repo")).toBe(true);
});

test("repoConfig.toggle sends only the criticEnabled field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({
    criticEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
  repoConfig.enabled = { "/repo": true };
  await repoConfig.toggle("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { criticEnabled: false });
});

test("repoConfig.learningsOn returns true for unknown repo (default-on)", () => {
  expect(repoConfig.learningsOn("/some/unknown/repo")).toBe(true);
});

test("repoConfig.learningsOn reflects set value", () => {
  repoConfig.learnings = { "/repo": false };
  expect(repoConfig.learningsOn("/repo")).toBe(false);
});

test("repoConfig.toggleLearnings flips learnings state", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: false,
  });
  repoConfig.learnings = { "/repo": true };
  await repoConfig.toggleLearnings("/repo");
  expect(repoConfig.learningsOn("/repo")).toBe(false);
});

test("repoConfig.toggleLearnings reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.learnings = { "/repo": true };
  await repoConfig.toggleLearnings("/repo");
  expect(repoConfig.learningsOn("/repo")).toBe(true); // reverted to prev
});
