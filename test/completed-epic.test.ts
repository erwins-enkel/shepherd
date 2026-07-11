import { describe, expect, it } from "bun:test";
import {
  buildRollup,
  computeLandingReady,
  computeLandingStranded,
  enrichLandingEpics,
  EPIC_LANDING_STRANDED_MS,
} from "../src/completed-epic";
import type { CompletedEpic } from "../src/completed-epic";
import type { PrStatus } from "../src/forge/types";

describe("buildRollup", () => {
  it("child WITH detail row → integrated true, PR facts from row", () => {
    const children = [{ number: 1, title: "Fix auth", url: "https://gh/issues/1" }];
    const details = [{ childNumber: 1, prNumber: 42, prUrl: "https://gh/pull/42", mergedAt: 1000 }];
    const result = buildRollup(children, details);
    expect(result).toEqual([
      {
        number: 1,
        title: "Fix auth",
        url: "https://gh/issues/1",
        prNumber: 42,
        prUrl: "https://gh/pull/42",
        mergedAt: 1000,
        integrated: true,
      },
    ]);
  });

  it("child WITHOUT detail row → integrated false, PR/mergedAt null, number/title/url present", () => {
    const children = [{ number: 5, title: "Closed out-of-band", url: "https://gh/issues/5" }];
    const result = buildRollup(children, []);
    expect(result).toEqual([
      {
        number: 5,
        title: "Closed out-of-band",
        url: "https://gh/issues/5",
        prNumber: null,
        prUrl: null,
        mergedAt: null,
        integrated: false,
      },
    ]);
  });

  it("mixed epic (#327 shape): 6 children, 3 with detail rows, 3 without", () => {
    const children = [
      { number: 320, title: "Task A", url: "https://gh/issues/320" },
      { number: 321, title: "Task B", url: "https://gh/issues/321" },
      { number: 322, title: "Task C", url: "https://gh/issues/322" },
      { number: 323, title: "Task D", url: "https://gh/issues/323" },
      { number: 324, title: "Task E", url: "https://gh/issues/324" },
      { number: 325, title: "Task F", url: "https://gh/issues/325" },
    ];
    const details = [
      { childNumber: 322, prNumber: 101, prUrl: "https://gh/pull/101", mergedAt: 2000 },
      { childNumber: 323, prNumber: 102, prUrl: "https://gh/pull/102", mergedAt: 2001 },
      { childNumber: 325, prNumber: 103, prUrl: "https://gh/pull/103", mergedAt: 2002 },
    ];
    const result = buildRollup(children, details);

    const integrated = result.filter((c) => c.integrated);
    const notIntegrated = result.filter((c) => !c.integrated);

    expect(integrated).toHaveLength(3);
    expect(notIntegrated).toHaveLength(3);

    expect(integrated.map((c) => c.number)).toEqual([322, 323, 325]);
    expect(integrated.map((c) => c.prNumber)).toEqual([101, 102, 103]);
    expect(integrated.map((c) => c.prUrl)).toEqual([
      "https://gh/pull/101",
      "https://gh/pull/102",
      "https://gh/pull/103",
    ]);
    expect(integrated.map((c) => c.mergedAt)).toEqual([2000, 2001, 2002]);

    expect(notIntegrated.map((c) => c.number)).toEqual([320, 321, 324]);
    expect(notIntegrated.every((c) => c.prNumber === null)).toBe(true);
    expect(notIntegrated.every((c) => c.prUrl === null)).toBe(true);
    expect(notIntegrated.every((c) => c.mergedAt === null)).toBe(true);

    // output order matches input order
    expect(result.map((c) => c.number)).toEqual([320, 321, 322, 323, 324, 325]);
  });

  it("detail row with null prNumber/prUrl (legacy row) → integrated true, mergedAt present", () => {
    const children = [{ number: 10, title: "Legacy task", url: "https://gh/issues/10" }];
    const details = [{ childNumber: 10, prNumber: null, prUrl: null, mergedAt: 5000 }];
    const result = buildRollup(children, details);
    expect(result).toEqual([
      {
        number: 10,
        title: "Legacy task",
        url: "https://gh/issues/10",
        prNumber: null,
        prUrl: null,
        mergedAt: 5000,
        integrated: true,
      },
    ]);
  });

  it("order preservation: output order matches input child order regardless of detail order", () => {
    const children = [
      { number: 3, title: "C", url: "u3" },
      { number: 1, title: "A", url: "u1" },
      { number: 2, title: "B", url: "u2" },
    ];
    const details = [
      { childNumber: 1, prNumber: 10, prUrl: "p1", mergedAt: 100 },
      { childNumber: 3, prNumber: 30, prUrl: "p3", mergedAt: 300 },
    ];
    const result = buildRollup(children, details);
    expect(result.map((c) => c.number)).toEqual([3, 1, 2]);
    expect(result.at(0)?.integrated).toBe(true);
    expect(result.at(1)?.integrated).toBe(true);
    expect(result.at(2)?.integrated).toBe(false);
  });
});

// ── computeLandingReady ───────────────────────────────────────────────────────

describe("computeLandingReady", () => {
  it("clean+success+mergeable → ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "clean",
      }),
    ).toBe(true);
  });

  it("has_hooks → ready (protected branches that still allow merge via hooks)", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "has_hooks",
      }),
    ).toBe(true);
  });

  it("blocked → NOT ready (branch-protection would reject the merge)", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "blocked",
      }),
    ).toBe(false);
  });

  it("behind → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "behind",
      }),
    ).toBe(false);
  });

  it("dirty → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "dirty",
      }),
    ).toBe(false);
  });

  it("unstable → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "unstable",
      }),
    ).toBe(false);
  });

  it("Gitea (undefined mergeStateStatus) + clean signals → ready", () => {
    expect(computeLandingReady({ state: "open", checks: "success", mergeable: true })).toBe(true);
  });

  it("no-CI repo (noCi + checks:none + clean) → ready", () => {
    expect(
      computeLandingReady(
        { state: "open", checks: "none", mergeable: true, mergeStateStatus: "clean" },
        true,
      ),
    ).toBe(true);
  });

  it("checks:none WITHOUT noCi → NOT ready (CI repo pre-green)", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "none",
        mergeable: true,
        mergeStateStatus: "clean",
      }),
    ).toBe(false);
  });

  it("no-CI but blocked mergeStateStatus → NOT ready (mergeStateStatus still authoritative)", () => {
    expect(
      computeLandingReady(
        { state: "open", checks: "none", mergeable: true, mergeStateStatus: "blocked" },
        true,
      ),
    ).toBe(false);
  });

  it("not-open → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "merged",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "clean",
      }),
    ).toBe(false);
  });

  it("checks failure → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "failure",
        mergeable: true,
        mergeStateStatus: "clean",
      }),
    ).toBe(false);
  });

  it("mergeable=false → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: false,
        mergeStateStatus: "clean",
      }),
    ).toBe(false);
  });

  it("mergeable=null → NOT ready", () => {
    expect(
      computeLandingReady({
        state: "open",
        checks: "success",
        mergeable: null,
        mergeStateStatus: "clean",
      }),
    ).toBe(false);
  });
});

// ── computeLandingStranded ────────────────────────────────────────────────────

describe("computeLandingStranded", () => {
  const completedAt = 1_000_000;

  it("just under the threshold → NOT stranded", () => {
    expect(
      computeLandingStranded({
        landingState: "open",
        landingReady: true,
        completedAt,
        now: completedAt + EPIC_LANDING_STRANDED_MS - 1,
      }),
    ).toBe(false);
  });

  it("just over the threshold → stranded", () => {
    expect(
      computeLandingStranded({
        landingState: "open",
        landingReady: true,
        completedAt,
        now: completedAt + EPIC_LANDING_STRANDED_MS + 1,
      }),
    ).toBe(true);
  });

  it("not-ready → NOT stranded even when old", () => {
    expect(
      computeLandingStranded({
        landingState: "open",
        landingReady: false,
        completedAt,
        now: completedAt + EPIC_LANDING_STRANDED_MS + 99999,
      }),
    ).toBe(false);
  });

  it("landingState != 'open' → NOT stranded", () => {
    expect(
      computeLandingStranded({
        landingState: "pending",
        landingReady: true,
        completedAt,
        now: completedAt + EPIC_LANDING_STRANDED_MS + 1,
      }),
    ).toBe(false);
  });
});

// ── enrichLandingEpics ────────────────────────────────────────────────────────
describe("enrichLandingEpics", () => {
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

  it("open + ready PR → fills landingReady/Checks/Mergeable/Stranded", async () => {
    const rows = [baseEpic({ completedAt: 0 })];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({ kind: "local", prStatus: async () => prStatus() }),
      hasLiveRepairSession: () => false,
      now: EPIC_LANDING_STRANDED_MS + 1, // completed long ago → stranded
    });
    expect(rows[0]?.landingReady).toBe(true);
    expect(rows[0]?.landingChecks).toBe("success");
    expect(rows[0]?.landingMergeable).toBe(true);
    expect(rows[0]?.landingStranded).toBe(true);
  });

  it("open but CI red → landingReady false, not stranded", async () => {
    const rows = [baseEpic({ completedAt: 0 })];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () => prStatus({ checks: "failure" }),
      }),
      hasLiveRepairSession: () => false,
      now: EPIC_LANDING_STRANDED_MS + 1,
    });
    expect(rows[0]?.landingReady).toBe(false);
    expect(rows[0]?.landingStranded).toBe(false);
  });

  it("landingState != 'open' → skipped, no live fields", async () => {
    const rows = [baseEpic({ landingState: "merged" })];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({ kind: "local", prStatus: async () => prStatus() }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingReady).toBeUndefined();
  });

  it("no integration branch → skipped", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => null,
      resolveForge: () => ({ kind: "local", prStatus: async () => prStatus() }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingReady).toBeUndefined();
  });

  it("no forge for repo → skipped", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => null,
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingReady).toBeUndefined();
  });

  it("forge prStatus throws → fail-safe, live fields left undefined", async () => {
    const rows = [baseEpic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "local",
        prStatus: async () => {
          throw new Error("network");
        },
      }),
      hasLiveRepairSession: () => false,
      now: 0,
    });
    expect(rows[0]?.landingReady).toBeUndefined();
    expect(rows[0]?.landingChecks).toBeUndefined();
  });
});
