import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";

/** Build a minimal service with controllable liveness + resume + replyToLive. */
function makeHarness({
  liveIds = new Set<string>(),
  resumeResult = true,
}: {
  liveIds?: Set<string>;
  resumeResult?: boolean;
} = {}) {
  const store = new SessionStore(":memory:");
  const sent: { target: string; text: string }[] = [];
  const resumed: string[] = [];
  const setHaltCalls: { id: string; reason: null; at: null }[] = [];
  const emitted: { event: string; data: any }[] = [];

  const origSetHaltReason = store.setHaltReason.bind(store);
  store.setHaltReason = (id, reason, haltedAt) => {
    if (reason === null) setHaltCalls.push({ id, reason, at: haltedAt as null });
    origSetHaltReason(id, reason, haltedAt);
  };

  const mk = (name: string, agentId: string) =>
    store.create({
      name,
      prompt: "x",
      repoPath: "/r",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/wt/${name}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: agentId,
    });

  const svc = new SessionService({
    store,
    events: { emit: (event: string, data: any) => emitted.push({ event, data }) } as any,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      ensureBaseRef: async () => {},
      remove: () => {},
      branchExists: () => false,
    } as any,
    herdr: {
      start: () => ({}) as any,
      list: () =>
        [...liveIds].map((id) => ({ terminalId: id, agentStatus: "idle", cwd: "/", name: "" })),
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
      relabel: () => {},
    } as any,
  });

  // Patch resume so it doesn't actually spawn claude.
  (svc as any).resume = async (id: string) => {
    resumed.push(id);
    return resumeResult ? store.get(id) : null;
  };

  return { store, svc, mk, sent, resumed, setHaltCalls, emitted };
}

test("retryHalted: live session is steered, not resumed", async () => {
  const { store, svc, mk, sent, resumed, setHaltCalls } = makeHarness({
    liveIds: new Set(["term_a"]),
  });
  const a = mk("a", "term_a");
  store.setHaltReason(a.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id], "please continue");

  expect(result).toEqual({ resumed: 0, steered: 1, total: 1 });
  // replyToLive sends bracketed paste + CR
  expect(sent.some((s) => s.target === "term_a" && s.text.includes("please continue"))).toBe(true);
  expect(resumed).toEqual([]);
  // flag cleared
  expect(setHaltCalls.some((c) => c.id === a.id && c.reason === null)).toBe(true);
  expect(store.get(a.id)?.haltReason).toBeNull();
});

test("retryHalted: dead-pane session is resumed, not steered", async () => {
  const { store, svc, mk, sent, resumed, setHaltCalls } = makeHarness({
    liveIds: new Set(), // nothing live
  });
  const a = mk("a", "term_a");
  store.setHaltReason(a.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id], "please continue");

  expect(result).toEqual({ resumed: 1, steered: 0, total: 1 });
  expect(sent).toEqual([]);
  expect(resumed).toEqual([a.id]);
  expect(setHaltCalls.some((c) => c.id === a.id && c.reason === null)).toBe(true);
  expect(store.get(a.id)?.haltReason).toBeNull();
});

test("retryHalted: unknown ids are skipped", async () => {
  const { svc, resumed, setHaltCalls } = makeHarness();
  const result = await svc.retryHalted(["ghost-id"], "continue");
  expect(result).toEqual({ resumed: 0, steered: 0, total: 1 });
  expect(resumed).toEqual([]);
  expect(setHaltCalls).toEqual([]);
});

test("retryHalted: failed resume does not clear haltReason", async () => {
  const { store, svc, mk, setHaltCalls } = makeHarness({
    liveIds: new Set(),
    resumeResult: false,
  });
  const a = mk("a", "term_a");
  store.setHaltReason(a.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id], "continue");

  expect(result.resumed).toBe(0);
  expect(setHaltCalls.filter((c) => c.id === a.id)).toEqual([]);
  expect(store.get(a.id)?.haltReason).toBe("usage_limit");
});

test("retryHalted: mixed live and dead sessions", async () => {
  const { store, svc, mk, sent, resumed, setHaltCalls } = makeHarness({
    liveIds: new Set(["term_a"]),
  });
  const a = mk("a", "term_a"); // live → steered
  const b = mk("b", "term_b"); // dead → resumed
  store.setHaltReason(a.id, "usage_limit", 1000);
  store.setHaltReason(b.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id, b.id], "go");

  expect(result).toEqual({ resumed: 1, steered: 1, total: 2 });
  expect(sent.some((s) => s.target === "term_a")).toBe(true);
  expect(resumed).toEqual([b.id]);
  expect(
    setHaltCalls
      .filter((c) => c.reason === null)
      .map((c) => c.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
});

test("retryHalted: steer text is passed verbatim (no hardcoded English)", async () => {
  const { store, svc, mk, sent } = makeHarness({ liveIds: new Set(["term_a"]) });
  const a = mk("a", "term_a");
  store.setHaltReason(a.id, "usage_limit", 1000);

  await svc.retryHalted([a.id], "Fortsetzen bitte");

  expect(sent.some((s) => s.text.includes("Fortsetzen bitte"))).toBe(true);
});

test("retryHalted: emits a clearing session:halt(null) on success so the UI updates live", async () => {
  const { store, svc, mk, emitted } = makeHarness({ liveIds: new Set(["term_a"]) });
  const a = mk("a", "term_a");
  store.setHaltReason(a.id, "usage_limit", 1000);

  await svc.retryHalted([a.id], "please continue");

  // Without the emit (pre-fix), the delta-driven UI never learns the clear and the
  // ⟳ chip / "halted" badge / RetryDialog preselect stay stale until a full reload.
  expect(
    emitted.some(
      (e) =>
        e.event === "session:halt" &&
        e.data.id === a.id &&
        e.data.haltReason === null &&
        e.data.haltedAt === null,
    ),
  ).toBe(true);
});

test("retryHalted: no clearing event when nothing succeeds", async () => {
  const { store, svc, mk, emitted } = makeHarness({ liveIds: new Set(), resumeResult: false });
  const a = mk("a", "term_dead");
  store.setHaltReason(a.id, "usage_limit", 1000);

  await svc.retryHalted([a.id], "please continue");

  expect(emitted.some((e) => e.event === "session:halt")).toBe(false);
  expect(store.get(a.id)?.haltReason).toBe("usage_limit");
});
