import { test, expect, vi, afterEach } from "vitest";
import { HerdStore } from "./store.svelte";
import { toasts } from "./toasts.svelte";

vi.mock("./pull-offer", () => ({ offerUpdateMain: vi.fn() }));
import { offerUpdateMain } from "./pull-offer";
import type {
  AutoMergeStatus,
  BacklogPayload,
  BuildQueue,
  CompletedEpic,
  DrainStatus,
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
    issueNumber: null,
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
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

test("setClaudeAlive seeds the liveness map for bootstrap", () => {
  const s = new HerdStore();
  s.setClaudeAlive({ s1: true, s2: false });
  expect(s.claudeAlive["s1"]).toBe(true);
  expect(s.claudeAlive["s2"]).toBe(false);
});

test("session:claude-alive sets and flips the liveness for that session", () => {
  const s = new HerdStore();
  s.apply({ event: "session:claude-alive", data: { id: "s1", claudeAlive: true } });
  expect(s.claudeAlive["s1"]).toBe(true);
  s.apply({ event: "session:claude-alive", data: { id: "s1", claudeAlive: false } });
  expect(s.claudeAlive["s1"]).toBe(false);
});

test("session:archived drops the claude-alive entry for that session", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.apply({ event: "session:claude-alive", data: { id: "s1", claudeAlive: true } });
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

test("mergetrain:landed calls offerUpdateMain with the repoPath", () => {
  vi.mocked(offerUpdateMain).mockClear();
  const s = new HerdStore();
  s.apply({ event: "mergetrain:landed", data: { repoPath: "/repos/my-project" } });
  expect(offerUpdateMain).toHaveBeenCalledOnce();
  expect(offerUpdateMain).toHaveBeenCalledWith("/repos/my-project");
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
