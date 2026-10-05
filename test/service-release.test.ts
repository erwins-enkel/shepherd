import { expect, test } from "bun:test";
import { SessionService, DRAFT_PR_NOTE } from "../src/service";
import { operatorLanguageBlock } from "../src/operator-language";
import { config } from "../src/config";

/** A full-enough Session row for the release-gate path (only the fields the method touches). */
function sess(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    claudeSessionId: "claude-pinned",
    providerSessionId: "codex-pinned",
    codexLaunchId: "launch-test",
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
    spawnAccountDir: null,
    spawnTerminalId: "t1",
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
  transcriptExists?: boolean;
  draftMode?: boolean;
  /** Supersede the plan approval while the steer is in flight (release must then not commit). */
  revokeOnSend?: boolean;
  /** Repo has buildQueueEnabled; `queue` is the session's stored queue state. */
  buildQueueEnabled?: boolean;
  queue?: { steps: unknown[]; approved: boolean; approvalKind?: "auto" | "operator" };
}) {
  const setPhaseCalls: { id: string; phase: string }[] = [];
  const emitted: { event: string; data: unknown }[] = [];
  const sent: { target: string; text: string }[] = [];
  const term = opts.session?.herdrAgentId ?? "t1";
  const approvals: { id: string; approved: boolean; kind?: string }[] = [];
  const queue = opts.queue ?? { steps: [], approved: false };
  const store = {
    get: () => opts.session,
    list: () => (opts.session ? [opts.session] : []),
    getPlanGate: () => opts.gate,
    setPlanPhase: (id: string, phase: string) => setPhaseCalls.push({ id, phase }),
    addSignal: () => {},
    getRepoConfig: () =>
      ({
        draftMode: opts.draftMode ?? false,
        buildQueueEnabled: opts.buildQueueEnabled ?? false,
      }) as any,
    getBuildQueue: (sessionId: string) => ({ sessionId, ...queue }),
    setBuildQueueApproved: (id: string, approved: boolean, kind?: string) => {
      approvals.push({ id, approved, kind });
      queue.approved = approved;
      queue.approvalKind = kind as "auto" | "operator" | undefined;
    },
  };
  const svc = new SessionService({
    transcriptExists: () => opts.transcriptExists ?? true,
    store: store as any,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => ((opts.paneLive ?? true) ? [{ terminalId: term }] : []),
      stop: async () => {},
      paneForegroundProcs: async () => ["claude"],
      send: async (target: string, text: string) => {
        sent.push({ target, text });
        if (opts.revokeOnSend) opts.gate = { approved: false };
      },
    } as any,
    events: { emit: (event, data) => emitted.push({ event, data }) },
  });
  return { svc, setPhaseCalls, emitted, sent, approvals };
}

test("releasePlanGate flips phase + steers ONLY when approved and planning", async () => {
  // not yet approved → no-op
  const notApproved = harness({ session: sess(), gate: { approved: false } });
  expect(await notApproved.svc.releasePlanGate("s1")).toBe(false);
  expect(notApproved.setPhaseCalls).toHaveLength(0);
  expect(notApproved.sent).toHaveLength(0);
  expect(notApproved.emitted).toHaveLength(0);

  // approved + planning → flips, steers, emits
  const h = harness({ session: sess(), gate: { approved: true } });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.setPhaseCalls).toEqual([{ id: "s1", phase: "executing" }]);
  expect(h.sent.length).toBeGreaterThan(0); // a steer landed on the live pane
  expect(h.emitted).toContainEqual({
    event: "session:plangate",
    data: { id: "s1", planPhase: "executing" },
  });
});

test("releasePlanGate is a no-op when phase !== planning", async () => {
  const h = harness({ session: sess({ planPhase: "executing" }), gate: { approved: true } });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("releasePlanGate is a no-op for unknown id", async () => {
  const h = harness({ session: null, gate: { approved: true } });
  expect(await h.svc.releasePlanGate("ghost")).toBe(false);
  expect(h.setPhaseCalls).toHaveLength(0);
});

test("releasePlanGate steers WITHOUT draft note when draftMode=false", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, draftMode: false });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  const steerText = h.sent.map((s) => s.text).join("");
  expect(steerText).not.toContain(DRAFT_PR_NOTE);
});

test("releasePlanGate steers WITH draft note when draftMode=true", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, draftMode: true });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  const steerText = h.sent.map((s) => s.text).join("");
  expect(steerText).toContain(DRAFT_PR_NOTE);
});

// #1624: the plan-go steer is a reply()-routed internal steer, so a Codex session at
// operatorLanguage=de re-carries the <operator-language> block on it; Codex+en and Claude do not.
test("releasePlanGate re-carries the operator-language block on a Codex steer at de", async () => {
  const prev = config.operatorLanguage;
  config.operatorLanguage = "de";
  try {
    const h = harness({ session: sess({ agentProvider: "codex" }), gate: { approved: true } });
    expect(await h.svc.releasePlanGate("s1")).toBe(true);
    expect(h.sent.map((s) => s.text).join("")).toContain(operatorLanguageBlock("de")!);
  } finally {
    config.operatorLanguage = prev;
  }
});

test("releasePlanGate carries NO operator-language block for Codex+en or Claude+de", async () => {
  const prev = config.operatorLanguage;
  const marker = "<operator-language>";
  try {
    config.operatorLanguage = "en";
    const en = harness({ session: sess({ agentProvider: "codex" }), gate: { approved: true } });
    expect(await en.svc.releasePlanGate("s1")).toBe(true);
    expect(en.sent.map((s) => s.text).join("")).not.toContain(marker);

    config.operatorLanguage = "de";
    const claude = harness({
      session: sess({ agentProvider: "claude" }),
      gate: { approved: true },
    });
    expect(await claude.svc.releasePlanGate("s1")).toBe(true);
    expect(claude.sent.map((s) => s.text).join("")).not.toContain(marker);
  } finally {
    config.operatorLanguage = prev;
  }
});

// Go approves the build queue and names it in the steer — a plan-gated agent otherwise never
// writes or advances it (the spawn directive told it to stop and wait).
const QUEUE_MARK = "This session has a build queue";

test("releasePlanGate on a queue repo: steer names the queue, Go approves it as operator", async () => {
  const step = { id: "a", title: "A", detail: "", status: "pending", position: 0 };
  const h = harness({
    session: sess(),
    gate: { approved: true },
    buildQueueEnabled: true,
    queue: { steps: [step], approved: false },
  });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent.map((s) => s.text).join("")).toContain(QUEUE_MARK);
  expect(h.approvals).toEqual([{ id: "s1", approved: true, kind: "operator" }]);
  expect(h.emitted).toContainEqual({
    event: "queue:update",
    data: { sessionId: "s1", steps: [step], approved: true, approvalKind: "operator" },
  });
});

test("releasePlanGate automatic release approves the queue as auto; no emit without steps", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, buildQueueEnabled: true });
  expect(await h.svc.releasePlanGate("s1", { automatic: true })).toBe(true);
  expect(h.approvals).toEqual([{ id: "s1", approved: true, kind: "auto" }]);
  expect(h.emitted.some((e) => e.event === "queue:update")).toBe(false);
});

test("releasePlanGate leaves a spawn-pre-approved queue untouched", async () => {
  const h = harness({
    session: sess(),
    gate: { approved: true },
    buildQueueEnabled: true,
    queue: { steps: [], approved: true, approvalKind: "auto" },
  });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent.map((s) => s.text).join("")).toContain(QUEUE_MARK);
  expect(h.approvals).toHaveLength(0);
});

test("releasePlanGate: no queue clause or approval without a queue (repo off, non-code mode)", async () => {
  for (const h of [
    harness({ session: sess(), gate: { approved: true }, buildQueueEnabled: false }),
    harness({
      session: sess({ research: true }),
      gate: { approved: true },
      buildQueueEnabled: true,
    }),
    harness({ session: sess({ plain: true }), gate: { approved: true }, buildQueueEnabled: true }),
  ]) {
    expect(await h.svc.releasePlanGate("s1")).toBe(true);
    expect(h.sent.map((s) => s.text).join("")).not.toContain(QUEUE_MARK);
    expect(h.approvals).toHaveLength(0);
  }
});

test("releasePlanGate writes no queue approval when the release does not commit", async () => {
  const h = harness({
    session: sess(),
    gate: { approved: true },
    buildQueueEnabled: true,
    revokeOnSend: true,
  });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.approvals).toHaveLength(0);
});

test("plan Go reaches a live Claude pane without a persisted transcript", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, transcriptExists: false });
  expect(await h.svc.releasePlanGate("s1", { automatic: true })).toBe(true);
  expect(h.sent.map((s) => s.text).join("")).toContain("Plan approved.");
  expect(h.setPhaseCalls).toEqual([{ id: "s1", phase: "executing" }]);
});
