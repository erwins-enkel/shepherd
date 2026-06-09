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
function harness(opts: { session: ReturnType<typeof sess> | null; paneLive?: boolean }) {
  const setPhaseCalls: { id: string; phase: string }[] = [];
  const emitted: { event: string; data: unknown }[] = [];
  const sent: { target: string; text: string }[] = [];
  const term = opts.session?.herdrAgentId ?? "t1";
  const store = {
    get: () => opts.session,
    setPlanPhase: (id: string, phase: string) => setPhaseCalls.push({ id, phase }),
    addSignal: () => {},
  };
  const svc = new SessionService({
    store: store as any,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => ((opts.paneLive ?? true) ? [{ terminalId: term }] : []),
      stop: () => {},
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
