import { test, expect, vi, afterEach } from "vitest";
import { HerdStore } from "./store.svelte";
import { toasts } from "./toasts.svelte";

import type {
  AutoMergeStatus,
  BacklogPayload,
  BuildQueue,
  CompletedEpic,
  DrainStatus,
  Epic,
  EpicChildState,
  GitState,
  Session,
  SessionActivity,
  SubagentEntry,
} from "./types";

const GIT: GitState = {
  kind: "github",
  state: "open",
  number: 4,
  checks: "pending",
  deployConfigured: false,
};

function session(id: string): Session {
  return {
    id,
    desig: "TASK-01",
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    status: "running",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
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
  };
}

const DRAIN: DrainStatus = {
  repoPath: "/r",
  enabled: true,
  paused: false,
  reason: null,
  detail: null,
  queued: 2,
  inFlight: 1,
  max: 3,
  epicParent: null,
};

test("setGit hydrates the git map", () => {
  const s = new HerdStore();
  s.setGit({ s1: GIT });
  expect(s.git.s1?.state).toBe("open");
});

test("session:git merges into the git map", () => {
  const s = new HerdStore();
  s.apply({ event: "session:git", data: { id: "s1", git: GIT } });
  expect(s.git.s1?.number).toBe(4);
});

test("session:ready patches the target session's readyToMerge", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({ event: "session:ready", data: { id: "s1", ready: true } });
  expect(s.byId("s1")?.readyToMerge).toBe(true);
  expect(s.byId("s2")?.readyToMerge).toBe(false);
  s.apply({ event: "session:ready", data: { id: "s1", ready: false } });
  expect(s.byId("s1")?.readyToMerge).toBe(false);
});

test("session:status with session fields patches the existing row in place", () => {
  const s = new HerdStore();
  const original = session("s1");
  s.setAll([original]);
  s.apply({
    event: "session:status",
    data: {
      ...original,
      herdrAgentId: "term_codex",
      claudeSessionId: "",
      agentProvider: "codex",
      model: "gpt-5.5",
      status: "running",
      worktreePath: "/wt",
    },
  });
  expect(s.sessions).toHaveLength(1);
  expect(s.byId("s1")?.worktreePath).toBe("/wt");
  expect(s.byId("s1")?.herdrAgentId).toBe("term_codex");
  expect(s.byId("s1")?.agentProvider).toBe("codex");
  expect(s.byId("s1")?.model).toBe("gpt-5.5");
});

test("session:experiment links the target into a comparison group live", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  expect(s.byId("s1")?.experimentId).toBe(null);
  // back-fill the original when its first variant spawns
  s.apply({
    event: "session:experiment",
    data: { id: "s1", experimentId: "exp-1", experimentRole: "variant" },
  });
  expect(s.byId("s1")?.experimentId).toBe("exp-1");
  expect(s.byId("s1")?.experimentRole).toBe("variant");
  // unrelated sessions are untouched
  expect(s.byId("s2")?.experimentId).toBe(null);
});

test("plugin:status updates the matching plugin's health + published status in place", () => {
  const s = new HerdStore();
  s.setPlugins([
    {
      id: "p1",
      name: "P1",
      version: "1.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
    {
      id: "p2",
      name: "P2",
      version: "2.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
  ]);
  s.apply({ event: "plugin:status", data: { id: "p1", health: "errored", status: { n: 7 } } });
  expect(s.plugins.find((p) => p.id === "p1")).toMatchObject({
    health: "errored",
    status: { n: 7 },
  });
  // unrelated plugin untouched; unknown id is ignored (no row added)
  expect(s.plugins.find((p) => p.id === "p2")?.health).toBe("ok");
  s.apply({ event: "plugin:status", data: { id: "ghost", health: "ok", status: null } });
  expect(s.plugins).toHaveLength(2);
});

test("plugin:ui updates the matching plugin's ui descriptor in place", () => {
  const s = new HerdStore();
  s.setPlugins([
    {
      id: "p1",
      name: "P1",
      version: "1.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
    {
      id: "p2",
      name: "P2",
      version: "2.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
  ]);
  const view = {
    schemaVersion: 1 as const,
    slot: "settings-panel" as const,
    root: { type: "text", props: { value: "hello" } },
  };
  s.apply({ event: "plugin:ui", data: { id: "p1", ui: view } });
  expect(s.plugins.find((p) => p.id === "p1")?.ui).toEqual(view);
  // unrelated plugin untouched
  expect(s.plugins.find((p) => p.id === "p2")?.ui).toBeNull();
  // setting back to null is supported
  s.apply({ event: "plugin:ui", data: { id: "p1", ui: null } });
  expect(s.plugins.find((p) => p.id === "p1")?.ui).toBeNull();
});

test("plugin:ui for an unknown id is a no-op (pre-bootstrap guard)", () => {
  const s = new HerdStore();
  s.setPlugins([
    {
      id: "p1",
      name: "P1",
      version: "1.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
  ]);
  s.apply({
    event: "plugin:ui",
    data: {
      id: "ghost",
      ui: {
        schemaVersion: 1,
        slot: "settings-panel",
        root: { type: "text", props: { value: "x" } },
      },
    },
  });
  // no new plugin row added; existing plugin untouched
  expect(s.plugins).toHaveLength(1);
  expect(s.plugins[0].ui).toBeNull();
});

test("plugin:gear updates the matching plugin's gear item in place", () => {
  const s = new HerdStore();
  s.setPlugins([
    {
      id: "p1",
      name: "P1",
      version: "1.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
    {
      id: "p2",
      name: "P2",
      version: "2.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
  ]);
  const item = { label: "Open settings", icon: "⚙️", action: { kind: "panel" as const } };
  s.apply({ event: "plugin:gear", data: { id: "p1", gearItem: item } });
  expect(s.plugins.find((p) => p.id === "p1")?.gearItem).toEqual(item);
  // unrelated plugin untouched
  expect(s.plugins.find((p) => p.id === "p2")?.gearItem).toBeNull();
  // setting back to null is supported
  s.apply({ event: "plugin:gear", data: { id: "p1", gearItem: null } });
  expect(s.plugins.find((p) => p.id === "p1")?.gearItem).toBeNull();
});

test("plugin:gear for an unknown id is a no-op (pre-bootstrap guard)", () => {
  const s = new HerdStore();
  s.setPlugins([
    {
      id: "p1",
      name: "P1",
      version: "1.0.0",
      health: "ok",
      lastError: null,
      status: null,
      ui: null,
      gearItem: null,
    },
  ]);
  s.apply({
    event: "plugin:gear",
    data: {
      id: "ghost",
      gearItem: { label: "Ghost action", action: { kind: "panel" } },
    },
  });
  // no new plugin row added; existing plugin untouched
  expect(s.plugins).toHaveLength(1);
  expect(s.plugins[0].gearItem).toBeNull();
});

test("backlog:update replaces the backlog snapshot so the overview stays live", () => {
  const s = new HerdStore();
  expect(s.backlog).toBeNull();

  const stale: BacklogPayload = {
    pinnedPath: "/r",
    projects: [],
    totals: { openIssues: 2, openPRs: 0 },
  };
  s.apply({ event: "backlog:update", data: stale });
  expect(s.backlog?.totals.openIssues).toBe(2);

  // a later push (server poller warmed fresher counts) overwrites the snapshot
  const fresh: BacklogPayload = {
    pinnedPath: "/r",
    projects: [],
    totals: { openIssues: 4, openPRs: 1 },
  };
  s.apply({ event: "backlog:update", data: fresh });
  expect(s.backlog?.totals.openIssues).toBe(4);
  expect(s.backlog?.totals.openPRs).toBe(1);
});

test("session:archived drops the git entry", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.setGit({ s1: GIT });
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.git.s1).toBeUndefined();
});

test("session:autopilot merges autopilot fields into the matching session", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({
    event: "session:autopilot",
    data: { id: "s1", paused: true, complete: false, question: "Which provider?", enabled: true },
  });
  const a = s.byId("s1");
  const b = s.byId("s2");
  expect(a?.autopilotPaused).toBe(true);
  expect(a?.autopilotQuestion).toBe("Which provider?");
  expect(a?.autopilotEnabled).toBe(true);
  expect(b?.autopilotPaused).toBe(false); // other sessions untouched
  // complete path
  s.apply({
    event: "session:autopilot",
    data: {
      id: "s1",
      paused: false,
      complete: true,
      question: "Created issue #345.",
      enabled: true,
    },
  });
  expect(s.byId("s1")?.autopilotComplete).toBe(true);
  expect(s.byId("s1")?.autopilotPaused).toBe(false);
  // clear path
  s.apply({
    event: "session:autopilot",
    data: { id: "s1", paused: false, complete: false, question: null, enabled: null },
  });
  expect(s.byId("s1")?.autopilotPaused).toBe(false);
  expect(s.byId("s1")?.autopilotComplete).toBe(false);
  expect(s.byId("s1")?.autopilotQuestion).toBeNull();
  expect(s.byId("s1")?.autopilotEnabled).toBeNull();
});

test("session:renamed patches the name + branch of the matching session", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({
    event: "session:renamed",
    data: { id: "s1", name: "fresh", branch: "shepherd/fresh" },
  });
  const a = s.sessions.find((x) => x.id === "s1");
  const b = s.sessions.find((x) => x.id === "s2");
  expect(a?.name).toBe("fresh");
  expect(a?.branch).toBe("shepherd/fresh");
  expect(b?.name).toBe("n"); // other sessions untouched
});

test("session:renamed surfaces a toast naming the new name", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({
    event: "session:renamed",
    data: { id: "s1", name: "fresh", branch: "shepherd/fresh" },
  });
  expect(toasts.items.some((t) => t.text.includes("fresh"))).toBe(true);
});

test("session:renamed adopts a new branch silently when the display name is unchanged", () => {
  // contingency path (syncWorktreeBranch) re-emits with the same name when only the
  // branch moved — no visible change, so no "Renamed to <same name>" toast noise.
  toasts.items = [];
  const s = new HerdStore();
  s.setAll([session("s1")]); // name "n"
  s.apply({
    event: "session:renamed",
    data: { id: "s1", name: "n", branch: "shepherd/adopted" },
  });
  expect(s.sessions.find((x) => x.id === "s1")?.branch).toBe("shepherd/adopted"); // still adopted
  expect(toasts.items).toHaveLength(0); // but no toast
});

// ---- /events WS reconnect (mobile background-drop / wake recovery) ----
// The live stream is delta-only; a frozen mobile tab drops the socket and the
// onclose backoff timer is frozen with it. connect() must resume the stream on
// tab return without leaving a duplicate socket behind.

class FakeWs {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  accept() {
    this.readyState = 1; // server accepted the socket → OPEN
    this.onopen?.();
  }
}

function stubDom(state: { visibilityState: "visible" | "hidden" }) {
  const on: Record<string, ((e?: unknown) => void)[]> = {};
  const add = (k: string) => (t: string, h: (e?: unknown) => void) => (on[k + t] ??= []).push(h);
  const rm = (k: string) => (t: string, h: (e?: unknown) => void) =>
    (on[k + t] = (on[k + t] ?? []).filter((x) => x !== h));
  (globalThis as unknown as { document: unknown }).document = {
    get visibilityState() {
      return state.visibilityState;
    },
    hasFocus: () => state.visibilityState === "visible",
    addEventListener: add("d:"),
    removeEventListener: rm("d:"),
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: add("w:"),
    removeEventListener: rm("w:"),
  };
  return { fire: (k: string, t: string, e?: unknown) => (on[k + t] ?? []).forEach((h) => h(e)) };
}

function connectFake(s: HerdStore) {
  const made: FakeWs[] = [];
  const dispose = s.connect(() => {
    const w = new FakeWs();
    made.push(w);
    return w as unknown as WebSocket;
  });
  return { made, dispose };
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.useRealTimers();
});

test("reconnects after the socket drops while the tab is open", () => {
  vi.useFakeTimers();
  stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  made[0].accept();
  expect(s.connected).toBe(true);
  made[0].close(); // socket dies → schedules 1s backoff
  expect(s.connected).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(made.length).toBe(2); // backoff reopened
  dispose();
});

test("tab return reconnects a dropped socket immediately, cancelling the frozen backoff", () => {
  vi.useFakeTimers();
  const dom = stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  made[0].accept();
  made[0].close(); // onclose schedules backoff (frozen on a real device)
  dom.fire("d:", "visibilitychange"); // tab returns → reopen now
  expect(made.length).toBe(2);
  vi.advanceTimersByTime(5000); // the cancelled backoff must NOT spawn a 3rd socket
  expect(made.length).toBe(2);
  dispose();
});

test("tab return on a socket still stuck CONNECTING reopens it (frozen handshake)", () => {
  const dom = stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  // never accept() → readyState stays 0 (CONNECTING), as after a mid-handshake freeze
  dom.fire("d:", "visibilitychange");
  expect(made.length).toBe(2); // stale CONNECTING socket is not left alone
  dispose();
});

test("connectionEpoch counts every opened socket — incl. a replacement after a silent kill (no onclose)", () => {
  const dom = stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  expect(s.connectionEpoch).toBe(0);
  made[0].accept();
  expect(s.connectionEpoch).toBe(1); // initial page-load connect
  // Mobile freeze kills the socket WITHOUT firing onclose: `connected` never flips
  // false, so a connected false→true edge-watcher would miss the replacement —
  // this is exactly why the resync trigger anchors on the epoch instead.
  made[0].readyState = 3;
  dom.fire("d:", "visibilitychange"); // tab returns → replacement socket
  expect(made.length).toBe(2);
  expect(s.connected).toBe(true); // never observed the drop
  made[1].accept();
  expect(s.connectionEpoch).toBe(2); // replacement open still advances the epoch
  dispose();
});

test("pageshow(persisted) reconnects a dropped socket (iOS bfcache restore)", () => {
  vi.useFakeTimers();
  const dom = stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  made[0].accept();
  made[0].close();
  dom.fire("w:", "pageshow", { persisted: true });
  expect(made.length).toBe(2);
  vi.advanceTimersByTime(5000); // cancelled backoff must not spawn a 3rd
  expect(made.length).toBe(2);
  dispose();
});

test("dispose during a pending backoff stops the reconnect", () => {
  vi.useFakeTimers();
  stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  made[0].accept();
  made[0].close(); // schedules the 1s backoff
  dispose(); // must clear the pending timer
  vi.advanceTimersByTime(5000);
  expect(made.length).toBe(1);
});

test("tab return on a live socket reports presence instead of reconnecting", () => {
  const dom = stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  made[0].accept();
  made[0].sent.length = 0;
  dom.fire("d:", "visibilitychange");
  expect(made.length).toBe(1); // healthy socket left alone
  expect(made[0].sent.some((m) => m.includes("presence"))).toBe(true);
  dispose();
});

test("dispose stops the reconnect loop", () => {
  vi.useFakeTimers();
  stubDom({ visibilityState: "visible" });
  const s = new HerdStore();
  const { made, dispose } = connectFake(s);
  made[0].accept();
  dispose(); // closes the socket; stopped flag must suppress the reconnect
  vi.advanceTimersByTime(5000);
  expect(made.length).toBe(1);
});

// ── drain state ────────────────────────────────────────────────────────────

test("setDrain hydrates the drain map from a list", () => {
  const s = new HerdStore();
  s.setDrain([DRAIN]);
  expect(s.drain["/r"]?.queued).toBe(2);
});

test("drain:status merges into the drain map", () => {
  const s = new HerdStore();
  s.apply({ event: "drain:status", data: DRAIN });
  expect(s.drain["/r"]?.inFlight).toBe(1);
});

test("drain:status overwrites a previous entry for the same repoPath", () => {
  const s = new HerdStore();
  s.setDrain([DRAIN]);
  s.apply({ event: "drain:status", data: { ...DRAIN, queued: 0, inFlight: 0 } });
  expect(s.drain["/r"]?.queued).toBe(0);
});

// ── session:activity ───────────────────────────────────────────────────────

const ACTIVITY: SessionActivity = {
  lastActivityTs: 1000,
  summary: "edited poller.ts",
  recentTs: [1000],
  recentErrTs: [],
};

test("session:activity populates the activity map for that session", () => {
  const s = new HerdStore();
  s.apply({ event: "session:activity", data: { id: "s1", activity: ACTIVITY } });
  expect(s.activity["s1"]?.lastActivityTs).toBe(1000);
  expect(s.activity["s1"]?.summary).toBe("edited poller.ts");
});

test("session:activity replaces an existing entry (latest wins)", () => {
  const s = new HerdStore();
  s.apply({ event: "session:activity", data: { id: "s1", activity: ACTIVITY } });
  const updated: SessionActivity = {
    lastActivityTs: 2000,
    summary: "$ bun test",
    recentTs: [2000],
    recentErrTs: [],
  };
  s.apply({ event: "session:activity", data: { id: "s1", activity: updated } });
  expect(s.activity["s1"]?.lastActivityTs).toBe(2000);
  expect(s.activity["s1"]?.summary).toBe("$ bun test");
});

test("session:critic-activity routes to the reviews store", async () => {
  const { reviews } = await import("./reviews.svelte");
  reviews.activity = {};
  const s = new HerdStore();
  s.apply({ event: "session:critic-activity", data: { id: "s1", summary: "$ git diff" } });
  expect(reviews.activityFor("s1")).toBe("$ git diff");
});

test("session:plangate-activity routes to the plan-gates store feed", async () => {
  const { planGates } = await import("./reviews.svelte");
  planGates.activity = {};
  planGates.reviewing = {};
  const s = new HerdStore();
  s.apply({ event: "session:plangate-activity", data: { id: "s1", summary: "read plan" } });
  expect(planGates.activityFeed("s1")).toEqual(["read plan"]);
});

test("session:plangate-reviewing false clears the plan-gate activity feed", async () => {
  const { planGates } = await import("./reviews.svelte");
  planGates.activity = {};
  planGates.reviewing = {};
  const s = new HerdStore();
  s.apply({ event: "session:plangate-reviewing", data: { id: "s1", reviewing: true } });
  s.apply({ event: "session:plangate-activity", data: { id: "s1", summary: "read plan" } });
  expect(planGates.activityFeed("s1")).toEqual(["read plan"]);
  s.apply({ event: "session:plangate-reviewing", data: { id: "s1", reviewing: false } });
  expect(planGates.activityFeed("s1")).toEqual([]);
});

test("session:reviewing false clears the critic activity feed", async () => {
  const { reviews } = await import("./reviews.svelte");
  reviews.activity = {};
  reviews.reviewing = {};
  reviews.reviewerEnv = {};
  const s = new HerdStore();
  s.apply({
    event: "session:reviewing",
    data: {
      id: "s1",
      reviewing: true,
      env: { provider: "codex", model: "gpt-5.5", effort: "high" },
    },
  });
  expect(reviews.reviewerEnvFor("s1")).toEqual({
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
  });
  s.apply({ event: "session:critic-activity", data: { id: "s1", summary: "$ git diff" } });
  expect(reviews.activityFeed("s1")).toEqual(["$ git diff"]);
  s.apply({ event: "session:reviewing", data: { id: "s1", reviewing: false } });
  expect(reviews.activityFeed("s1")).toEqual([]);
  expect(reviews.reviewerEnvFor("s1")).toBeNull();
});

// ── session:subagents ──────────────────────────────────────────────────────

const SUBAGENTS: SubagentEntry[] = [{ agentId: "a1", agentType: "Explore", startedAt: 1000 }];

test("setSubagents seeds the roster map for bootstrap", () => {
  const s = new HerdStore();
  s.setSubagents({ s1: SUBAGENTS });
  expect(s.subagents["s1"]?.[0]?.agentId).toBe("a1");
  expect(s.subagents["s2"]).toBeUndefined();
});

test("session:subagents upserts a session's roster (latest wins)", () => {
  const s = new HerdStore();
  s.apply({ event: "session:subagents", data: { id: "s1", subagents: SUBAGENTS } });
  expect(s.subagents["s1"]).toHaveLength(1);
  expect(s.subagents["s1"]?.[0]?.agentType).toBe("Explore");
  const updated: SubagentEntry[] = [
    { agentId: "a1", agentType: "Explore", startedAt: 1000, endedAt: 2000 },
    { agentId: "a2", agentType: "Plan", startedAt: 2500 },
  ];
  s.apply({ event: "session:subagents", data: { id: "s1", subagents: updated } });
  expect(s.subagents["s1"]).toHaveLength(2);
  expect(s.subagents["s1"]?.[0]?.endedAt).toBe(2000);
  expect(s.subagents["s1"]?.[1]?.agentId).toBe("a2");
});

test("session:archived drops the subagents entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({ event: "session:subagents", data: { id: "s1", subagents: SUBAGENTS } });
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.subagents["s1"]).toBeUndefined();
});

// ── session:claude-alive ───────────────────────────────────────────────────

test("setClaudeAlive folds the boolean bootstrap into the 3-state liveness map", () => {
  const s = new HerdStore();
  s.setClaudeAlive({ s1: true, s2: false });
  expect(s.claudeAlive["s1"]).toBe("alive");
  expect(s.claudeAlive["s2"]).toBe("husk");
});

test("setClaudeAlive upgrades bootstrapped stranded ids so a reloading client keeps the banner", () => {
  const s = new HerdStore();
  // s2/s3 are husks on the boolean snapshot; /api/stranded says s3 is actually a restart-strand
  s.setClaudeAlive({ s1: true, s2: false, s3: false }, ["s3"]);
  expect(s.claudeAlive["s1"]).toBe("alive");
  expect(s.claudeAlive["s2"]).toBe("husk");
  expect(s.claudeAlive["s3"]).toBe("stranded");
  expect(s.strandedCount).toBe(1); // banner/framing reconstructed without waiting for a flip
});

test("session:claude-alive prefers `liveness`, falling back to the boolean", () => {
  const s = new HerdStore();
  s.apply({
    event: "session:claude-alive",
    data: { id: "s1", claudeAlive: true, liveness: "alive" },
  });
  expect(s.claudeAlive["s1"]).toBe("alive");
  s.apply({
    event: "session:claude-alive",
    data: { id: "s1", claudeAlive: false, liveness: "stranded" },
  });
  expect(s.claudeAlive["s1"]).toBe("stranded");
  // old server (no `liveness`) → derive from the boolean
  s.apply({ event: "session:claude-alive", data: { id: "s1", claudeAlive: false } });
  expect(s.claudeAlive["s1"]).toBe("husk");
});

test("the sticky mass-strand toast is dismissed once the stranded set drains (auto-revive heal)", () => {
  const s = new HerdStore();
  toasts.items = [];
  // two sessions strand → the server raises the sticky banner toast
  s.apply({
    event: "session:claude-alive",
    data: { id: "x1", claudeAlive: false, liveness: "stranded" },
  });
  s.apply({
    event: "session:claude-alive",
    data: { id: "x2", claudeAlive: false, liveness: "stranded" },
  });
  s.apply({ event: "app:sessions-stranded", data: { count: 2 } });
  expect(toasts.items.some((t) => t.key === "sessions-stranded")).toBe(true);
  // one heals — still stranded, banner stays
  s.apply({
    event: "session:claude-alive",
    data: { id: "x1", claudeAlive: true, liveness: "alive" },
  });
  expect(toasts.items.some((t) => t.key === "sessions-stranded")).toBe(true);
  // last one heals → set empty → banner dismissed
  s.apply({
    event: "session:claude-alive",
    data: { id: "x2", claudeAlive: true, liveness: "alive" },
  });
  expect(toasts.items.some((t) => t.key === "sessions-stranded")).toBe(false);
  toasts.items = [];
});

test("session:archived drops the claude-alive entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({
    event: "session:claude-alive",
    data: { id: "s1", claudeAlive: true, liveness: "alive" },
  });
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.claudeAlive["s1"]).toBeUndefined();
});

// ── session:working-blocked ────────────────────────────────────────────────

test("setWorkingBlocked seeds the flag map for bootstrap", () => {
  const s = new HerdStore();
  s.setWorkingBlocked({ s1: true });
  expect(s.workingBlocked["s1"]).toBe(true);
  expect(s.workingBlocked["s2"]).toBeUndefined();
});

test("session:working-blocked sets the flag; working=false drops the key", () => {
  const s = new HerdStore();
  s.apply({ event: "session:working-blocked", data: { id: "s1", working: true } });
  expect(s.workingBlocked["s1"]).toBe(true);
  s.apply({ event: "session:working-blocked", data: { id: "s1", working: false } });
  // false DROPS the entry (keeps the map small) — absent, not stored-false
  expect("s1" in s.workingBlocked).toBe(false);
});

test("session:archived drops the working-blocked entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({ event: "session:working-blocked", data: { id: "s1", working: true } });
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.workingBlocked["s1"]).toBeUndefined();
});

// ── session:preview ────────────────────────────────────────────────────────

test("setPreview seeds the preview map for bootstrap", () => {
  const s = new HerdStore();
  s.setPreview({ s1: 8001, s2: null });
  expect(s.preview["s1"]).toBe(8001);
  expect(s.preview["s2"]).toBeNull();
});

test("session:preview sets the port for that session", () => {
  const s = new HerdStore();
  s.apply({ event: "session:preview", data: { id: "s1", previewPort: 8002 } });
  expect(s.preview["s1"]).toBe(8002);
});

test("session:preview replaces an existing port (latest wins)", () => {
  const s = new HerdStore();
  s.apply({ event: "session:preview", data: { id: "s1", previewPort: 8001 } });
  s.apply({ event: "session:preview", data: { id: "s1", previewPort: 8005 } });
  expect(s.preview["s1"]).toBe(8005);
});

test("session:preview with a null port drops the entry (listener torn down)", () => {
  const s = new HerdStore();
  s.apply({ event: "session:preview", data: { id: "s1", previewPort: 8001 } });
  expect(s.preview["s1"]).toBe(8001);
  s.apply({ event: "session:preview", data: { id: "s1", previewPort: null } });
  expect(s.preview["s1"]).toBeUndefined();
});

test("session:archived drops the preview entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({ event: "session:preview", data: { id: "s1", previewPort: 8001 } });
  expect(s.preview["s1"]).toBe(8001);
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.preview["s1"]).toBeUndefined();
});

// ── session:preview-serve ──────────────────────────────────────────────────

test("setPreviewServe seeds the previewServe map for bootstrap", () => {
  const s = new HerdStore();
  s.setPreviewServe({ s1: "ok", s2: "failed" });
  expect(s.previewServe["s1"]).toBe("ok");
  expect(s.previewServe["s2"]).toBe("failed");
});

test("session:preview-serve with 'failed' sets the entry", () => {
  const s = new HerdStore();
  s.apply({ event: "session:preview-serve", data: { id: "s1", serve: "failed" } });
  expect(s.previewServe["s1"]).toBe("failed");
});

test("session:preview-serve with 'ok' sets the entry", () => {
  const s = new HerdStore();
  s.apply({ event: "session:preview-serve", data: { id: "s1", serve: "ok" } });
  expect(s.previewServe["s1"]).toBe("ok");
});

test("session:preview-serve with null drops the entry", () => {
  const s = new HerdStore();
  s.apply({ event: "session:preview-serve", data: { id: "s1", serve: "failed" } });
  expect(s.previewServe["s1"]).toBe("failed");
  s.apply({ event: "session:preview-serve", data: { id: "s1", serve: null } });
  expect(s.previewServe["s1"]).toBeUndefined();
});

test("session:archived drops the previewServe entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({ event: "session:preview-serve", data: { id: "s1", serve: "failed" } });
  expect(s.previewServe["s1"]).toBe("failed");
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.previewServe["s1"]).toBeUndefined();
});

test("session:merging sets and clears the mark", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({ event: "session:merging", data: { id: "s1", since: 111, trainId: "train-1" } });
  expect(s.byId("s1")?.mergingSince).toBe(111);
  expect(s.byId("s1")?.mergingTrainId).toBe("train-1"); // trainId carried live, not left null
  expect(s.byId("s2")?.mergingSince).toBeNull(); // other sessions untouched
  s.apply({ event: "session:merging", data: { id: "s1", since: null, trainId: null } });
  expect(s.byId("s1")?.mergingSince).toBeNull();
  expect(s.byId("s1")?.mergingTrainId).toBeNull();
});

test("session:archived drops the activity entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({ event: "session:activity", data: { id: "s1", activity: ACTIVITY } });
  expect(s.activity["s1"]).toBeDefined();
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.activity["s1"]).toBeUndefined();
});

// ── automerge state ────────────────────────────────────────────────────────

const AUTOMERGE_STATUS: AutoMergeStatus = {
  repoPath: "/r",
  enabled: true,
  state: "merging",
  detail: "TASK-01",
  sessionId: "s1",
};

test("setAutoMerge hydrates the automerge map from a list", () => {
  const s = new HerdStore();
  s.setAutoMerge([AUTOMERGE_STATUS]);
  expect(s.autoMerge["/r"]?.state).toBe("merging");
  expect(s.autoMerge["/r"]?.detail).toBe("TASK-01");
});

test("automerge:status merges into the automerge map", () => {
  const s = new HerdStore();
  s.apply({ event: "automerge:status", data: AUTOMERGE_STATUS });
  expect(s.autoMerge["/r"]?.enabled).toBe(true);
  expect(s.autoMerge["/r"]?.state).toBe("merging");
});

test("automerge:status overwrites a previous entry for the same repoPath", () => {
  const s = new HerdStore();
  s.setAutoMerge([AUTOMERGE_STATUS]);
  s.apply({ event: "automerge:status", data: { ...AUTOMERGE_STATUS, state: null, detail: null } });
  expect(s.autoMerge["/r"]?.state).toBeNull();
});

test("session:automerge updates the matching session's autoMergeEnabled", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({ event: "session:automerge", data: { id: "s1", enabled: true } });
  expect(s.byId("s1")?.autoMergeEnabled).toBe(true);
  expect(s.byId("s2")?.autoMergeEnabled).toBeNull(); // other sessions untouched
  // null = inherit repo default
  s.apply({ event: "session:automerge", data: { id: "s1", enabled: null } });
  expect(s.byId("s1")?.autoMergeEnabled).toBeNull();
});

// ---- build queue ----

const QUEUE: BuildQueue = {
  sessionId: "s1",
  approved: false,
  steps: [
    { id: "step-1", title: "Install deps", status: "pending", position: 0 },
    { id: "step-2", title: "Run tests", status: "pending", position: 1 },
  ],
};

test("queue:update event populates buildQueues by sessionId", () => {
  const s = new HerdStore();
  s.apply({ event: "queue:update", data: QUEUE });
  expect(s.buildQueues["s1"]).toEqual(QUEUE);
});

test("queue:update replaces an existing entry immutably", () => {
  const s = new HerdStore();
  s.apply({ event: "queue:update", data: QUEUE });
  const updated: BuildQueue = { ...QUEUE, approved: true };
  s.apply({ event: "queue:update", data: updated });
  expect(s.buildQueues["s1"]?.approved).toBe(true);
});

test("setBuildQueue seeds the store for bootstrap", () => {
  const s = new HerdStore();
  s.setBuildQueue(QUEUE);
  expect(s.buildQueues["s1"]).toEqual(QUEUE);
});

test("setBuildQueue does not clobber other sessions", () => {
  const s = new HerdStore();
  const other: BuildQueue = { sessionId: "s2", approved: false, steps: [] };
  s.setBuildQueue(QUEUE);
  s.setBuildQueue(other);
  expect(s.buildQueues["s1"]).toEqual(QUEUE);
  expect(s.buildQueues["s2"]).toEqual(other);
});

// ── mergetrain:landed ──────────────────────────────────────────────────────

test("mergetrain:landed enqueues a repo-keyed landed confirmation toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.apply({ event: "mergetrain:landed", data: { repoPath: "/repos/my-project" } });
  const t = toasts.items.find((x) => x.key === "mergetrain-landed:/repos/my-project");
  expect(t).toBeDefined();
  expect(t!.text).toContain("my-project"); // repo basename interpolated, no Update action
  expect(t!.actionLabel).toBeUndefined();
});

// ── draftreconcile:status ──────────────────────────────────────────────────

test("draftreconcile:status promote_error raises a persistent assertive keyed toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.apply({
    event: "draftreconcile:status",
    data: { repoPath: "/r", sessionId: "dr-promote-1", state: "promote_error", detail: "TASK-01" },
  });
  const t = toasts.items.find((x) => x.key === "draft-reconcile:dr-promote-1");
  expect(t).toBeDefined();
  expect(t?.alert).toBe(true);
  // persistent: no auto-dismiss timer; item must still be present
  expect(toasts.items.some((x) => x.key === "draft-reconcile:dr-promote-1")).toBe(true);
});

test("draftreconcile:status enforce_error raises a persistent assertive keyed toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.apply({
    event: "draftreconcile:status",
    data: { repoPath: "/r", sessionId: "dr-enforce-1", state: "enforce_error", detail: "TASK-02" },
  });
  expect(toasts.items.some((x) => x.key === "draft-reconcile:dr-enforce-1" && x.alert)).toBe(true);
});

test("draftreconcile:status null clears a prior error toast for that session", () => {
  toasts.items = [];
  const s = new HerdStore();
  // first raise an error
  s.apply({
    event: "draftreconcile:status",
    data: { repoPath: "/r", sessionId: "dr-clear-1", state: "promote_error", detail: "TASK-01" },
  });
  expect(toasts.items.some((x) => x.key === "draft-reconcile:dr-clear-1")).toBe(true);
  // then clear it with success (state=null)
  s.apply({
    event: "draftreconcile:status",
    data: { repoPath: "/r", sessionId: "dr-clear-1", state: null, detail: null },
  });
  expect(toasts.items.some((x) => x.key === "draft-reconcile:dr-clear-1")).toBe(false);
});

test("session:archived clears a session's lingering draft-reconcile error toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.apply({
    event: "draftreconcile:status",
    data: { repoPath: "/r", sessionId: "dr-arch-1", state: "promote_error", detail: "TASK-01" },
  });
  expect(toasts.items.some((x) => x.key === "draft-reconcile:dr-arch-1")).toBe(true);
  s.apply({ event: "session:archived", data: { id: "dr-arch-1" } });
  expect(toasts.items.some((x) => x.key === "draft-reconcile:dr-arch-1")).toBe(false);
});

test("draftreconcile:status null with no prior error toast is a no-op", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.apply({
    event: "draftreconcile:status",
    data: { repoPath: "/r", sessionId: "dr-noop-1", state: null, detail: null },
  });
  expect(toasts.items.filter((x) => x.key?.startsWith("draft-reconcile:"))).toHaveLength(0);
});

// ── completed epics ───────────────────────────────────────────────────────────

function completedEpic(repoPath: string, parentIssueNumber: number): CompletedEpic {
  return {
    repoPath,
    parentIssueNumber,
    parentTitle: `Epic #${parentIssueNumber}`,
    completedAt: Date.now(),
    children: [
      {
        number: 1,
        title: "sub-issue",
        url: "https://github.com/x/y/issues/1",
        prNumber: 2,
        prUrl: "https://github.com/x/y/pull/2",
        mergedAt: Date.now(),
        integrated: true,
      },
    ],
    landingPrNumber: null,
    landingPrUrl: null,
    landingState: "pending",
    migrationPaths: [],
    migrationsAckedAt: null,
  };
}

test("epic:completed adds to completedEpics and enqueues a toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  const epic = completedEpic("/r", 42);
  s.apply({ event: "epic:completed", data: epic });
  expect(s.completedEpics).toHaveLength(1);
  expect(s.completedEpics[0].parentIssueNumber).toBe(42);
  expect(toasts.items.some((t) => t.key === "epic-complete:/r#42")).toBe(true);
});

test("epic:completed with landingState=merged enqueues a landed toast (not completion)", () => {
  toasts.items = [];
  const s = new HerdStore();
  const epic = { ...completedEpic("/r", 42), landingState: "merged" as const };
  s.apply({ event: "epic:completed", data: epic });
  expect(toasts.items.some((t) => t.key === "epic-landed:/r#42")).toBe(true);
  expect(toasts.items.some((t) => t.key === "epic-complete:/r#42")).toBe(false);
});

test("epic:completed with same key replaces (no duplicates)", () => {
  const s = new HerdStore();
  const v1 = completedEpic("/r", 42);
  const v2 = { ...completedEpic("/r", 42), parentTitle: "Updated title" };
  s.apply({ event: "epic:completed", data: v1 });
  s.apply({ event: "epic:completed", data: v2 });
  expect(s.completedEpics).toHaveLength(1);
  expect(s.completedEpics[0].parentTitle).toBe("Updated title");
});

test("epic:completed for different repos/parents appends", () => {
  const s = new HerdStore();
  s.apply({ event: "epic:completed", data: completedEpic("/r", 42) });
  s.apply({ event: "epic:completed", data: completedEpic("/r", 99) });
  expect(s.completedEpics).toHaveLength(2);
});

// ── live-epic pruning ─────────────────────────────────────────────────────────
// `epics` would otherwise be append-only while +page's resync() re-fetches every
// key on each wake/socket-reopen — a long-lived tab would GET /api/epic once per
// epic EVER seen, forever. Finished epics must therefore leave the map.

function liveEpic(
  repoPath: string,
  parentIssueNumber: number,
  status: "running" | "idle",
  childStates: EpicChildState[],
): Epic {
  return {
    repoPath,
    parentIssueNumber,
    parentTitle: `Epic #${parentIssueNumber}`,
    source: "native",
    children: childStates.map((state, i) => ({
      number: 100 + i,
      title: `child ${i}`,
      url: `https://github.com/x/y/issues/${100 + i}`,
      order: i,
      body: "",
      blockedBy: [],
      state,
      sessionId: null,
      prNumber: null,
      issueClosed: state === "merged",
      claimed: false,
    })),
    warnings: [],
    run: { repoPath, parentIssueNumber, mode: "auto", status },
  };
}

test("setEpic prunes a finished epic (idle + all children merged) instead of upserting", () => {
  const s = new HerdStore();
  s.setEpic(liveEpic("/r", 42, "running", ["merged", "running"]));
  expect(s.epics["/r#42"]).toBeDefined();
  // The drain's final post-completion emit: idle run, every child merged → key drops.
  s.setEpic(liveEpic("/r", 42, "idle", ["merged", "merged"]));
  expect(s.epics["/r#42"]).toBeUndefined();
});

test("setEpic keeps an idle epic that still has unmerged children (stopped mid-run)", () => {
  const s = new HerdStore();
  s.setEpic(liveEpic("/r", 42, "idle", ["merged", "ready"]));
  expect(s.epics["/r#42"]).toBeDefined();
});

test("epic:completed drops the live epic record", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.setEpic(liveEpic("/r", 42, "running", ["merged", "running"]));
  s.setEpic(liveEpic("/other", 7, "running", ["ready"]));
  s.apply({ event: "epic:completed", data: completedEpic("/r", 42) });
  expect(s.epics["/r#42"]).toBeUndefined();
  expect(s.epics["/other#7"]).toBeDefined(); // untouched
});

test("epic:completed-cleared removes matching entry and leaves others", () => {
  const s = new HerdStore();
  s.apply({ event: "epic:completed", data: completedEpic("/r", 42) });
  s.apply({ event: "epic:completed", data: completedEpic("/r", 99) });
  s.apply({ event: "epic:completed-cleared", data: { repoPath: "/r", parentIssueNumber: 42 } });
  expect(s.completedEpics).toHaveLength(1);
  expect(s.completedEpics[0].parentIssueNumber).toBe(99);
});

test("seedCompletedEpics replaces the array", () => {
  const s = new HerdStore();
  s.apply({ event: "epic:completed", data: completedEpic("/r", 1) });
  const fresh = [completedEpic("/r", 7), completedEpic("/r", 8)];
  s.seedCompletedEpics(fresh);
  expect(s.completedEpics).toHaveLength(2);
  expect(s.completedEpics[0].parentIssueNumber).toBe(7);
});

// ── doc-agent:done ────────────────────────────────────────────────────────────
// Each test uses a unique repoPath to avoid key-dedup collisions on the shared
// toasts singleton (resetting toasts.items doesn't clear its #keyed Map).

test("doc-agent:done sets docAgentDone but fires no toast when docAgentEnabled=false", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = false;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-disabled", url: null, outcome: "nochange" },
  });
  expect(s.docAgentDone?.repoPath).toBe("/repos/da-disabled");
  expect(s.docAgentDone?.outcome).toBe("nochange");
  expect(toasts.items).toHaveLength(0);
});

test("doc-agent:done outcome=pr fires a toast with view-PR action when url present", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-pr-url", url: "https://github.com/x/y/pull/1", outcome: "pr" },
  });
  const t = toasts.items.find((x) => x.key === "doc-agent-done:/repos/da-pr-url");
  expect(t).toBeDefined();
  expect(t?.text).toContain("da-pr-url");
  expect(t?.actionLabel).toBeDefined();
});

test("doc-agent:done outcome=pr with null url fires toast without action", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-pr-nourl", url: null, outcome: "pr" },
  });
  const t = toasts.items.find((x) => x.key === "doc-agent-done:/repos/da-pr-nourl");
  expect(t).toBeDefined();
  expect(t?.actionLabel).toBeUndefined();
});

test("doc-agent:done outcome=pr with a non-http(s) url fires toast without action (CodeQL #3)", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    // A dangerous scheme must never be wired into window.open.
    data: { repoPath: "/repos/da-pr-evil", url: "javascript:alert(1)", outcome: "pr" },
  });
  const t = toasts.items.find((x) => x.key === "doc-agent-done:/repos/da-pr-evil");
  expect(t).toBeDefined();
  expect(t?.actionLabel).toBeUndefined();
});

test("doc-agent:done outcome=observe fires keyed toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-observe", url: null, outcome: "observe" },
  });
  expect(toasts.items.some((x) => x.key === "doc-agent-done:/repos/da-observe")).toBe(true);
});

test("doc-agent:done outcome=nochange fires keyed toast", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-nochange", url: null, outcome: "nochange" },
  });
  expect(toasts.items.some((x) => x.key === "doc-agent-done:/repos/da-nochange")).toBe(true);
});

test("doc-agent:done outcome=error fires a 12s assertive toast keyed doc-agent-error:", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-error", url: null, outcome: "error" },
  });
  const t = toasts.items.find((x) => x.key === "doc-agent-error:/repos/da-error");
  expect(t).toBeDefined();
  expect(t?.alert).toBe(true);
  // dead-end failure → 12s auto-dismiss (durationMs drives the countdown bar)
  expect(t?.durationMs).toBe(12000);
  expect(t?.text).toContain("da-error");
});

test("doc-agent:done dedupes repeated events for the same repo (same key)", () => {
  toasts.items = [];
  const s = new HerdStore();
  s.docAgentEnabled = true;
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-dedup", url: null, outcome: "nochange" },
  });
  s.apply({
    event: "doc-agent:done",
    data: { repoPath: "/repos/da-dedup", url: null, outcome: "nochange" },
  });
  expect(toasts.items.filter((x) => x.key === "doc-agent-done:/repos/da-dedup")).toHaveLength(1);
});

test("setBlocks seeds the block map (incl. authUrl) for bootstrap", () => {
  const s = new HerdStore();
  const reason = {
    shape: "awaiting-input" as const,
    options: [],
    tail: ["paste callback"],
    authUrl: "https://mcp.notion.com/authorize?response_type=code&client_id=abc",
  };
  s.setBlocks({ s1: reason });
  expect(s.blocks.s1?.reason.authUrl).toBe(reason.authUrl);
  expect(s.blocks.s1?.reason.shape).toBe("awaiting-input");
});

test("session:block carries the authUrl through to the block map", () => {
  const s = new HerdStore();
  const reason = {
    shape: "awaiting-input" as const,
    options: [],
    tail: [],
    authUrl: "https://vercel.com/oauth/authorize?response_type=code&client_id=x",
  };
  s.apply({ event: "session:block", data: { id: "s1", block: reason } });
  expect(s.blocks.s1?.reason.authUrl).toBe(reason.authUrl);
  // clearing drops the entry
  s.apply({ event: "session:block", data: { id: "s1", block: null } });
  expect(s.blocks.s1).toBeUndefined();
});

// ── prototype-pollution guards (CodeQL js/remote-property-injection) ────────

test("session:status payload carrying __proto__ cannot set a Session's prototype", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  // A decoded WS payload CAN carry an own `__proto__` key (JSON.parse creates one), and
  // patchSession merges with Object.assign, which uses [[Set]] — so without the guard this
  // reaches the prototype setter. Driven through the WS dispatch seam, not patchSession directly.
  const evil = JSON.parse('{"id":"s1","status":"running","__proto__":{"polluted":"yes"}}');
  s.apply({ event: "session:status", data: evil });

  const target = s.sessions.find((x) => x.id === "s1")!;
  expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(target.status).toBe("running"); // the legitimate part of the patch still applied
});

test("setClaudeAlive drops a hostile stranded id instead of touching the prototype", () => {
  const s = new HerdStore();
  s.setClaudeAlive({ s1: false }, ["__proto__", "constructor", "s1"]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.getPrototypeOf(s.claudeAlive)).toBe(Object.prototype);
  // `__proto__` is rejected outright (underscores fail the charset) — the case that matters,
  // since it is the only one of the three that can reach a prototype setter.
  expect(Object.hasOwn(s.claudeAlive, "__proto__")).toBe(false);
  // `constructor` passes the charset (pure letters) and lands as an ordinary OWN property,
  // shadowing the inherited one on this record. Harmless: the write is a plain assignment of a
  // string, no setter runs, and reads of other keys are unaffected.
  expect(Object.hasOwn(s.claudeAlive, "constructor")).toBe(true);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  // the legitimate id still upgrades to `stranded`
  expect(s.claudeAlive["s1"]).toBe("stranded");
});

test("drain/automerge still round-trip a real repoPath through the path-shaped guard", () => {
  // Regression: the UUID charset used for session-id maps REJECTS a filesystem path, so routing
  // these through it would silently no-op and freeze both maps in the UI with no error.
  const s = new HerdStore();
  const repoPath = "/home/u/Work/my-repo.git";
  s.apply({ event: "drain:status", data: { ...DRAIN, repoPath } });
  s.apply({ event: "automerge:status", data: { ...AUTOMERGE_STATUS, repoPath } });
  expect(s.drain[repoPath]?.inFlight).toBe(1);
  expect(s.autoMerge[repoPath]).toBeDefined();
});

test("queue:update and the bootstrap setBuildQueue are both guarded", () => {
  const s = new HerdStore();
  s.apply({ event: "queue:update", data: { ...QUEUE, sessionId: "__proto__" } });
  s.setBuildQueue({ ...QUEUE, sessionId: "__proto__" });
  expect(Object.hasOwn(s.buildQueues, "__proto__")).toBe(false);
  expect(Object.getPrototypeOf(s.buildQueues)).toBe(Object.prototype);
  // a legitimate id still lands on both paths
  s.setBuildQueue({ ...QUEUE, sessionId: "sess-1" });
  expect(s.buildQueues["sess-1"]).toBeDefined();
});

test("dropKey stays unguarded so deletion never silently fails", () => {
  // Guarding a delete could only break it: a rejected key would leave a stale entry pinned.
  const s = new HerdStore();
  s.apply({ event: "session:git", data: { id: "s1", git: GIT } });
  expect(s.git["s1"]).toBeDefined();
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.git["s1"]).toBeUndefined();
});
