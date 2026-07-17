import { test, expect, vi, beforeEach } from "vitest";
import type { ReviewVerdict, PlanGate, RepoConfig } from "./types";

vi.mock("./api", () => ({
  getReviews: vi.fn(),
  getReviewingIds: vi.fn(),
  getPlanGates: vi.fn(),
  getPlanGatesInflight: vi.fn(),
  getRepoConfig: vi.fn(),
  putRepoConfig: vi.fn(),
}));

import { reviews, planGates, repoConfig } from "./reviews.svelte";
import {
  getReviews,
  getReviewingIds,
  getPlanGates,
  getPlanGatesInflight,
  getRepoConfig,
  putRepoConfig,
} from "./api";

/** Build a minimal RepoConfig with all required fields; override as needed. */
const rc = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  criticEnabled: true,
  criticAllPrs: false,
  criticSmellLensEnabled: false,
  autoAddressEnabled: false,
  learningsEnabled: true,
  autopilotEnabled: false,
  autoDrainEnabled: false,
  autoMergeEnabled: false,
  buildQueueEnabled: false,
  planGateEnabled: false,
  draftMode: false,
  signoffAuthority: "human",
  sandboxProfile: "trusted",
  defaultModel: "inherit",
  defaultEffort: "inherit",
  maxAuto: 1,
  autoLabel: "shepherd:auto",
  usageCeilingPct: 80,
  repoMode: "forge",
  autoOptimizeFlagged: false,
  manualStepsIssueEnabled: false,
  preWarmEpicLandingCi: false,
  hidden: false,
  previewStartScript: null,
  previewStartCommand: null,
  previewOpenMode: "ask",
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

const planGate = (id: string): PlanGate => ({
  sessionId: id,
  planHash: "abc123",
  decision: "approved",
  summary: "ok",
  body: "body",
  findings: [],
  round: 0,
  cap: 5,
  approved: true,
  plan: "PLAN",
  updatedAt: 0,
});

beforeEach(() => {
  reviews.map = {};
  reviews.reviewing = {};
  reviews.reviewerEnv = {};
  reviews.activity = {};
  planGates.map = {};
  planGates.reviewing = {};
  planGates.reviewerEnv = {};
  planGates.activity = {};
  repoConfig.enabled = {};
  repoConfig.autoAddress = {};
  repoConfig.learnings = {};
  repoConfig.autopilot = {};
  repoConfig.autoDrain = {};
  repoConfig.autoMerge = {};
  repoConfig.buildQueue = {};
  repoConfig.autoOptimize = {};
  repoConfig.planGate = {};
  repoConfig.draftMode = {};
  repoConfig.allPrs = {};
  repoConfig.signoffAuthority = {};
  repoConfig.repoMode = {};
  repoConfig.sandboxProfile = {};
  repoConfig.defaultModel = {};
  repoConfig.defaultEffort = {};
  repoConfig.previewOpenMode = {};
  repoConfig.maxAuto = {};
  repoConfig.autoLabel = {};
  repoConfig.usageCeiling = {};
  repoConfig.confirmed = {};
  repoConfig.rowExists = {};
  repoConfig.settled = {};
  repoConfig.loaded = {};
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

test("setActivity records the critic's latest tool-use", () => {
  reviews.setActivity("s1", "$ git diff main...HEAD");
  expect(reviews.activityFor("s1")).toBe("$ git diff main...HEAD");
});

test("activityFor returns null for an unknown id", () => {
  expect(reviews.activityFor("nope")).toBeNull();
});

test("ending the review (setReviewing false) clears its live activity", () => {
  reviews.setReviewing("s1", true);
  reviews.setActivity("s1", "read review.ts");
  reviews.setReviewing("s1", false);
  expect(reviews.activityFor("s1")).toBeNull();
});

test("applying a verdict clears the live activity too", () => {
  reviews.setReviewing("s1", true);
  reviews.setActivity("s1", "read review.ts");
  reviews.apply({ id: "s1", review: verdict("s1") });
  expect(reviews.activityFor("s1")).toBeNull();
});

test("setActivity ignores an unchanged value (no reactive churn)", () => {
  reviews.setActivity("s1", "$ git log");
  const before = reviews.activity;
  reviews.setActivity("s1", "$ git log"); // identical → same object reference kept
  expect(reviews.activity).toBe(before);
});

// ── review activity feed: rolling window + staleness invariant ──────────────
// No line from a prior run or from before a reconnect may leak into a later in-flight preview.
// Guaranteed by three reset points, verified below for BOTH stores: start (OFF→ON), end
// (ON→OFF), and bootstrap/resync.

test("reviews activityFeed accumulates distinct lines newest-last, capped at 2", () => {
  reviews.setReviewing("s1", true);
  for (const l of ["a", "b", "c", "d", "e"]) reviews.setActivity("s1", l);
  expect(reviews.activityFeed("s1")).toEqual(["d", "e"]); // older lines dropped (cap MAX_ACTIVITY_LINES)
  expect(reviews.activityFor("s1")).toBe("e"); // badge tooltip = newest line
});

test("reviews activityFeed dedups a repeated last line", () => {
  reviews.setActivity("s1", "a");
  reviews.setActivity("s1", "a");
  reviews.setActivity("s1", "b");
  expect(reviews.activityFeed("s1")).toEqual(["a", "b"]);
});

test("reviews activityFeed returns [] for an unknown id", () => {
  expect(reviews.activityFeed("nope")).toEqual([]);
});

test("reviews: starting a review resets a leftover feed (defensive against a missed end-clear)", () => {
  // straggler feed present while NOT reviewing (a missed end-clear from a prior run)
  reviews.setActivity("s1", "stale-from-prior-run");
  expect(reviews.activityFeed("s1")).toEqual(["stale-from-prior-run"]);
  reviews.setReviewing("s1", true); // OFF→ON must wipe it — a new run starts empty
  expect(reviews.activityFeed("s1")).toEqual([]);
});

test("reviews: drop clears the live activity feed", () => {
  reviews.setReviewing("s1", true);
  reviews.setActivity("s1", "read x");
  reviews.drop("s1");
  expect(reviews.activityFeed("s1")).toEqual([]);
});

test("reviews.load wipes any stale feed, even for a still-in-flight id", async () => {
  reviews.setReviewing("s7", true);
  reviews.setActivity("s7", "line from before the resync");
  vi.mocked(getReviews).mockResolvedValue({});
  vi.mocked(getReviewingIds).mockResolvedValue([
    { id: "s7", provider: "codex", model: "gpt-5.5", effort: "high" },
  ]); // snapshot: s7 still in flight
  await reviews.load();
  expect(reviews.isReviewing("s7")).toBe(true); // still in flight…
  expect(reviews.reviewerEnvFor("s7")).toEqual({
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
  });
  expect(reviews.activityFeed("s7")).toEqual([]); // …but feed wiped; rebuilds from live events
});

test("reviews.setReviewing caches, refreshes, and clears the critic reviewer env", () => {
  reviews.setReviewing("ce", true, { provider: "claude", model: "opus", effort: "high" });
  reviews.setActivity("ce", "read review.ts");
  expect(reviews.reviewerEnvFor("ce")).toEqual({
    provider: "claude",
    model: "opus",
    effort: "high",
  });

  reviews.setReviewing("ce", true, { provider: "codex", model: "gpt-5.5", effort: "low" });

  expect(reviews.reviewerEnvFor("ce")).toEqual({
    provider: "codex",
    model: "gpt-5.5",
    effort: "low",
  });
  expect(reviews.activityFeed("ce")).toEqual(["read review.ts"]);
  reviews.setReviewing("ce", false);
  expect(reviews.reviewerEnvFor("ce")).toBeNull();
});

// ── plan-gate activity feed: mirrors ReviewsStore ──────────────────────────

test("planGates activityFeed accumulates, dedups, and resets on the ON→OFF transition", () => {
  planGates.applyReviewing("p1", true);
  planGates.setActivity("p1", "read plan");
  planGates.setActivity("p1", "read plan"); // dedup
  planGates.setActivity("p1", "$ git diff");
  expect(planGates.activityFeed("p1")).toEqual(["read plan", "$ git diff"]);
  planGates.applyReviewing("p1", false); // end → clear
  expect(planGates.activityFeed("p1")).toEqual([]);
});

test("planGates: a leftover feed is wiped when a new review starts", () => {
  planGates.setActivity("p1", "stale"); // straggler while not reviewing
  planGates.applyReviewing("p1", true); // OFF→ON must wipe it
  expect(planGates.activityFeed("p1")).toEqual([]);
});

test("planGates: applying a verdict clears the feed", () => {
  planGates.applyReviewing("p1", true);
  planGates.setActivity("p1", "read plan");
  planGates.apply("p1", planGate("p1"));
  expect(planGates.activityFeed("p1")).toEqual([]);
});

test("planGates: drop clears the feed", () => {
  planGates.applyReviewing("p1", true);
  planGates.setActivity("p1", "read plan");
  planGates.drop("p1");
  expect(planGates.activityFeed("p1")).toEqual([]);
});

test("planGates.load wipes any stale feed, even for a still-in-flight id", async () => {
  planGates.applyReviewing("p9", true);
  planGates.setActivity("p9", "line before resync");
  vi.mocked(getPlanGates).mockResolvedValue({});
  vi.mocked(getPlanGatesInflight).mockResolvedValue([
    { id: "p9", provider: "claude", model: "opus", effort: "high" },
  ]);
  await planGates.load();
  expect(planGates.isReviewing("p9")).toBe(true);
  expect(planGates.activityFeed("p9")).toEqual([]);
});

test("planGates.applyReviewing caches reviewer env and refreshes on a redundant true", () => {
  planGates.applyReviewing("pe", true, { provider: "claude", model: "opus", effort: "high" });
  expect(planGates.reviewerEnvFor("pe")).toEqual({
    provider: "claude",
    model: "opus",
    effort: "high",
  });
  // A redundant `true` (no transition) must still refresh the identity.
  planGates.applyReviewing("pe", true, { provider: "codex", model: "gpt-5.5", effort: "low" });
  expect(planGates.reviewerEnvFor("pe")).toEqual({
    provider: "codex",
    model: "gpt-5.5",
    effort: "low",
  });
  // End clears it.
  planGates.applyReviewing("pe", false);
  expect(planGates.reviewerEnvFor("pe")).toBeNull();
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
  vi.mocked(getReviewingIds).mockResolvedValue([
    { id: "s3", provider: "claude", model: "opus", effort: "high" },
  ]);
  await reviews.load();
  expect(reviews.map["s2"]).toEqual(v);
  expect(reviews.isReviewing("s3")).toBe(true);
  expect(reviews.reviewerEnvFor("s3")).toEqual({
    provider: "claude",
    model: "opus",
    effort: "high",
  });
});

test("repoConfig.ensure fetches and caches", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ criticEnabled: false }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.isEnabled("/repo")).toBe(false);
  expect(repoConfig.isConfigLoaded("/repo")).toBe(true);
  // second call should NOT fetch again
  await repoConfig.ensure("/repo");
  expect(getRepoConfig).toHaveBeenCalledTimes(1);
});

test("repoConfig.ensure dedupes concurrent fetches", async () => {
  let resolveConfig: (config: RepoConfig) => void = () => {};
  vi.mocked(getRepoConfig).mockReturnValue(
    new Promise((resolve) => {
      resolveConfig = resolve;
    }),
  );
  const first = repoConfig.ensure("/repo");
  const second = repoConfig.ensure("/repo");
  expect(getRepoConfig).toHaveBeenCalledTimes(1);
  resolveConfig(rc({ previewOpenMode: "tab" }));
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  expect(repoConfig.previewOpenModeForLoaded("/repo")).toBe("tab");
});

test("repoConfig preview open mode requires a successful load", async () => {
  expect(repoConfig.previewOpenModeFor("/repo")).toBe("ask");
  expect(repoConfig.previewOpenModeForLoaded("/repo")).toBeNull();
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ previewOpenMode: "inline" }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.previewOpenModeForLoaded("/repo")).toBe("inline");
});

test("repoConfig failed ensure settles and falls back to ask for preview mode", async () => {
  vi.mocked(getRepoConfig).mockRejectedValueOnce(new Error("network"));
  await expect(repoConfig.ensure("/repo")).resolves.toBe(false);
  expect(repoConfig.isConfigSettled("/repo")).toBe(true);
  expect(repoConfig.isConfigLoaded("/repo")).toBe(false);
  expect(repoConfig.previewOpenModeForLoaded("/repo")).toBe("ask");
});

test("repoConfig successful PUT marks loaded after a failed GET", async () => {
  vi.mocked(getRepoConfig).mockRejectedValueOnce(new Error("network"));
  await repoConfig.ensure("/repo");
  expect(repoConfig.isConfigLoaded("/repo")).toBe(false);
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ previewOpenMode: "tab" }));
  await repoConfig.setPreviewOpenMode("/repo", "tab");
  expect(repoConfig.isConfigLoaded("/repo")).toBe(true);
  expect(repoConfig.previewOpenModeForLoaded("/repo")).toBe("tab");
});

test("repoConfig.isAllPrsEnabled defaults to false for unknown repo", () => {
  expect(repoConfig.isAllPrsEnabled("/unknown")).toBe(false);
});

test("repoConfig.toggleAllPrs flips the flag and sends only that field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ criticAllPrs: true }));
  repoConfig.allPrs = { "/repo": false };
  await repoConfig.toggleAllPrs("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { criticAllPrs: true });
  expect(repoConfig.isAllPrsEnabled("/repo")).toBe(true);
});

test("repoConfig.toggleAllPrs reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.allPrs = { "/repo": true };
  await repoConfig.toggleAllPrs("/repo");
  expect(repoConfig.isAllPrsEnabled("/repo")).toBe(true); // reverted to prev
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

// ── draft mode ─────────────────────────────────────────────────────────────

test("repoConfig.isDraftModeEnabled defaults to false for unknown repo", () => {
  expect(repoConfig.isDraftModeEnabled("/unknown")).toBe(false);
});

test("repoConfig.signoffAuthorityFor defaults to human for unknown repo", () => {
  expect(repoConfig.signoffAuthorityFor("/unknown")).toBe("human");
});

test("repoConfig.ensure caches draftMode and signoffAuthority", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ draftMode: true, signoffAuthority: "critic" }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(true);
  expect(repoConfig.signoffAuthorityFor("/repo")).toBe("critic");
});

test("repoConfig.toggleDraftMode flips draftMode and sends the field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ draftMode: true }));
  repoConfig.draftMode = { "/repo": false };
  await repoConfig.toggleDraftMode("/repo");
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(true);
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { draftMode: true, autoMergeEnabled: false });
});

test("repoConfig.toggleDraftMode ON forces autoMerge OFF", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ draftMode: true, autoMergeEnabled: false }));
  repoConfig.draftMode = { "/repo": false };
  repoConfig.autoMerge = { "/repo": true };
  await repoConfig.toggleDraftMode("/repo");
  expect(repoConfig.isAutoMergeEnabled("/repo")).toBe(false);
});

test("repoConfig.toggleDraftMode OFF does NOT touch autoMerge", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ draftMode: false, autoMergeEnabled: false }));
  repoConfig.draftMode = { "/repo": true };
  repoConfig.autoMerge = { "/repo": false };
  await repoConfig.toggleDraftMode("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { draftMode: false });
});

test("repoConfig.toggleDraftMode reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.draftMode = { "/repo": false };
  await repoConfig.toggleDraftMode("/repo");
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(false); // reverted
});

test("repoConfig.toggleDraftMode ON reverts the paired autoMerge:false on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.draftMode = { "/repo": false };
  repoConfig.autoMerge = { "/repo": true };
  await repoConfig.toggleDraftMode("/repo");
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(false); // reverted
  expect(repoConfig.isAutoMergeEnabled("/repo")).toBe(true); // paired field restored
});

test("repoConfig.toggleAutoMerge ON reverts the paired draftMode:false on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.autoMerge = { "/repo": false };
  repoConfig.draftMode = { "/repo": true };
  await repoConfig.toggleAutoMerge("/repo");
  expect(repoConfig.isAutoMergeEnabled("/repo")).toBe(false); // reverted
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(true); // paired field restored
});

test("repoConfig.toggleAutoMerge ON forces draftMode OFF", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autoMergeEnabled: true, draftMode: false }));
  repoConfig.autoMerge = { "/repo": false };
  repoConfig.draftMode = { "/repo": true };
  await repoConfig.toggleAutoMerge("/repo");
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(false);
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoMergeEnabled: true, draftMode: false });
});

test("repoConfig.toggleAutoMerge OFF does NOT touch draftMode", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autoMergeEnabled: false }));
  repoConfig.autoMerge = { "/repo": true };
  repoConfig.draftMode = { "/repo": false };
  await repoConfig.toggleAutoMerge("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoMergeEnabled: false });
});

test("repoConfig.setSignoffAuthority updates the value", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ signoffAuthority: "either" }));
  await repoConfig.setSignoffAuthority("/repo", "either");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { signoffAuthority: "either" });
  expect(repoConfig.signoffAuthorityFor("/repo")).toBe("either");
});

test("repoConfig.setSignoffAuthority reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.signoffAuthority = { "/repo": "human" };
  await repoConfig.setSignoffAuthority("/repo", "critic");
  expect(repoConfig.signoffAuthorityFor("/repo")).toBe("human"); // reverted
});

// ── repoMode ───────────────────────────────────────────────────────────────

test("repoConfig.repoModeFor defaults to forge for unknown repo", () => {
  expect(repoConfig.repoModeFor("/unknown")).toBe("forge");
});

test("repoConfig.setRepoMode updates the value optimistically", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ repoMode: "lightweight" }));
  await repoConfig.setRepoMode("/repo", "lightweight");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { repoMode: "lightweight" });
  expect(repoConfig.repoModeFor("/repo")).toBe("lightweight");
});

test("repoConfig.setRepoMode reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.repoMode = { "/repo": "forge" };
  await repoConfig.setRepoMode("/repo", "lightweight");
  expect(repoConfig.repoModeFor("/repo")).toBe("forge"); // reverted
});

test("repoConfig.ensure caches repoMode", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ repoMode: "lightweight" }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.repoModeFor("/repo")).toBe("lightweight");
});

// ── autoOptimize ───────────────────────────────────────────────────────────

test("repoConfig.autoOptimizeOn defaults to false for unknown repo", () => {
  expect(repoConfig.autoOptimizeOn("/unknown")).toBe(false);
});

test("repoConfig.autoOptimizeOn reflects set value", () => {
  repoConfig.autoOptimize = { "/repo": true };
  expect(repoConfig.autoOptimizeOn("/repo")).toBe(true);
});

test("repoConfig.ensure caches autoOptimizeFlagged", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue(rc({ autoOptimizeFlagged: true }));
  await repoConfig.ensure("/repo");
  expect(repoConfig.autoOptimizeOn("/repo")).toBe(true);
});

test("repoConfig.toggleAutoOptimize flips the flag and sends only that field", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ autoOptimizeFlagged: true }));
  repoConfig.autoOptimize = { "/repo": false };
  await repoConfig.toggleAutoOptimize("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { autoOptimizeFlagged: true });
  expect(repoConfig.autoOptimizeOn("/repo")).toBe(true);
});

test("repoConfig.toggleAutoOptimize reverts on error", async () => {
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  repoConfig.autoOptimize = { "/repo": true };
  await repoConfig.toggleAutoOptimize("/repo");
  expect(repoConfig.autoOptimizeOn("/repo")).toBe(true); // reverted to prev
});

// ── automationConfirmed / automationRowExists (issue #1025) ────────────────

test("repoConfig.isAutomationConfirmed defaults to false for unknown repo", () => {
  expect(repoConfig.isAutomationConfirmed("/unknown")).toBe(false);
});

test("repoConfig.automationRowExists defaults to false for unknown repo", () => {
  expect(repoConfig.automationRowExists("/unknown")).toBe(false);
});

test("ensure ingests automationConfirmed and automationRowExists from response", async () => {
  vi.mocked(getRepoConfig).mockResolvedValue({
    ...rc(),
    automationConfirmed: true,
    automationRowExists: true,
  });
  await repoConfig.ensure("/repo");
  expect(repoConfig.isAutomationConfirmed("/repo")).toBe(true);
  expect(repoConfig.automationRowExists("/repo")).toBe(true);
});

test("ensure: response WITHOUT the new fields does NOT clobber already-set confirmed/rowExists", async () => {
  // Pre-seed the maps as if a previous fetch had set them
  repoConfig.confirmed = { "/repo": true };
  repoConfig.rowExists = { "/repo": true };
  // Force a re-fetch by clearing `enabled` (ensure bails early if enabled is set)
  repoConfig.enabled = {};
  vi.mocked(getRepoConfig).mockResolvedValue(rc()); // no automationConfirmed / automationRowExists
  await repoConfig.ensure("/repo");
  // maps must NOT be clobbered to false/undefined
  expect(repoConfig.isAutomationConfirmed("/repo")).toBe(true);
  expect(repoConfig.automationRowExists("/repo")).toBe(true);
});

test("seedNewRepoDefaults calls putRepoConfig with planGateEnabled:true and sets planGate true", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(rc({ planGateEnabled: true }));
  await repoConfig.seedNewRepoDefaults("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { planGateEnabled: true });
  expect(repoConfig.isPlanGateEnabled("/repo")).toBe(true);
});

test("confirmAutomation calls putRepoConfig with automationConfirmed:true and sets confirmed true", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue({
    ...rc(),
    automationConfirmed: true,
    automationRowExists: true,
  });
  await repoConfig.confirmAutomation("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", { automationConfirmed: true });
  expect(repoConfig.isAutomationConfirmed("/repo")).toBe(true);
});

test("confirmAutomation reverts confirmed and rethrows on PUT failure", async () => {
  repoConfig.confirmed = { "/repo": false };
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("network error"));
  await expect(repoConfig.confirmAutomation("/repo")).rejects.toThrow("network error");
  expect(repoConfig.isAutomationConfirmed("/repo")).toBe(false); // reverted
});

test("applyHandsOffDefaults PUTs the hands-off patch and never touches plan gate", async () => {
  vi.mocked(putRepoConfig).mockResolvedValue(
    rc({
      autopilotEnabled: true,
      autoMergeEnabled: true,
      criticEnabled: true,
      autoAddressEnabled: true,
    }),
  );
  await repoConfig.applyHandsOffDefaults("/repo");
  expect(putRepoConfig).toHaveBeenCalledWith("/repo", {
    autopilotEnabled: true,
    autoMergeEnabled: true,
    draftMode: false,
    criticEnabled: true,
    autoAddressEnabled: true,
  });
  // Plan gate is recommended ON (seeded default) and hands-off-safe — Apply must never flip it.
  const patch = vi.mocked(putRepoConfig).mock.calls[0][1];
  expect(patch).not.toHaveProperty("planGateEnabled");
  expect(repoConfig.isAutopilotEnabled("/repo")).toBe(true);
  expect(repoConfig.isAutoMergeEnabled("/repo")).toBe(true);
  expect(repoConfig.isDraftModeEnabled("/repo")).toBe(false);
});

test("applyHandsOffDefaults reverts every optimistic field AND rethrows on a failed PUT", async () => {
  repoConfig.autopilot = { "/repo": false };
  repoConfig.autoMerge = { "/repo": false };
  repoConfig.autoAddress = { "/repo": false };
  vi.mocked(putRepoConfig).mockRejectedValueOnce(new Error("boom"));
  // Rethrows so the caller can surface the failure instead of latching "applied".
  await expect(repoConfig.applyHandsOffDefaults("/repo")).rejects.toThrow("boom");
  expect(repoConfig.isAutopilotEnabled("/repo")).toBe(false);
  expect(repoConfig.isAutoMergeEnabled("/repo")).toBe(false);
  expect(repoConfig.isAutoAddressEnabled("/repo")).toBe(false);
});
