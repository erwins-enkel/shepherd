import { describe, expect, it } from "bun:test";
import {
  anyLiveRepairSession,
  enrichLandingEpics,
  isLiveRepairSession,
  REPAIR_ACTIVE_TTL_MS,
} from "../src/completed-epic";
import type { CompletedEpic } from "../src/completed-epic";
import type { PrStatus } from "../src/forge/types";
import type { Session } from "../src/types";

// ── isLiveRepairSession ───────────────────────────────────────────────────────
// Minimal Session fixture — only the fields isLiveRepairSession reads are exercised across
// cases; the rest are structurally-required filler mirroring test/autopilot.test.ts's sess().

function sess(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "t",
    prompt: "Fix landing CI",
    repoPath: "/repo",
    baseBranch: "epic/7",
    branch: "epic/7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
    claudeSessionId: "cs",
    model: null,
    effort: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: true,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: true,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    landingRepair: true,
    status: "running",
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    spawnTerminalId: null,
    spawnAccountDir: null,
    ...over,
  };
}

describe("isLiveRepairSession", () => {
  it("landingRepair + running + within TTL → true", () => {
    expect(isLiveRepairSession(sess({ status: "running", createdAt: 0 }), 1_000)).toBe(true);
  });

  it("landingRepair + idle + within TTL → true", () => {
    expect(isLiveRepairSession(sess({ status: "idle", createdAt: 0 }), 1_000)).toBe(true);
  });

  it("landingRepair:false → false", () => {
    expect(isLiveRepairSession(sess({ landingRepair: false }), 0)).toBe(false);
  });

  it("status:blocked → false", () => {
    expect(isLiveRepairSession(sess({ status: "blocked" }), 0)).toBe(false);
  });

  it("status:done → false", () => {
    expect(isLiveRepairSession(sess({ status: "done" }), 0)).toBe(false);
  });

  it("status:archived → false", () => {
    expect(isLiveRepairSession(sess({ status: "archived" }), 0)).toBe(false);
  });

  it("autopilotComplete:true → false", () => {
    expect(isLiveRepairSession(sess({ autopilotComplete: true }), 0)).toBe(false);
  });

  it("autopilotPaused:true → false", () => {
    expect(isLiveRepairSession(sess({ autopilotPaused: true }), 0)).toBe(false);
  });

  it("createdAt older than REPAIR_ACTIVE_TTL_MS → false (stuck session releases the fence)", () => {
    const createdAt = 0;
    const now = createdAt + REPAIR_ACTIVE_TTL_MS + 1;
    expect(isLiveRepairSession(sess({ createdAt }), now)).toBe(false);
  });

  it("createdAt just under REPAIR_ACTIVE_TTL_MS → true", () => {
    const createdAt = 0;
    const now = createdAt + REPAIR_ACTIVE_TTL_MS - 1;
    expect(isLiveRepairSession(sess({ createdAt }), now)).toBe(true);
  });
});

// ── anyLiveRepairSession ──────────────────────────────────────────────────────
// The shared fence/surface predicate used verbatim by the drain pass and
// GET /api/epics/completed. Owns the repoPath + baseBranch filtering (previously duplicated).
describe("anyLiveRepairSession", () => {
  it("true when a live repair session matches repoPath AND baseBranch", () => {
    const sessions = [sess({ repoPath: "/repo", baseBranch: "epic/7" })];
    expect(anyLiveRepairSession(sessions, "/repo", "epic/7", 0)).toBe(true);
  });

  it("false when repoPath differs (no cross-repo leak)", () => {
    const sessions = [sess({ repoPath: "/other", baseBranch: "epic/7" })];
    expect(anyLiveRepairSession(sessions, "/repo", "epic/7", 0)).toBe(false);
  });

  it("false when baseBranch differs (no cross-epic leak)", () => {
    const sessions = [sess({ repoPath: "/repo", baseBranch: "epic/9" })];
    expect(anyLiveRepairSession(sessions, "/repo", "epic/7", 0)).toBe(false);
  });

  it("false when the matching session is not live (delegates to isLiveRepairSession)", () => {
    const sessions = [sess({ repoPath: "/repo", baseBranch: "epic/7", autopilotComplete: true })];
    expect(anyLiveRepairSession(sessions, "/repo", "epic/7", 0)).toBe(false);
  });

  it("false on an empty list", () => {
    expect(anyLiveRepairSession([], "/repo", "epic/7", 0)).toBe(false);
  });
});

// ── enrichLandingEpics: conflict rework in flight (#1841) ────────────────────
// A CONFLICTING landing PR held by a live repair session is a conflict rework in flight: the card
// shows the non-actionable landingRepairing chip (not the "Resolve conflicts" CTA), and
// landingCiFailing stays false (conflict-owned).
describe("enrichLandingEpics — conflict rework in flight", () => {
  const epic = (): CompletedEpic => ({
    repoPath: "/repo",
    parentIssueNumber: 7,
    parentTitle: "Epic",
    completedAt: 0,
    children: [],
    landingPrNumber: 42,
    landingPrUrl: "http://x/42",
    landingState: "open",
    migrationPaths: [],
    migrationsAckedAt: null,
    landingRebasePauseReason: "conflict",
    landingRepairCount: 0,
    landingRepairHead: null,
    landingConflictReworkCount: 1,
  });
  const conflicting = (checks: PrStatus["checks"]): PrStatus =>
    ({ state: "open", checks, mergeable: false, mergeStateStatus: "dirty" }) as PrStatus;

  async function enrich(live: boolean, checks: PrStatus["checks"] = "success") {
    const rows = [epic()];
    await enrichLandingEpics(rows, {
      getEpicIntegrationBranch: () => "epic/7",
      resolveForge: () => ({ kind: "github", prStatus: async () => conflicting(checks) }),
      hasLiveRepairSession: () => live,
      now: 0,
    });
    return rows[0]!;
  }

  it("conflicting + live repair session → landingRepairing true, landingCiFailing false", async () => {
    const r = await enrich(true);
    expect(r.landingRepairing).toBe(true);
    expect(r.landingCiFailing).toBe(false);
  });

  it("conflicting + red checks + live session → still landingRepairing, never landingCiFailing", async () => {
    const r = await enrich(true, "failure");
    expect(r.landingRepairing).toBe(true);
    expect(r.landingCiFailing).toBe(false);
  });

  it("conflicting + no live session → landingRepairing false (the CTA shows)", async () => {
    const r = await enrich(false);
    expect(r.landingRepairing).toBe(false);
    expect(r.landingCiFailing).toBe(false);
  });
});
