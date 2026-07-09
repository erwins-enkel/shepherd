// Steer-defer guard (herdr-restart account-loss fix, task 4b): closes the residual race where an
// autonomous caller (retryHalted/automerge/autopilot) fires in the brief window before the
// poller's proactive re-drive (task 4a) lands, and steers a herdr-restored account husk instead of
// the correct (re-driven) pane. SessionService.shouldDeferSteer(id) is the shared predicate;
// retryHalted is the one autonomous caller that lives in service.ts, so its defer behavior is
// exercised here too. automerge.doRebase / autopilot.sendSteer are covered in their own test files.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import type { HerdrAgent } from "../src/herdr";

const REDRIVE_CAP = (SessionService as unknown as { REDRIVE_CAP: number }).REDRIVE_CAP;

function fakeAgent(terminalId: string, cwd: string): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "working",
    cwd,
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId,
    workspaceId: "w",
  };
}

/** Minimal service: only shouldDeferSteer + retryHalted are exercised, so the spawn-side deps
 *  (namer/worktree) are never actually invoked — same shape as test/retry-halted.test.ts. */
function makeHarness(agents: HerdrAgent[] = []) {
  const store = new SessionStore(":memory:");
  const resumed: string[] = [];
  const sent: { target: string; text: string }[] = [];

  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      ensureBaseRef: async () => {},
      remove: () => {},
      branchExists: () => false,
    } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => agents,
      stop: async () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
      relabel: async () => {},
    } as any,
  });

  // Patch resume so retryHalted's dead/deferred branch never actually spawns claude.
  (svc as any).resume = async (id: string) => {
    resumed.push(id);
    return store.get(id);
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

  return { store, svc, mk, resumed, sent };
}

test("shouldDeferSteer: restored account husk, not exhausted -> true", () => {
  const { store, svc, mk } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2"); // herdrAgentId already re-pointed to the live husk
  store.setSpawnIdentity(a.id, "T1", "/acct"); // spawned on T1 under an owning account

  expect(svc.shouldDeferSteer(a.id)).toBe(true);
});

test("shouldDeferSteer: exhausted (degraded) -> false", () => {
  const { store, svc, mk } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2");
  store.setSpawnIdentity(a.id, "T1", "/acct");

  // Seed the bounded re-drive counter to CAP on the matching anchor (T1) — same technique the
  // brief allows in lieu of driving CAP real failures through reDriveAccount.
  (svc as any).redriveAttempts.set(a.id, { anchor: "T1", attempts: REDRIVE_CAP });

  expect(svc.shouldDeferSteer(a.id)).toBe(false);
});

test("shouldDeferSteer: default session (spawnAccountDir null) -> false", () => {
  const { store, svc, mk } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2");
  store.setSpawnIdentity(a.id, "T1", null);

  expect(svc.shouldDeferSteer(a.id)).toBe(false);
});

test("shouldDeferSteer: healed (live terminalId === spawnTerminalId) -> false", () => {
  const { store, svc, mk } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2");
  store.setSpawnIdentity(a.id, "T2", "/acct"); // anchor now matches the live pane

  expect(svc.shouldDeferSteer(a.id)).toBe(false);
});

test("shouldDeferSteer: no live agent -> false", () => {
  const { store, svc, mk } = makeHarness([]); // herdr lists nothing
  const a = mk("a", "T2");
  store.setSpawnIdentity(a.id, "T1", "/acct");

  expect(svc.shouldDeferSteer(a.id)).toBe(false);
});

test("retryHalted: restored account husk (live, deferred) -> resume(), not replyToLive", async () => {
  const { store, svc, mk, resumed, sent } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2"); // in `live` per liveTerminalIds()
  store.setSpawnIdentity(a.id, "T1", "/acct"); // restored husk: T2 live != T1 anchor
  store.setHaltReason(a.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id], "please continue");

  expect(result).toEqual({ resumed: 1, steered: 0, total: 1 });
  expect(resumed).toEqual([a.id]);
  expect(sent).toEqual([]); // never steered the wrong-account husk
});

test("retryHalted: healed account pane (live, not deferred) -> steers as today", async () => {
  const { store, svc, mk, resumed, sent } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2");
  store.setSpawnIdentity(a.id, "T2", "/acct"); // healed: anchor matches live terminalId
  store.setHaltReason(a.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id], "please continue");

  expect(result).toEqual({ resumed: 0, steered: 1, total: 1 });
  expect(resumed).toEqual([]);
  expect(sent.some((s) => s.target === "T2" && s.text.includes("please continue"))).toBe(true);
});

test("retryHalted: degraded account pane (live, exhausted) -> steers as today (no-worse)", async () => {
  const { store, svc, mk, resumed, sent } = makeHarness([fakeAgent("T2", "/wt/a")]);
  const a = mk("a", "T2");
  store.setSpawnIdentity(a.id, "T1", "/acct"); // still an unhealed husk...
  (svc as any).redriveAttempts.set(a.id, { anchor: "T1", attempts: REDRIVE_CAP }); // ...but exhausted
  store.setHaltReason(a.id, "usage_limit", 1000);

  const result = await svc.retryHalted([a.id], "please continue");

  expect(result).toEqual({ resumed: 0, steered: 1, total: 1 });
  expect(resumed).toEqual([]);
  expect(sent.some((s) => s.target === "T2")).toBe(true);
});
