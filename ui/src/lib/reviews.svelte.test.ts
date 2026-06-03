import { test, expect, vi, beforeEach } from "vitest";
import type { ReviewVerdict, RepoConfig } from "./types";

vi.mock("./api", () => ({
  getReviews: vi.fn(),
  getReviewingIds: vi.fn(),
  getRepoConfig: vi.fn(),
  putRepoConfig: vi.fn(),
}));

import { reviews, repoConfig } from "./reviews.svelte";
import { getReviews, getReviewingIds, getRepoConfig, putRepoConfig } from "./api";

/** Build a minimal RepoConfig with all required fields; override as needed. */
const rc = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  criticEnabled: true,
  autoAddressEnabled: false,
  learningsEnabled: true,
  autopilotEnabled: false,
  autoDrainEnabled: false,
  maxAuto: 1,
  autoLabel: "shepherd:auto",
  usageCeilingPct: 80,
  ...overrides,
});

const verdict = (id: string): ReviewVerdict => ({
  sessionId: id,
  headSha: "abc123",
  decision: "changes_requested",
  summary: "test summary",
  body: "test body",
  findings: [],
  addressRound: 0,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: 0,
});

beforeEach(() => {
  reviews.map = {};
  reviews.reviewing = {};
  repoConfig.enabled = {};
  repoConfig.autoAddress = {};
  repoConfig.learnings = {};
  repoConfig.autopilot = {};
  repoConfig.autoDrain = {};
  repoConfig.maxAuto = {};
  repoConfig.autoLabel = {};
  repoConfig.usageCeiling = {};
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
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ criticEnabled: false }));
  repoConfig.enabled = { "/repo": true };
  await repoConfig.toggle("/repo");
  expect(repoConfig.isEnabled("/repo")).toBe(false);
});

test("repoConfig.toggle defaults to false when state unknown (default-on)", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ criticEnabled: false }));
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
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ criticEnabled: false }));
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
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ autoAddressEnabled: true }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.isAutoAddressEnabled("/repo")).toBe(true);
});

test("repoConfig.toggleAutoAddress flips the flag and sends only that field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autoAddressEnabled: true }));
  repoConfig.autoAddress = { "/repo": false };
  await repoConfig.toggleAutoAddress("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoAddressEnabled: true });
  expect(repoConfig.isAutoAddressEnabled("/repo")).toBe(true);
});

test("repoConfig.toggle sends only the criticEnabled field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ criticEnabled: false }));
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
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ learningsEnabled: false }));
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

test("repoConfig.isAutopilotEnabled defaults to false for unknown repo", () => {
  expect(repoConfig.isAutopilotEnabled("/unknown")).toBe(false);
});

test("repoConfig.isAutopilotEnabled reflects set value", () => {
  repoConfig.autopilot = { "/repo": true };
  expect(repoConfig.isAutopilotEnabled("/repo")).toBe(true);
});

test("repoConfig.ensure caches the autopilot flag too", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ autopilotEnabled: true }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.isAutopilotEnabled("/repo")).toBe(true);
});

test("repoConfig.toggleAutopilot flips the flag and sends only that field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autopilotEnabled: true }));
  repoConfig.autopilot = { "/repo": false };
  await repoConfig.toggleAutopilot("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autopilotEnabled: true });
  expect(repoConfig.isAutopilotEnabled("/repo")).toBe(true);
});

test("repoConfig.toggleAutopilot reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.autopilot = { "/repo": true };
  await repoConfig.toggleAutopilot("/repo");
  expect(repoConfig.isAutopilotEnabled("/repo")).toBe(true); // reverted to prev
});

// ── drain config getters / defaults ────────────────────────────────────────

test("repoConfig.isAutoDrainEnabled defaults to false for unknown repo", () => {
  expect(repoConfig.isAutoDrainEnabled("/unknown")).toBe(false);
});

test("repoConfig.maxAutoFor defaults to 1 for unknown repo", () => {
  expect(repoConfig.maxAutoFor("/unknown")).toBe(1);
});

test("repoConfig.autoLabelFor defaults to shepherd:auto for unknown repo", () => {
  expect(repoConfig.autoLabelFor("/unknown")).toBe("shepherd:auto");
});

test("repoConfig.usageCeilingFor defaults to 80 for unknown repo", () => {
  expect(repoConfig.usageCeilingFor("/unknown")).toBe(80);
});

test("repoConfig.ensure caches all drain fields", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue(
    rc({ autoDrainEnabled: true, maxAuto: 3, autoLabel: "my-label", usageCeilingPct: 70 }),
  );
  await repoConfig.ensure("/repo");
  expect(repoConfig.isAutoDrainEnabled("/repo")).toBe(true);
  expect(repoConfig.maxAutoFor("/repo")).toBe(3);
  expect(repoConfig.autoLabelFor("/repo")).toBe("my-label");
  expect(repoConfig.usageCeilingFor("/repo")).toBe(70);
});

test("repoConfig.toggleAutoDrain flips the flag and sends only that field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autoDrainEnabled: true }));
  repoConfig.autoDrain = { "/repo": false };
  await repoConfig.toggleAutoDrain("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoDrainEnabled: true });
  expect(repoConfig.isAutoDrainEnabled("/repo")).toBe(true);
});

test("repoConfig.toggleAutoDrain reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.autoDrain = { "/repo": true };
  await repoConfig.toggleAutoDrain("/repo");
  expect(repoConfig.isAutoDrainEnabled("/repo")).toBe(true); // reverted
});

test("repoConfig.setMaxAuto updates the value", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ maxAuto: 5 }));
  await repoConfig.setMaxAuto("/repo", 5);
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { maxAuto: 5 });
  expect(repoConfig.maxAutoFor("/repo")).toBe(5);
});

test("repoConfig.setAutoLabel updates the label", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autoLabel: "custom" }));
  await repoConfig.setAutoLabel("/repo", "custom");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoLabel: "custom" });
  expect(repoConfig.autoLabelFor("/repo")).toBe("custom");
});

test("repoConfig.setUsageCeiling updates the threshold", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ usageCeilingPct: 60 }));
  await repoConfig.setUsageCeiling("/repo", 60);
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { usageCeilingPct: 60 });
  expect(repoConfig.usageCeilingFor("/repo")).toBe(60);
});

test("repoConfig.setMaxAuto reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.maxAuto = { "/repo": 3 };
  await repoConfig.setMaxAuto("/repo", 7);
  expect(repoConfig.maxAutoFor("/repo")).toBe(3); // reverted
});

test("repoConfig.setAutoLabel reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.autoLabel = { "/repo": "shepherd:auto" };
  await repoConfig.setAutoLabel("/repo", "custom-label");
  expect(repoConfig.autoLabelFor("/repo")).toBe("shepherd:auto"); // reverted
});

test("repoConfig.setUsageCeiling reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.usageCeiling = { "/repo": 80 };
  await repoConfig.setUsageCeiling("/repo", 50);
  expect(repoConfig.usageCeilingFor("/repo")).toBe(80); // reverted
});
