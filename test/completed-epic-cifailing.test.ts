import { describe, expect, it } from "bun:test";
import {
  deriveLandingCiAutomation,
  enrichLandingEpics,
  landingCiChecksOf,
} from "../src/completed-epic";
import type { CompletedEpic, LandingAutomationContext } from "../src/completed-epic";
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
    landingConflictReworkCount: 0,
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
    landingConflictReworkCount: 0,
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

// ── #2872: landing-automation stages + "your turn" gate ───────────────────────

describe("deriveLandingCiAutomation", () => {
  const ctx = (over: Partial<LandingAutomationContext> = {}): LandingAutomationContext => ({
    draftMode: false,
    autoMergeEnabled: false,
    autoDrainEnabled: true,
    epicRunning: false,
    liveRepair: null,
    sessionVisible: () => true,
    ...over,
  });
  const row = (over = {}) => ({
    landingRerunHead: null as string | null,
    landingRerunCount: 0,
    landingRerunUnavailable: false,
    landingRepairSessionId: null as string | null,
    landingRepairCount: 0,
    ...over,
  });
  const red = { checks: "failure" as const, headSha: "h1", isDraft: false };
  const derive = (o: {
    pr?: Partial<typeof red> | { checks: "pending"; headSha: string; isDraft: boolean };
    github?: boolean;
    ctx?: Partial<LandingAutomationContext>;
    row?: Partial<ReturnType<typeof row>>;
  }) =>
    deriveLandingCiAutomation({
      pr: { ...red, ...o.pr },
      github: o.github ?? true,
      ctx: ctx(o.ctx),
      row: row(o.row),
    });

  it("fresh red head with auto-drain on: both stages pending", () => {
    const a = derive({});
    expect(a.reruns).toEqual({ status: "pending", used: 0, cap: 2, skipReason: null });
    expect(a.repair.status).toBe("pending");
  });

  it("reruns: same head accumulates, a new head resets, pending checks after a rerun = running", () => {
    expect(derive({ row: { landingRerunHead: "h1", landingRerunCount: 2 } }).reruns.status).toBe(
      "done",
    );
    expect(derive({ row: { landingRerunHead: "h0", landingRerunCount: 2 } }).reruns).toMatchObject({
      status: "pending",
      used: 0,
    });
    expect(
      derive({
        pr: { checks: "pending", headSha: "h1", isDraft: false },
        row: { landingRerunHead: "h1", landingRerunCount: 1 },
      }).reruns,
    ).toMatchObject({ status: "running", used: 1 });
  });

  it.each([
    [{ github: false }, "no-github", "no-github"],
    [{ ctx: { draftMode: true } }, "draft-mode", "draft-mode"],
    [{ ctx: { autoDrainEnabled: false } }, "not-engaged", "auto-drain-off"],
    [{ pr: { isDraft: true } }, "draft-pr", "draft-pr"],
  ] as const)("skips both stages: %o → reruns %s, repair %s", (input, rerun, repair) => {
    const a = derive(input as Parameters<typeof derive>[0]);
    expect(a.reruns).toMatchObject({ status: "skipped", skipReason: rerun });
    expect(a.repair).toMatchObject({ status: "skipped", skipReason: repair });
  });

  it("auto-drain off but engaged via auto-merge: reruns pending, repair skipped", () => {
    const a = derive({ ctx: { autoDrainEnabled: false, autoMergeEnabled: true } });
    expect(a.reruns.status).toBe("pending");
    expect(a.repair).toMatchObject({ status: "skipped", skipReason: "auto-drain-off" });
  });

  it("no rerunnable run on this head: reruns skipped (no-run), the repair still pending", () => {
    const a = derive({ row: { landingRerunHead: "h1", landingRerunUnavailable: true } });
    expect(a.reruns).toMatchObject({ status: "skipped", skipReason: "no-run" });
    expect(a.repair.status).toBe("pending");
  });

  it("repair precedence: running > done > skipped; session id from live, else recorded + visible", () => {
    const live = derive({
      ctx: { autoDrainEnabled: false, liveRepair: { id: "s-live", createdAt: 5 } },
      row: { landingRepairCount: 1, landingRepairSessionId: "s-old" },
    }).repair;
    expect(live).toMatchObject({ status: "running", sessionId: "s-live", sessionStartedAt: 5 });

    const done = derive({
      ctx: { autoDrainEnabled: false },
      row: { landingRepairCount: 1, landingRepairSessionId: "s-old" },
    }).repair;
    expect(done).toMatchObject({ status: "done", skipReason: null, sessionId: "s-old" });

    const gone = derive({
      ctx: { sessionVisible: () => false },
      row: { landingRepairCount: 1, landingRepairSessionId: "s-old" },
    }).repair;
    expect(gone.sessionId).toBeNull();
  });
});

describe("landingCiChecksOf", () => {
  it("lists red checks with their URL and counts running + green", () => {
    expect(
      landingCiChecksOf({
        jobs: [
          { name: "pr title", state: "failure", url: "https://x/1" },
          { name: "lint", state: "failure" },
          { name: "test", state: "pending" },
          { name: "build", state: "success" },
          { name: "skipped", state: "none" },
        ],
      }),
    ).toEqual({
      failed: [
        { name: "pr title", url: "https://x/1" },
        { name: "lint", url: null },
      ],
      running: 1,
      passed: 1,
    });
    expect(landingCiChecksOf({})).toBeUndefined();
  });
});

describe("enrichLandingEpics — #2872 your-turn gate", () => {
  const epic = (over: Partial<CompletedEpic> = {}) => ({
    repoPath: "/repo/a",
    parentIssueNumber: 7,
    parentTitle: "Epic A",
    completedAt: 1_000,
    children: [],
    landingPrNumber: 42,
    landingPrUrl: "http://x/42",
    landingState: "open" as const,
    migrationPaths: [],
    migrationsAckedAt: null,
    landingRebasePauseReason: null,
    landingRepairCount: 0,
    landingRepairHead: null,
    landingConflictReworkCount: 0,
    ...over,
  });
  const enrich = async (
    row: ReturnType<typeof epic> & Record<string, unknown>,
    ctx: Partial<LandingAutomationContext>,
  ) => {
    await enrichLandingEpics([row], {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({
        kind: "github",
        prStatus: async () =>
          ({
            state: "open",
            checks: "failure",
            mergeable: true,
            mergeStateStatus: "clean",
            headSha: "h1",
            jobs: [{ name: "pr title", state: "failure", url: "https://x/1" }],
          }) as PrStatus,
      }),
      hasLiveRepairSession: () => false,
      automation: () => ({
        draftMode: false,
        autoMergeEnabled: false,
        autoDrainEnabled: true,
        epicRunning: false,
        liveRepair: null,
        sessionVisible: () => true,
        ...ctx,
      }),
      now: 0,
    });
    return row as CompletedEpic;
  };

  it("red with a stage still pending → not yet the operator's turn", async () => {
    const r = await enrich(epic(), {});
    expect(r.landingCiFailing).toBe(false);
    expect(r.landingCiAutomation?.reruns.status).toBe("pending");
    expect(r.landingCiChecks?.failed).toEqual([{ name: "pr title", url: "https://x/1" }]);
  });

  it("red with reruns spent and auto-drain off → the operator's turn", async () => {
    const r = await enrich(
      { ...epic(), landingRerunHead: "h1", landingRerunCount: 2 },
      {
        autoDrainEnabled: false,
        autoMergeEnabled: true,
      },
    );
    expect(r.landingCiFailing).toBe(true);
    expect(r.landingCiAutomation?.repair.skipReason).toBe("auto-drain-off");
  });

  it("red with reruns and the repair spent → the operator's turn", async () => {
    const r = await enrich(
      { ...epic({ landingRepairCount: 1 }), landingRerunHead: "h1", landingRerunCount: 2 },
      {},
    );
    expect(r.landingCiFailing).toBe(true);
  });
});
