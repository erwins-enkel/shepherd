import { describe, expect, it } from "bun:test";
import {
  anyLiveRepairSession,
  isLiveRepairSession,
  REPAIR_ACTIVE_TTL_MS,
} from "../src/completed-epic";
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
// The shared fence/surface predicate used verbatim by the drain pass, the rundown, and
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
