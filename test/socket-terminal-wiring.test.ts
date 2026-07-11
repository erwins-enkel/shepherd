import { test, expect } from "bun:test";
import {
  makeApp,
  livePtyAttach,
  recentlyFailed,
  pruneSocketTerminalFailures,
  pickTerminalBridgeKind,
  type AppDeps,
} from "../src/server";
import { config } from "../src/config";
import type { HerdrAgent, HerdrDriver } from "../src/herdr";
import type { Session } from "../src/types";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";

// ── fixtures ─────────────────────────────────────────────────────────────────

const SESSION: Session = {
  id: "s1",
  desig: "TASK-01",
  name: "Add feature",
  prompt: "Add the feature",
  repoPath: "/repo",
  baseBranch: "main",
  branch: "shepherd/add-feature",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_stored",
  claudeSessionId: "c1",
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
  completionRepromptCount: 0,
  planGateEnabled: null,
  planPhase: null,
  autoMergeEnabled: null,
  autoMergeRebaseCount: 0,
  autoMergeRebaseHead: null,
  auto: false,
  issueNumber: null,
  sandboxApplied: null,
  sandboxDegraded: false,
  egressApplied: false,
  egressDegraded: false,
  research: false,
  epicAuthoring: false,
  landingRepair: false,
  status: "done",
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
};

function fakeAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt",
    name: "Add feature",
    paneId: "p1",
    tabId: "t1",
    terminalId: "term_live",
    workspaceId: "w1",
    ...overrides,
  };
}

function fakeHerdr(list: () => HerdrAgent[] | never): Pick<HerdrDriver, "list"> {
  return { list: list as () => HerdrAgent[] };
}

// ── livePtyAttach ────────────────────────────────────────────────────────────

test("livePtyAttach: no herdr → stored id, no paneTarget", () => {
  expect(livePtyAttach(SESSION, undefined)).toEqual({ terminalId: "term_stored" });
});

test("livePtyAttach: matchAgent hit with composed w:p paneId (bare suffix)", () => {
  const herdr = fakeHerdr(() => [
    fakeAgent({ terminalId: "term_stored", paneId: "p1", workspaceId: "w1" }),
  ]);
  expect(livePtyAttach(SESSION, herdr)).toEqual({
    terminalId: "term_stored",
    paneTarget: "w1:p1",
  });
});

test("livePtyAttach: matchAgent hit with an already-composed w:p paneId used as-is", () => {
  const herdr = fakeHerdr(() => [
    fakeAgent({ terminalId: "term_stored", paneId: "w9:p9", workspaceId: "w1" }),
  ]);
  expect(livePtyAttach(SESSION, herdr)).toEqual({
    terminalId: "term_stored",
    paneTarget: "w9:p9",
  });
});

test("livePtyAttach: matchAgent miss → null (truly gone)", () => {
  const herdr = fakeHerdr(() => [fakeAgent({ terminalId: "other", cwd: "/elsewhere" })]);
  expect(livePtyAttach(SESSION, herdr)).toBeNull();
});

test("livePtyAttach: herdr.list() throws → stored id, no paneTarget (hiccup fallback, not null)", () => {
  const herdr = fakeHerdr(() => {
    throw new Error("herdr hiccup");
  });
  expect(livePtyAttach(SESSION, herdr)).toEqual({ terminalId: "term_stored" });
});

// ── pickTerminalBridgeKind ───────────────────────────────────────────────────

test("pickTerminalBridgeKind: socket only when all conditions hold", () => {
  expect(
    pickTerminalBridgeKind({
      herdrSocketTerminal: true,
      herdrSocketActive: true,
      paneTarget: "w1:p1",
      recentlyFailed: false,
    }),
  ).toBe("socket");
});

test("pickTerminalBridgeKind: node-pty when the terminal sub-flag is off (interim gate)", () => {
  // The default: socket driver active, pane resolved, no recent failure — but the interim
  // SHEPHERD_HERDR_SOCKET_TERMINAL gate is off, so the terminal stays on scrollable node-pty.
  expect(
    pickTerminalBridgeKind({
      herdrSocketTerminal: false,
      herdrSocketActive: true,
      paneTarget: "w1:p1",
      recentlyFailed: false,
    }),
  ).toBe("node-pty");
});

test("pickTerminalBridgeKind: node-pty when driver is off", () => {
  expect(
    pickTerminalBridgeKind({
      herdrSocketTerminal: true,
      herdrSocketActive: false,
      paneTarget: "w1:p1",
      recentlyFailed: false,
    }),
  ).toBe("node-pty");
});

test("pickTerminalBridgeKind: node-pty when no paneTarget", () => {
  expect(
    pickTerminalBridgeKind({
      herdrSocketTerminal: true,
      herdrSocketActive: true,
      paneTarget: undefined,
      recentlyFailed: false,
    }),
  ).toBe("node-pty");
});

test("pickTerminalBridgeKind: node-pty when recently failed", () => {
  expect(
    pickTerminalBridgeKind({
      herdrSocketTerminal: true,
      herdrSocketActive: true,
      paneTarget: "w1:p1",
      recentlyFailed: true,
    }),
  ).toBe("node-pty");
});

// ── recentlyFailed ───────────────────────────────────────────────────────────

test("recentlyFailed: true within TTL", () => {
  const m = new Map([["t1", 1000]]);
  expect(recentlyFailed(m, "t1", 1000 + 29_000, 30_000)).toBe(true);
});

test("recentlyFailed: false at/after TTL", () => {
  const m = new Map([["t1", 1000]]);
  expect(recentlyFailed(m, "t1", 1000 + 30_000, 30_000)).toBe(false);
  expect(recentlyFailed(m, "t1", 1000 + 31_000, 30_000)).toBe(false);
});

test("recentlyFailed: false for an unknown id", () => {
  const m = new Map<string, number>();
  expect(recentlyFailed(m, "unknown", 5000, 30_000)).toBe(false);
});

// ── pruneSocketTerminalFailures ──────────────────────────────────────────────

test("pruneSocketTerminalFailures: drops entries at/after TTL, keeps entries within TTL", () => {
  const now = 100_000;
  const m = new Map([
    ["stale", now - 30_000], // exactly at TTL → dropped
    ["staler", now - 40_000], // past TTL → dropped
    ["fresh", now - 10_000], // within TTL → kept
  ]);
  pruneSocketTerminalFailures(m, now, 30_000);
  expect(m.has("stale")).toBe(false);
  expect(m.has("staler")).toBe(false);
  expect(m.has("fresh")).toBe(true);
});

test("pruneSocketTerminalFailures: a just-stamped now entry survives a prune at the same now", () => {
  const now = 100_000;
  const m = new Map([["current", now]]);
  pruneSocketTerminalFailures(m, now, 30_000);
  expect(m.has("current")).toBe(true);
});

// ── GET /api/terminal-transport ──────────────────────────────────────────────

function makeDeps(herdrSocketActive?: boolean): AppDeps {
  const store: Partial<SessionStore> = { get: () => null };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    herdrSocketActive,
  };
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

test("GET /api/terminal-transport returns the flag/active/metric shape", async () => {
  const app = makeApp(makeDeps(true));
  const res = await app.fetch(get("/api/terminal-transport"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body["flagActive"]).toBe(config.herdrSocket);
  expect(body["socketActive"]).toBe(true);
  expect(typeof body["socketAttach"]).toBe("number");
  expect(typeof body["socketFallback"]).toBe("number");
  expect(
    body["lastSocketAttachAt"] === null || typeof body["lastSocketAttachAt"] === "number",
  ).toBe(true);
});

test("GET /api/terminal-transport: socketActive defaults false when deps omit it", async () => {
  const app = makeApp(makeDeps(undefined));
  const res = await app.fetch(get("/api/terminal-transport"));
  const body = (await res.json()) as Record<string, unknown>;
  expect(body["socketActive"]).toBe(false);
});

test("POST /api/terminal-transport → falls through (wrong method)", async () => {
  const app = makeApp(makeDeps(true));
  const res = await app.fetch(
    new Request("http://localhost/api/terminal-transport", { method: "POST" }),
  );
  expect(res.status).toBe(404);
});

test("GET /api/terminal-transport/extra → falls through (wrong path)", async () => {
  const app = makeApp(makeDeps(true));
  const res = await app.fetch(get("/api/terminal-transport/extra"));
  expect(res.status).toBe(404);
});
