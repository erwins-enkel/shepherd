import { expect, test } from "bun:test";
import { SessionService, DRAFT_PR_NOTE } from "../src/service";

/** A full-enough Session row for the release-gate path (only the fields the method touches). */
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
 * Build a SessionService whose store is a hand-rolled stub exposing only get/getPlanGate/
 * setPlanPhase/addSignal, and a herdr whose pane is "live" (list includes the terminalId) so
 * reply() actually lands. Captures setPlanPhase + emit + send calls for assertions.
 */
function harness(opts: {
  session: ReturnType<typeof sess> | null;
  gate: { approved: boolean } | null;
  paneLive?: boolean;
  draftMode?: boolean;
}) {
  const setPhaseCalls: { id: string; phase: string }[] = [];
  const emitted: { event: string; data: unknown }[] = [];
  const sent: { target: string; text: string }[] = [];
  const term = opts.session?.herdrAgentId ?? "t1";
  const store = {
    get: () => opts.session,
    getPlanGate: () => opts.gate,
    setPlanPhase: (id: string, phase: string) => setPhaseCalls.push({ id, phase }),
    addSignal: () => {},
    getRepoConfig: () => ({ draftMode: opts.draftMode ?? false }) as any,
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
    events: { emit: (event, data) => emitted.push({ event, data }) },
  });
  return { svc, setPhaseCalls, emitted, sent };
}

test("releasePlanGate flips phase + steers ONLY when approved and planning", () => {
  // not yet approved → no-op
  const notApproved = harness({ session: sess(), gate: { approved: false } });
  expect(notApproved.svc.releasePlanGate("s1")).toBe(false);
  expect(notApproved.setPhaseCalls).toHaveLength(0);
  expect(notApproved.sent).toHaveLength(0);
  expect(notApproved.emitted).toHaveLength(0);

  // approved + planning → flips, steers, emits
  const h = harness({ session: sess(), gate: { approved: true } });
  expect(h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.setPhaseCalls).toEqual([{ id: "s1", phase: "executing" }]);
  expect(h.sent.length).toBeGreaterThan(0); // a steer landed on the live pane
  expect(h.emitted).toContainEqual({
    event: "session:plangate",
    data: { id: "s1", planPhase: "executing" },
  });
});

test("releasePlanGate is a no-op when phase !== planning", () => {
  const h = harness({ session: sess({ planPhase: "executing" }), gate: { approved: true } });
  expect(h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("releasePlanGate is a no-op for unknown id", () => {
  const h = harness({ session: null, gate: { approved: true } });
  expect(h.svc.releasePlanGate("ghost")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
});

test("releasePlanGate steers WITHOUT draft note when draftMode=false", () => {
  const h = harness({ session: sess(), gate: { approved: true }, draftMode: false });
  expect(h.svc.releasePlanGate("s1")).toBe(true);
  const steerText = h.sent.map((s) => s.text).join("");
  expect(steerText).not.toContain(DRAFT_PR_NOTE);
});

test("releasePlanGate steers WITH draft note when draftMode=true", () => {
  const h = harness({ session: sess(), gate: { approved: true }, draftMode: true });
  expect(h.svc.releasePlanGate("s1")).toBe(true);
  const steerText = h.sent.map((s) => s.text).join("");
  expect(steerText).toContain(DRAFT_PR_NOTE);
});
