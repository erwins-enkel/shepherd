import { test, expect, vi, afterEach } from "vitest";
import { HerdStore } from "./store.svelte";
import { toasts } from "./toasts.svelte";
import type { BacklogPayload, GitState, Session } from "./types";

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
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

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
