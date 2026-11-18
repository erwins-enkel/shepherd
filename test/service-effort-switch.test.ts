import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { SessionService } from "../src/service";

// #3434: mid-session effort switch at the Go / re-gate seams, against a fake herdr pane that
// renders the CLI's confirmation lines the way the spike observed them.

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PICKER = ["low", "medium", "high", "xhigh", "max"];

const saved = { ...SessionService.effortSwitchTiming };
beforeAll(() => {
  SessionService.effortSwitchTiming = { readMs: 40, stepMs: 80, pollMs: 5, retryMs: 5 };
});
afterAll(() => {
  SessionService.effortSwitchTiming = saved;
});

function sess(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    claudeSessionId: "claude-pinned",
    providerSessionId: "codex-pinned",
    codexLaunchId: "launch-test",
    agentProvider: "claude",
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
    effort: "xhigh",
    executionEffort: "medium",
    activeEffort: "xhigh",
    spawnAccountDir: null,
    spawnTerminalId: "t1",
    ...over,
  } as Record<string, unknown>;
}

function harness(opts: {
  session: Record<string, unknown>;
  gate: Record<string, unknown> | null;
  /** The pane renders confirmations (false = the CLI never confirms). */
  confirms?: boolean;
  agentStatus?: string;
  procs?: string[];
  /** readAsync never settles. */
  readHangs?: boolean;
  /** The picker only renders from this `/effort` paste on (1-based; 2 = first attempt misses). */
  confirmFrom?: number;
  /** Render the picker footer wrapped the way a ~60-col pane does. */
  wrapFooter?: boolean;
  /** Render the CC 2.1.327 picker footer (`s to use this session only · Enter to save`). */
  newFooter?: boolean;
  /** The picker renders late: nothing on `/effort`, the footer once the ESC lands. */
  lateOpen?: boolean;
  /** The picker-walk keys write throws (pane died mid-sequence). */
  keysThrow?: boolean;
  /** The agent turns `working` once anything was sent. */
  workingAfterSend?: boolean;
  /** Pane text already visible before the switch. */
  initialScreen?: string;
}) {
  const session = opts.session;
  let gate = opts.gate;
  const sent: string[] = [];
  const emitted: { event: string; data: any }[] = [];
  const phases: string[] = [];
  let screen = opts.initialScreen ?? "";
  let pickerOpens = 0;
  const store = {
    getProviderHandoff: () => null,
    providerHandoffHeld: () => false,
    providerHandoffAutomationHeld: () => false,
    get: () => session,
    list: () => [session],
    getPlanGate: () => gate,
    setPlanPhase: (_id: string, phase: string) => {
      phases.push(phase);
      session.planPhase = phase;
    },
    update: (_id: string, patch: Record<string, unknown>) => Object.assign(session, patch),
    setPlanGateEffortSwitchError: (_id: string, code: string | null) => {
      if (gate) gate = { ...gate, effortSwitchError: code };
    },
    addSignal: () => {},
    getRepoConfig: () => ({ draftMode: false, buildQueueEnabled: false }) as any,
    getBuildQueue: (sessionId: string) => ({ sessionId, steps: [], approved: false }),
    setBuildQueueApproved: () => {},
  };
  const render = (text: string) => {
    if (opts.lateOpen && text === "\x1b") screen += "\ns for this session only";
    if (opts.confirms === false || opts.lateOpen) return;
    if (text === `${PASTE_START}/effort${PASTE_END}` && ++pickerOpens >= (opts.confirmFrom ?? 1))
      screen += opts.newFooter
        ? "\n←/→ to adjust · s to use this session only · Enter to save · Esc to cancel"
        : opts.wrapFooter
          ? "\ns for this session\n  only"
          : "\ns for this session only";
    const codexPrefix = `${PASTE_START}/model --reasoning=`;
    if (text.startsWith(codexPrefix) && text.endsWith(PASTE_END)) {
      const tier = text.slice(codexPrefix.length, -PASTE_END.length);
      screen += `\nModel changed to gpt-x ${tier} for this session only`;
    }
    if (text.endsWith("s") && text.startsWith("\x1b[D")) {
      const idx = text.split("\x1b[C").length - 1;
      screen += `\nSet effort level to ${PICKER[idx]} (this session only)`;
    }
  };
  const svc = new SessionService({
    transcriptExists: () => true,
    store: store as any,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: async () => ({}) as any,
      listAsync: async () => [
        {
          terminalId: "t1",
          paneId: "p1",
          agentStatus:
            opts.workingAfterSend && sent.length ? "working" : (opts.agentStatus ?? "idle"),
        },
      ],
      stop: async () => {},
      paneForegroundProcs: async () => opts.procs ?? ["claude"],
      send: async (_target: string, text: string) => {
        sent.push(text);
        if (opts.keysThrow && text.startsWith("\x1b[D")) throw new Error("pane gone");
        render(text);
      },
      readAsync: async () => (opts.readHangs ? new Promise<string>(() => {}) : screen),
    } as any,
    events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) },
  });
  return { svc, sent, emitted, phases, session, gate: () => gate };
}

const goPasted = (sent: string[]) => sent.some((t) => t.includes("Plan approved."));
const regatePasted = (sent: string[]) => sent.some((t) => t.includes("STOP implementing."));
const switchKeys = (sent: string[]) =>
  sent.filter((t) => t.includes("/effort") || t.includes("/model") || t.startsWith("\x1b[D"));

test("Go switches effort (picker, keys) BEFORE the Go paste, then executes", async () => {
  const h = harness({ session: sess(), gate: { approved: true } });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent).toEqual([
    `${PASTE_START}/effort${PASTE_END}`,
    "\r",
    "\x1b[D".repeat(5) + "\x1b[C" + "s",
    expect.stringContaining("Plan approved."),
    "\r",
  ]);
  expect(h.session.activeEffort).toBe("medium");
  expect(h.session.effort).toBe("xhigh"); // planning selection never overwritten
  expect(h.phases).toEqual(["executing"]);
});

test("Go on Codex sends /model --reasoning", async () => {
  const h = harness({ session: sess({ agentProvider: "codex" }), gate: { approved: true } });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent[0]).toBe(`${PASTE_START}/model --reasoning=medium${PASTE_END}`);
  expect(goPasted(h.sent)).toBe(true);
  expect(h.session.activeEffort).toBe("medium");
});

test("inherit and an already-in-force tier send exactly today's Go bytes", async () => {
  for (const over of [{ executionEffort: null }, { executionEffort: "xhigh" }]) {
    const h = harness({ session: sess(over), gate: { approved: true } });
    expect(await h.svc.releasePlanGate("s1")).toBe(true);
    expect(h.sent).toEqual([expect.stringContaining("Plan approved."), "\r"]);
  }
});

test("an unconfirmed switch withholds Go: ESC, no Go paste, phase stays planning", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, confirms: false });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.sent.at(-1)).toBe("\x1b");
  expect(goPasted(h.sent)).toBe(false);
  expect(h.phases).toEqual([]);
  expect(h.session.activeEffort).toBe("xhigh");
  expect(h.gate()?.effortSwitchError).toBe("unconfirmed");
  expect(h.emitted.some((e) => e.event === "session:plangate" && e.data.gate)).toBe(true);
  // retried exactly once: two picker opens, each closed by its own ESC
  expect(h.sent.filter((t) => t === `${PASTE_START}/effort${PASTE_END}`)).toHaveLength(2);
  expect(h.sent.filter((t) => t === "\x1b")).toHaveLength(2);
});

test("a missed first attempt is retried: ESC, re-open, switch, then Go", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, confirmFrom: 2 });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent).toEqual([
    `${PASTE_START}/effort${PASTE_END}`,
    "\r",
    "\x1b",
    `${PASTE_START}/effort${PASTE_END}`,
    "\r",
    "\x1b[D".repeat(5) + "\x1b[C" + "s",
    expect.stringContaining("Plan approved."),
    "\r",
  ]);
  expect(h.session.activeEffort).toBe("medium");
  expect(h.gate()?.effortSwitchError ?? null).toBeNull();
});

test("a send that throws mid-sequence gets an ESC and no retry", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, keysThrow: true });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.sent.filter((t) => t === `${PASTE_START}/effort${PASTE_END}`)).toHaveLength(1);
  expect(h.sent.at(-1)).toBe("\x1b");
  expect(h.gate()?.effortSwitchError).toBe("unconfirmed");
});

test("a picker that opens late is closed, never re-pasted into", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, lateOpen: true });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.sent).toEqual([`${PASTE_START}/effort${PASTE_END}`, "\r", "\x1b", "\x1b"]);
  expect(h.gate()?.effortSwitchError).toBe("unconfirmed");
});

for (const [name, over, initialScreen, paste] of [
  [
    "a Codex success line from an earlier switch",
    { agentProvider: "codex" },
    "Model changed to gpt-x medium for this session only",
    `${PASTE_START}/model --reasoning=medium${PASTE_END}`,
  ],
  [
    "agent prose matching the Claude picker marker",
    {},
    "Done — applies for this session only.",
    `${PASTE_START}/effort${PASTE_END}`,
  ],
] as const) {
  test(`${name} on screen does not block the retry`, async () => {
    const h = harness({
      session: sess(over),
      gate: { approved: true },
      confirms: false,
      initialScreen,
    });
    expect(await h.svc.releasePlanGate("s1")).toBe(false);
    expect(h.sent.filter((t) => t === paste)).toHaveLength(2);
    expect(h.sent.filter((t) => t === "\x1b")).toHaveLength(2); // one per attempt, no stray
  });
}

test("a busy second attempt after keys were sent reports unconfirmed, not busy", async () => {
  const h = harness({
    session: sess(),
    gate: { approved: true },
    confirms: false,
    workingAfterSend: true,
  });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.sent.filter((t) => t === `${PASTE_START}/effort${PASTE_END}`)).toHaveLength(1);
  expect(h.gate()?.effortSwitchError).toBe("unconfirmed");
});

test("a wrapped picker footer (narrow pane) confirms on the first attempt", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, wrapFooter: true });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent).not.toContain("\x1b");
  expect(h.session.activeEffort).toBe("medium");
});

test("the CC 2.1.327 picker footer confirms on the first attempt", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, newFooter: true });
  expect(await h.svc.releasePlanGate("s1")).toBe(true);
  expect(h.sent).not.toContain("\x1b");
  expect(h.session.activeEffort).toBe("medium");
});

test("an unconfirmed attempt logs step, attempt and pane context", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const h = harness({ session: sess(), gate: { approved: true }, confirms: false });
    await h.svc.releasePlanGate("s1");
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[effort]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("s1: switch to medium unconfirmed at step 1/2 (attempt 1/2)");
    expect(lines[1]).toContain("(attempt 2/2)");
    expect(lines[0]).toContain("widest line");
  } finally {
    warn.mockRestore();
  }
});

test("a working agent gets nothing: busy, no keys, no Go", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, agentStatus: "working" });
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(h.sent).toEqual([]);
  expect(h.gate()?.effortSwitchError).toBe("busy");
});

test("Go at planning effort clears executionEffort and Goes without a switch", async () => {
  const h = harness({
    session: sess(),
    gate: { approved: true, effortSwitchError: "unconfirmed" },
  });
  expect(await h.svc.releasePlanGate("s1", { skipEffortSwitch: true })).toBe(true);
  expect(h.session.executionEffort).toBeNull();
  expect(switchKeys(h.sent)).toEqual([]);
  expect(goPasted(h.sent)).toBe(true);
  expect(h.gate()?.effortSwitchError).toBeNull();
});

test("a never-resolving pane read releases the session lock (bounded)", async () => {
  const h = harness({ session: sess(), gate: { approved: true }, readHangs: true });
  const started = Date.now();
  expect(await h.svc.releasePlanGate("s1")).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(h.sent).toEqual([]); // baseline read timed out → nothing sent
  expect(h.gate()?.effortSwitchError).toBe("unconfirmed");
  // the lock is free again: a plain steer lands
  expect(await h.svc.reply("s1", "hello")).toBe(true);
  expect(h.sent.some((t) => t.includes("hello"))).toBe(true);
});

test("another session's steer is not held up by a pending switch", async () => {
  const other = sess({ id: "s2", herdrAgentId: "t2", spawnTerminalId: "t2" });
  const a = harness({ session: sess(), gate: { approved: true }, readHangs: true });
  // second session on the SAME service: route get/list by id
  const store = (a.svc as any).deps.store;
  const first = store.get();
  store.get = (id: string) => (id === "s2" ? other : first);
  store.list = () => [first, other];
  const herdr = (a.svc as any).deps.herdr;
  herdr.listAsync = async () => [
    { terminalId: "t1", paneId: "p1", agentStatus: "idle" },
    { terminalId: "t2", paneId: "p2", agentStatus: "idle" },
  ];
  const go = a.svc.releasePlanGate("s1");
  await new Promise((r) => setTimeout(r, 5)); // s1 is inside its lock, polling
  expect(await a.svc.reply("s2", "other")).toBe(true);
  expect(a.sent.some((t) => t.includes("other"))).toBe(true);
  await go;
});

test("re-gate restores the planning effort before the stop steer", async () => {
  const h = harness({
    session: sess({ planPhase: "executing", activeEffort: "medium" }),
    gate: { approved: false },
  });
  expect(await h.svc.regatePlanGate("s1")).toBe(true);
  expect(h.sent.slice(0, 3)).toEqual([
    `${PASTE_START}/effort${PASTE_END}`,
    "\r",
    "\x1b[D".repeat(5) + "\x1b[C".repeat(3) + "s",
  ]);
  expect(regatePasted(h.sent)).toBe(true);
  expect(h.session.activeEffort).toBe("xhigh");
  expect(h.gate()?.effortSwitchError ?? null).toBeNull();
});

for (const [name, opts] of [
  ["planning effort is the provider default", { session: { effort: null } }],
  ["the Claude agent is working", { agentStatus: "working" }],
  ["the Codex pane is a shell", { session: { agentProvider: "codex" }, procs: ["zsh"] }],
] as const) {
  test(`re-gate skips the restore (no keys, no ESC) when ${name}`, async () => {
    const h = harness({
      session: sess({ planPhase: "executing", activeEffort: "medium", ...(opts as any).session }),
      gate: { approved: false },
      agentStatus: (opts as any).agentStatus,
      procs: (opts as any).procs,
    });
    expect(await h.svc.regatePlanGate("s1")).toBe(true);
    expect(switchKeys(h.sent)).toEqual([]);
    expect(h.sent).not.toContain("\x1b");
    expect(regatePasted(h.sent)).toBe(true);
    expect(h.session.activeEffort).toBe("medium");
    expect(h.gate()?.effortSwitchError).toBe("restore_skipped");
  });
}

test("re-gate with an unconfirmed restore still re-gates (restore_unconfirmed)", async () => {
  const h = harness({
    session: sess({ planPhase: "executing", activeEffort: "medium" }),
    gate: { approved: false },
    confirms: false,
  });
  expect(await h.svc.regatePlanGate("s1")).toBe(true);
  expect(regatePasted(h.sent)).toBe(true);
  expect(h.gate()?.effortSwitchError).toBe("restore_unconfirmed");
});

test("re-gate without a pending restore sends exactly today's bytes", async () => {
  const h = harness({
    session: sess({ planPhase: "executing", executionEffort: null, activeEffort: "xhigh" }),
    gate: { approved: false },
  });
  expect(await h.svc.regatePlanGate("s1")).toBe(true);
  expect(h.sent).toEqual([expect.stringContaining("STOP implementing."), "\r"]);
});

// Replace-agent effort fields keep #1418: a later resume (phaseEffort) re-emits the spawned tier.
test("replacedEffortFields: executing + provider default collapses both phases (no flag on resume)", async () => {
  const { replacedEffortFields } = await import("../src/service");
  const { phaseEffort } = await import("../src/effort-switch");
  const s = sess({ planPhase: "executing", effort: "xhigh", executionEffort: "medium" }) as any;
  const f = replacedEffortFields(s, "claude", null);
  expect(f).toEqual({ effort: null, executionEffort: null, activeEffort: null });
  expect(phaseEffort({ ...s, ...f })).toBeNull();
});

test("replacedEffortFields: executing + tier sets the execution effort, keeps planning", async () => {
  const { replacedEffortFields } = await import("../src/service");
  const { phaseEffort } = await import("../src/effort-switch");
  const s = sess({ planPhase: "executing", effort: "xhigh", executionEffort: "medium" }) as any;
  const f = replacedEffortFields(s, "claude", "low");
  expect(f).toEqual({ effort: "xhigh", executionEffort: "low", activeEffort: "low" });
  expect(phaseEffort({ ...s, ...f })).toBe("low");
});

test("replacedEffortFields: carried tiers are re-clamped to the new provider", async () => {
  const { replacedEffortFields } = await import("../src/service");
  const executing = sess({ planPhase: "executing", effort: "ultra", executionEffort: "medium" });
  expect(replacedEffortFields(executing as any, "claude", "high").effort).toBeNull();
  const planning = sess({ planPhase: "planning", effort: "high", executionEffort: "ultra" });
  expect(replacedEffortFields(planning as any, "claude", "high")).toEqual({
    effort: "high",
    executionEffort: null,
    activeEffort: "high",
  });
});
