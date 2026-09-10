import { expect, test } from "bun:test";
import { SessionService } from "../src/service";

/** A full-enough Session row for the advance-execution path. */
function sess(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    name: "t",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
    planPhase: "planning",
    ...over,
  };
}

/**
 * Build a SessionService whose store is a hand-rolled stub exposing only get/setPlanPhase,
 * and a herdr whose pane is "live" (list includes the terminalId). Captures setPlanPhase,
 * emit, and send calls for assertions.
 */
function harness(opts: {
  session: ReturnType<typeof sess> | null;
  paneLive?: boolean;
  gate?: Record<string, unknown> | null;
}) {
  const setPhaseCalls: { id: string; phase: string }[] = [];
  const emitted: { event: string; data: unknown }[] = [];
  const sent: { target: string; text: string }[] = [];
  const term = opts.session?.herdrAgentId ?? "t1";
  const store = {
    get: () => opts.session,
    getPlanGate: () => opts.gate ?? null,
    setPlanPhase: (id: string, phase: string) => setPhaseCalls.push({ id, phase }),
    addSignal: () => {},
  };
  const svc = new SessionService({
    store: store as any,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => ((opts.paneLive ?? true) ? [{ terminalId: term }] : []),
      stop: async () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
    events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) },
  });
  return { svc, setPhaseCalls, emitted, sent };
}

test("advanceToExecutionOnPr: planning session → returns true, flips phase, emits plangate event", () => {
  const h = harness({ session: sess() });
  expect(h.svc.advanceToExecutionOnPr("s1")).toBe(true);
  expect(h.setPhaseCalls).toEqual([{ id: "s1", phase: "executing" }]);
  expect(h.emitted).toContainEqual({
    event: "session:plangate",
    data: { id: "s1", planPhase: "executing" },
  });
});

test("advanceToExecutionOnPr: does NOT send PLAN_GO_STEER (agent already executed)", () => {
  const h = harness({ session: sess(), paneLive: true });
  h.svc.advanceToExecutionOnPr("s1");
  // No steer must be sent — the agent already executed and a Go steer would be wrong
  expect(h.sent).toHaveLength(0);
});

test("advanceToExecutionOnPr: session already executing → returns false, no phase change, no event", () => {
  const h = harness({ session: sess({ planPhase: "executing" }) });
  expect(h.svc.advanceToExecutionOnPr("s1")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
});

test("advanceToExecutionOnPr: planPhase null → returns false, no phase change, no event", () => {
  const h = harness({ session: sess({ planPhase: null }) });
  expect(h.svc.advanceToExecutionOnPr("s1")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
});

test("advanceToExecutionOnPr: unknown id → returns false, no phase change, no event", () => {
  const h = harness({ session: null });
  expect(h.svc.advanceToExecutionOnPr("ghost")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
});

// ── #2224: a deliberate re-gate must survive the PR poller ────────────────────

test("advanceToExecutionOnPr: a re-gated session (approvedAt set, not approved) is NOT advanced", () => {
  // regatePlanGate returned this session to planning on purpose; this runs on EVERY git poll, so
  // without the guard it would flip a re-gated PR-bearing session back within one cycle.
  const h = harness({
    session: sess(),
    gate: { approved: false, approvedAt: 500, decision: "changes_requested" },
  });
  expect(h.svc.advanceToExecutionOnPr("s1")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("advanceToExecutionOnPr: re-approval lifts the suppression on its own", () => {
  const h = harness({ session: sess(), gate: { approved: true, approvedAt: 900 } });
  expect(h.svc.advanceToExecutionOnPr("s1")).toBe(true);
});

test("advanceToExecutionOnPr: a never-approved gate still advances (the #809 latch case)", () => {
  // approvedAt null ⇒ nobody re-gated this; it is the operator-steered session the auto-advance
  // exists for, and it must keep advancing exactly as before.
  const h = harness({
    session: sess(),
    gate: { approved: false, approvedAt: null, decision: "changes_requested" },
  });
  expect(h.svc.advanceToExecutionOnPr("s1")).toBe(true);
  expect(h.setPhaseCalls).toEqual([{ id: "s1", phase: "executing" }]);
});

// ── #2224: regatePlanGate ─────────────────────────────────────────────────────

test("regatePlanGate: executing session with a revoked gate → flips to planning + stop steer", async () => {
  const h = harness({
    session: sess({ planPhase: "executing" }),
    gate: { approved: false, approvedAt: 500, decision: "changes_requested" },
  });
  expect(await h.svc.regatePlanGate("s1")).toBe(true);
  expect(h.setPhaseCalls).toEqual([{ id: "s1", phase: "planning" }]);
  expect(h.emitted).toContainEqual({
    event: "session:plangate",
    data: { id: "s1", planPhase: "planning" },
  });
  expect(h.sent.some((s) => s.text.includes("STOP implementing"))).toBe(true);
});

test("regatePlanGate: no-ops while the store still holds an APPROVED gate", async () => {
  // The caller contract: persist the revoking verdict FIRST. A caller that steers before persisting
  // gets this no-op — approval revoked in memory, session left executing, no stop steer.
  const h = harness({
    session: sess({ planPhase: "executing" }),
    gate: { approved: true, approvedAt: 500, decision: "approved" },
  });
  expect(await h.svc.regatePlanGate("s1")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
});

test("regatePlanGate: no-ops off the executing phase, on a gateless session, and on an unknown id", async () => {
  const planning = harness({
    session: sess(),
    gate: { approved: false, approvedAt: 500 },
  });
  expect(await planning.svc.regatePlanGate("s1")).toBe(false);
  const gateless = harness({ session: sess({ planPhase: "executing" }), gate: null });
  expect(await gateless.svc.regatePlanGate("s1")).toBe(false);
  const ghost = harness({ session: null });
  expect(await ghost.svc.regatePlanGate("ghost")).toBe(false);
});
