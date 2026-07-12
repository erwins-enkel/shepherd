import { describe, expect, it } from "bun:test";
import { enrichLandingEpics } from "../src/completed-epic";
import type { CompletedEpic } from "../src/completed-epic";
import type { PrStatus } from "../src/forge/types";

// ── enrichLandingEpics: landingCiFailing ─────────────────────────────────────

describe("enrichLandingEpics — landingCiFailing", () => {
  const baseEpic = (over: Partial<CompletedEpic> = {}): CompletedEpic => ({
    repoPath: "/repo/a",
    parentIssueNumber: 7,
    parentTitle: "Epic A",
    completedAt: 1_000,
    children: [],
    landingPrNumber: 42,
    landingPrUrl: "http://x/42",
    landingState: "open",
    migrationPaths: [],
    migrationsAckedAt: null,
    landingRebasePauseReason: null,
    landingRepairCount: 0,
    landingRepairHead: null,
    ...over,
  });

  const prStatus = (over: Partial<PrStatus> = {}): PrStatus =>
    ({ state: "open", checks: "success", mergeable: true, ...over }) as PrStatus;

  it("checks:failure + mergeable:true + mergeStateStatus:clean → landingCiFailing true", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: true, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingCiFailing).toBe(true);
  });

  it("checks:failure + mergeStateStatus:behind → landingCiFailing false (rebase-owned)", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: true, mergeStateStatus: "behind" }),
      }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingCiFailing).toBe(false);
  });

  it("checks:failure + mergeable:false → landingCiFailing false (conflict-owned)", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: false, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingCiFailing).toBe(false);
  });

  it("checks:success → landingCiFailing false", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "success", mergeable: true, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingCiFailing).toBe(false);
  });
});

// ── enrichLandingEpics: landingRepairing ─────────────────────────────────────

describe("enrichLandingEpics — landingRepairing", () => {
  const baseEpic = (over: Partial<CompletedEpic> = {}): CompletedEpic => ({
    repoPath: "/repo/a",
    parentIssueNumber: 7,
    parentTitle: "Epic A",
    completedAt: 1_000,
    children: [],
    landingPrNumber: 42,
    landingPrUrl: "http://x/42",
    landingState: "open",
    migrationPaths: [],
    migrationsAckedAt: null,
    landingRebasePauseReason: null,
    landingRepairCount: 0,
    landingRepairHead: null,
    ...over,
  });

  const prStatus = (over: Partial<PrStatus> = {}): PrStatus =>
    ({ state: "open", checks: "success", mergeable: true, ...over }) as PrStatus;

  it("red PR + hasLiveRepairSession:true → landingRepairing true, landingCiFailing false", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: true, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: () => true,
      now: 0,
    });
    expect(rows[0]?.landingRepairing).toBe(true);
    expect(rows[0]?.landingCiFailing).toBe(false);
  });

  it("red PR + hasLiveRepairSession:false → landingRepairing false, landingCiFailing true (backstop)", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: true, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingRepairing).toBe(false);
    expect(rows[0]?.landingCiFailing).toBe(true);
  });

  it("hasLiveRepairSession called with row's repoPath + resolved integration branch", async () => {
    const rows = [baseEpic({ repoPath: "/repo/b", parentIssueNumber: 9 })];
    const seen: Array<[string, string]> = [];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/9",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: true, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: (repoPath, integrationBranch) => {
        seen.push([repoPath, integrationBranch]);
        return false;
      },
      now: 0,
    });
    expect(seen).toEqual([["/repo/b", "epic/9"]]);
  });

  it("non-red PR (checks:success) → landingRepairing false regardless of hasLiveRepairSession", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "success", mergeable: true, mergeStateStatus: "clean" }),
      }),
      hasLiveRepairSession: () => true,
      now: 0,
    });
    expect(rows[0]?.landingRepairing).toBe(false);
    expect(rows[0]?.landingCiFailing).toBe(false);
  });

  it("behind/conflict-owned red PR (not landingCiFailing's territory) → landingRepairing false even if a session is live", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () =>
          prStatus({ checks: "failure", mergeable: true, mergeStateStatus: "behind" }),
      }),
      hasLiveRepairSession: () => true,
      now: 0,
    });
    expect(rows[0]?.landingRepairing).toBe(false);
    expect(rows[0]?.landingCiFailing).toBe(false);
  });
});
