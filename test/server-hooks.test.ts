import { test, expect, afterEach } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { HookIngest } from "../src/hooks-ingest";
import { config } from "../src/config";
import { GoalTracker } from "../src/goal";

const origToken = config.token;
afterEach(() => {
  config.token = origToken;
});

// The route resolves the session by `s.id` (path) and cross-checks the body's
// `session_id` against the session's `claudeSessionId` (two distinct UUIDs).
const CLAUDE_SID = "claude-sid-xyz";

function harness(onSignal?: (id: string) => void) {
  const store = new SessionStore(":memory:");
  const hooks = new HookIngest(onSignal ? (id) => onSignal(id) : undefined);
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    hooks,
  };
  const session = store.create({
    name: "t",
    prompt: "p",
    repoPath: "/wt",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: CLAUDE_SID,
    model: null,
  });
  return { app: makeApp(deps), store, hooks, session };
}

function post(app: ReturnType<typeof makeApp>, id: string, body: unknown, opts: RequestInit = {}) {
  return app.fetch(
    new Request(`http://x/api/sessions/${id}/hooks`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...opts,
    }),
  );
}

const validEvent = {
  session_id: CLAUDE_SID,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_output: { exit_code: 0 },
};

test("POST valid event → 202, recorded, and GET snapshot returns it", async () => {
  const { app, session } = harness();
  const res = await post(app, session.id, validEvent, {
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true });

  const snap = await app.fetch(new Request(`http://x/api/sessions/${session.id}/hooks`));
  expect(snap.status).toBe(200);
  const events = await snap.json();
  expect(events).toHaveLength(1);
  expect(events[0].toolName).toBe("Bash");
  expect(events[0].match).toBe(true);
});

test("POST without application/json content-type still parses → 202 (no 415)", async () => {
  const { app, session } = harness();
  // No content-type header at all — mirrors CC's http-hook client (Finding 1).
  const res = await post(app, session.id, validEvent);
  expect(res.status).toBe(202);
});

test("POST unknown session id → 404", async () => {
  const { app } = harness();
  const res = await post(app, "no-such-id", validEvent, {
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "session not found" });
});

test("POST unparseable body → 400", async () => {
  const { app, session } = harness();
  const res = await post(app, session.id, "{not json", {
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid hook event" });
});

test("POST invalid event (missing session_id) → 400", async () => {
  const { app, session } = harness();
  const res = await post(app, session.id, { hook_event_name: "PostToolUse" });
  expect(res.status).toBe(400);
});

test("POST mismatched session_id → 202 but observe-only (not forwarded to signals)", async () => {
  const seen: string[] = [];
  const { app, session } = harness((id) => seen.push(id));
  const res = await post(app, session.id, { ...validEvent, session_id: "WRONG-SID" });
  expect(res.status).toBe(202);

  // Recorded (visible to the spike) but flagged mismatch + never forwarded.
  const snap = await (
    await app.fetch(new Request(`http://x/api/sessions/${session.id}/hooks`))
  ).json();
  expect(snap).toHaveLength(1);
  expect(snap[0].match).toBe(false);
  expect(seen).toEqual([]);
});

test("POST matched session_id forwards to signals", async () => {
  const seen: string[] = [];
  const { app, session } = harness((id) => seen.push(id));
  await post(app, session.id, validEvent);
  expect(seen).toEqual([session.id]);
});

test("POST SessionEnd (observe-only) → 202 and snapshot records reason field", async () => {
  const { app, session } = harness();
  const res = await post(app, session.id, {
    session_id: CLAUDE_SID,
    hook_event_name: "SessionEnd",
    reason: "logout",
  });
  expect(res.status).toBe(202);

  const snap = await (
    await app.fetch(new Request(`http://x/api/sessions/${session.id}/hooks`))
  ).json();
  expect(snap).toHaveLength(1);
  expect(snap[0].event).toBe("SessionEnd");
  expect(snap[0].reason).toBe("logout");
  expect(snap[0].match).toBe(true);
});

test("POST Stop (observe-only) → 202 and snapshot records stopHookActive field", async () => {
  const { app, session } = harness();
  const res = await post(app, session.id, {
    session_id: CLAUDE_SID,
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  expect(res.status).toBe(202);

  const snap = await (
    await app.fetch(new Request(`http://x/api/sessions/${session.id}/hooks`))
  ).json();
  expect(snap).toHaveLength(1);
  expect(snap[0].event).toBe("Stop");
  expect(snap[0].stopHookActive).toBe(false);
  expect(snap[0].match).toBe(true);
});

test("auth: 401 when token set and Authorization missing/wrong", async () => {
  config.token = "secret-token";
  const { app, session } = harness();
  const missing = await post(app, session.id, validEvent);
  expect(missing.status).toBe(401);

  const wrong = await post(app, session.id, validEvent, {
    headers: { Authorization: "Bearer nope" },
  });
  expect(wrong.status).toBe(401);

  const ok = await post(app, session.id, validEvent, {
    headers: { Authorization: "Bearer secret-token" },
  });
  expect(ok.status).toBe(202);
});

test("POST PreToolUse → 200 with an EMPTY body (no hook decision), still recorded (#3165)", async () => {
  const { app, session } = harness();
  const res = await post(app, session.id, {
    session_id: CLAUDE_SID,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_1",
    tool_input: { questions: [] },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  const snap = await app.fetch(new Request(`http://x/api/sessions/${session.id}/hooks`));
  const events = await snap.json();
  expect(events[0].event).toBe("PreToolUse");
  expect(events[0].toolUseId).toBe("toolu_1");
});

// #2596: the Stop hook pauses a goal while the session plans.
const goalLine = (met: boolean) =>
  JSON.stringify({
    type: "attachment",
    attachment: { type: "goal_status", met, condition: "make it responsive" },
  });

function goalHarness(tail: string | Error, planPhase: "planning" | "executing" | null) {
  const h = harness();
  if (planPhase) h.store.setPlanPhase(h.session.id, planPhase);
  const events = new EventHub();
  const emitted: unknown[] = [];
  events.subscribe((ev, data) => emitted.push([ev, data]));
  const deps: AppDeps = {
    store: h.store,
    service: {} as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
    hooks: h.hooks,
    goals: new GoalTracker({
      store: h.store,
      events,
      transcriptPath: () => "/t.jsonl",
      readTail: async () => {
        if (tail instanceof Error) throw tail;
        return tail;
      },
    }),
  };
  return { ...h, app: makeApp(deps), emitted };
}

const stop = { session_id: CLAUDE_SID, hook_event_name: "Stop", stop_hook_active: false };

test("Stop while planning with an active goal → 200 continue:false", async () => {
  const h = goalHarness(goalLine(false), "planning");
  const res = await post(h.app, h.session.id, stop);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    continue: false,
    stopReason: "Shepherd plan gate: plan awaits review",
  });
  expect(h.store.get(h.session.id)).toMatchObject({
    goalCondition: "make it responsive",
    goalState: "active",
  });
  expect(h.emitted).toContainEqual([
    "session:goal",
    { id: h.session.id, goalCondition: "make it responsive", goalState: "active" },
  ]);
});

test("Stop answers 202 when executing, goal met, unreadable, or session_id mismatched", async () => {
  for (const [tail, phase] of [
    [goalLine(false), "executing"],
    [goalLine(true), "planning"],
    [new Error("ENOENT"), "planning"],
    ["", "planning"],
  ] as const) {
    const h = goalHarness(tail, phase);
    const res = await post(h.app, h.session.id, stop);
    expect(res.status).toBe(202);
  }
  const mismatch = goalHarness(goalLine(false), "planning");
  const res = await post(mismatch.app, mismatch.session.id, { ...stop, session_id: "other" });
  expect(res.status).toBe(202);
  expect(mismatch.store.get(mismatch.session.id)?.goalState).toBeNull();
});
