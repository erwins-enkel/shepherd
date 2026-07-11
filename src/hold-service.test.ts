import { describe, expect, it } from "bun:test";
import type { BlockReason } from "./blocked";
import { EventHub } from "./events";
import { HoldReasonService } from "./hold-service";
import type { HoldReason, Session } from "./types";

// ── fakes ─────────────────────────────────────────────────────────────────────

/** Minimal Session builder — fills in every required field with safe defaults. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "test-session",
    prompt: "test",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feature/test",
    worktreePath: "/wt/test",
    isolated: true,
    herdrSession: "h1",
    herdrAgentId: "a1",
    claudeSessionId: "",
    model: null,
    effort: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    research: false,
    epicAuthoring: false,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "running",
    lastState: "working",
    createdAt: 1000,
    updatedAt: 1000,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    completionRepromptCount: 0,
    spawnTerminalId: null,
    spawnAccountDir: null,
    ...overrides,
  };
}

function makeBlockReason(shape: BlockReason["shape"]): BlockReason {
  return { shape, options: [], tail: [] };
}

/** Fake session store backed by a plain Map. */
function makeStore(sessions: Session[] = []) {
  const map = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  return {
    get: (id: string) => map.get(id) ?? null,
    list: (opts?: { activeOnly?: boolean }) => {
      const all = [...map.values()];
      if (opts?.activeOnly) return all.filter((s) => s.status !== "archived");
      return all;
    },
    /** Test helper — mutate stored session. */
    put: (s: Session) => map.set(s.id, s),
    delete: (id: string) => map.delete(id),
  };
}

// ── harness factory ───────────────────────────────────────────────────────────

function makeHarness(sessions: Session[] = []) {
  const events = new EventHub();
  const store = makeStore(sessions);
  const calls: Array<{ id: string; hold: HoldReason | null }> = [];

  const svc = new HoldReasonService({
    store,
    events,
    gitSnapshot: () => ({}),
    reviewSnapshot: () => ({}),
    gateSnapshot: () => ({}),
    recapSnapshot: () => ({}),
    onChange: (id, hold) => calls.push({ id, hold }),
    now: () => 1_000_000, // deterministic
  });

  return { events, store, svc, calls };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("HoldReasonService", () => {
  // 1. halt → halted-error hold emitted
  it("session:halt with haltReason error → onChange(id, {code:'halted-error'})", () => {
    const session = makeSession({ id: "s1", haltReason: null });
    const { events, store, svc, calls } = makeHarness([session]);
    const initialCallCount = calls.length;

    // Update session in store to reflect halt.
    store.put(makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 }));
    events.emit("session:halt", { id: "s1", haltReason: "error", haltedAt: 1000 });

    const afterCalls = calls.slice(initialCallCount);
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]).toEqual({ id: "s1", hold: { code: "halted-error" } });

    // snapshot reflects the hold
    expect(svc.snapshot()["s1"]).toEqual({ code: "halted-error" });
  });

  // 2. emit-on-change dedup: same event twice → onChange fires only once
  it("emitting same trigger twice → onChange fires once for that state", () => {
    const session = makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 });
    const { events, calls } = makeHarness([session]);
    const before = calls.length;

    // Session is already halted-error from seeding; now emit session:halt again
    events.emit("session:halt", { id: "s1", haltReason: "error", haltedAt: 1000 });
    events.emit("session:halt", { id: "s1", haltReason: "error", haltedAt: 1000 });

    // Both events should produce no new calls (already seeded + deduped)
    expect(calls.slice(before)).toHaveLength(0);
  });

  // 3. clear: when haltReason transitions to null → onChange(id, null)
  it("session transitions out of hold → onChange(id, null) fired, snapshot cleared", () => {
    const session = makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 });
    const { events, store, svc, calls } = makeHarness([session]);
    const before = calls.length;

    // Resolve the halt
    store.put(makeSession({ id: "s1", haltReason: null, haltedAt: null }));
    events.emit("session:halt", { id: "s1", haltReason: null, haltedAt: null });

    const afterCalls = calls.slice(before);
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]).toEqual({ id: "s1", hold: null });
    expect(svc.snapshot()["s1"]).toBeUndefined();
  });

  // 4. automerge:status merge_error → train-error; clear on non-error state
  it("automerge:status merge_error → train-error hold; non-error state clears it", () => {
    const session = makeSession({ id: "s1" });
    const { events, svc, calls } = makeHarness([session]);
    const before = calls.length;

    events.emit("automerge:status", {
      repoPath: "/repo",
      enabled: true,
      state: "merge_error",
      detail: null,
      sessionId: "s1",
    });

    const afterError = calls.slice(before);
    expect(afterError).toHaveLength(1);
    expect(afterError[0]!.hold?.code).toBe("train-error");
    expect(svc.snapshot()["s1"]?.code).toBe("train-error");

    // Non-error state clears it
    const before2 = calls.length;
    events.emit("automerge:status", {
      repoPath: "/repo",
      enabled: true,
      state: "idle",
      detail: null,
      sessionId: "s1",
    });

    const afterClear = calls.slice(before2);
    expect(afterClear).toHaveLength(1);
    expect(afterClear[0]).toEqual({ id: "s1", hold: null });
    expect(svc.snapshot()["s1"]).toBeUndefined();
  });

  // 5. session:block with stall → blocked-stall; block null clears it
  it("session:block stall → blocked-stall; block null → clears hold", () => {
    const session = makeSession({ id: "s1", status: "running" });
    const { events, svc, calls } = makeHarness([session]);
    const before = calls.length;

    const stall = makeBlockReason("stall");
    events.emit("session:block", { id: "s1", block: stall });

    const afterBlock = calls.slice(before);
    expect(afterBlock).toHaveLength(1);
    expect(afterBlock[0]!.hold?.code).toBe("blocked-stall");

    // Now clear the block
    const before2 = calls.length;
    events.emit("session:block", { id: "s1", block: null });

    const afterClear = calls.slice(before2);
    expect(afterClear).toHaveLength(1);
    expect(afterClear[0]).toEqual({ id: "s1", hold: null });
    expect(svc.snapshot()["s1"]).toBeUndefined();
  });

  // 6. usage:limits updates resetAt; halted-usage hold params reflect new resetAt
  it("usage:limits updates resetAt reflected in halted-usage hold params", () => {
    const session = makeSession({ id: "s1", haltReason: "usage_limit", haltedAt: 1000 });
    const { events, svc, calls } = makeHarness([session]);

    const resetAt = 9_999_999;
    const before = calls.length;
    events.emit("usage:limits", { session5h: { pct: 1.0, resetAt } });

    const afterCalls = calls.slice(before);
    // Should have 1 call with the updated resetAt (was seeded without resetAt)
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]!.hold?.code).toBe("halted-usage");
    expect(afterCalls[0]!.hold?.params?.resetAt).toBe(resetAt);
    expect(svc.snapshot()["s1"]?.params?.resetAt).toBe(resetAt);
  });

  // 7. session:archived drops session from snapshot
  it("session:archived drops session from snapshot", () => {
    const session = makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 });
    const { events, svc, calls } = makeHarness([session]);
    // Seed should have placed a hold
    expect(svc.snapshot()["s1"]).toBeDefined();

    const before = calls.length;
    events.emit("session:archived", { id: "s1" });

    const afterCalls = calls.slice(before);
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]).toEqual({ id: "s1", hold: null });
    expect(svc.snapshot()["s1"]).toBeUndefined();
  });

  // 7b. session:archived on session with no hold does NOT emit onChange
  it("session:archived with no hold → no onChange", () => {
    const session = makeSession({ id: "s1" }); // no hold
    const { events, svc, calls } = makeHarness([session]);
    const before = calls.length;

    events.emit("session:archived", { id: "s1" });
    expect(calls.slice(before)).toHaveLength(0);
    expect(svc.snapshot()["s1"]).toBeUndefined();
  });

  // 8. snapshot() returns full current map
  it("snapshot() returns full current holds map", () => {
    const s1 = makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 });
    const s2 = makeSession({ id: "s2", haltReason: "usage_limit", haltedAt: 1000 });
    const s3 = makeSession({ id: "s3" }); // no hold
    const { svc } = makeHarness([s1, s2, s3]);

    const snap = svc.snapshot();
    expect(snap["s1"]?.code).toBe("halted-error");
    expect(snap["s2"]?.code).toBe("halted-usage");
    expect(snap["s3"]).toBeUndefined();
    expect(Object.keys(snap)).toHaveLength(2);
  });

  // Seeding: holds populated on construction
  it("seeds holds from store on construction (emit via onChange)", () => {
    const session = makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 });
    const { svc, calls } = makeHarness([session]);

    // Seed should emit onChange
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "s1", hold: { code: "halted-error" } });
    expect(svc.snapshot()["s1"]).toEqual({ code: "halted-error" });
  });

  // automerge:status with null sessionId is ignored
  it("automerge:status null sessionId → no recompute", () => {
    const session = makeSession({ id: "s1" });
    const { events, calls } = makeHarness([session]);
    const before = calls.length;

    events.emit("automerge:status", {
      repoPath: "/repo",
      enabled: true,
      state: "merge_error",
      detail: null,
      sessionId: null,
    });

    expect(calls.slice(before)).toHaveLength(0);
  });

  // dispose() stops processing events
  it("dispose() unsubscribes so further events are ignored", () => {
    const session = makeSession({ id: "s1" });
    const { events, store, svc, calls } = makeHarness([session]);
    svc.dispose();

    const before = calls.length;
    store.put(makeSession({ id: "s1", haltReason: "error", haltedAt: 1000 }));
    events.emit("session:halt", { id: "s1", haltReason: "error", haltedAt: 1000 });

    expect(calls.slice(before)).toHaveLength(0);
  });
});
