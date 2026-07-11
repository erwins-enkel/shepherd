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
      now: 0,
    });
    expect(rows[0]?.landingCiFailing).toBe(false);
  });
});
