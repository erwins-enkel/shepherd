import { test, expect } from "bun:test";
import {
  validateHookEvent,
  HookIngest,
  type HookEvent,
  type SubagentEntry,
} from "../src/hooks-ingest";

// ── validateHookEvent (pure, untrusted body) ──────────────────────────────────

test("validateHookEvent: PostToolUse with exit 0 → status ok", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_output: { stdout: "hi", stderr: "", exit_code: 0 },
  });
  expect(ev).toEqual({
    event: "PostToolUse",
    sessionId: "s1",
    toolName: "Bash",
    status: "ok",
    exitCode: 0,
  });
});

test("validateHookEvent: exit_code !== 0 → status error", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_output: { exit_code: 2 },
  });
  expect(ev?.status).toBe("error");
  expect(ev?.exitCode).toBe(2);
});

test("validateHookEvent: PostToolUseFailure → status error regardless of code", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Edit",
  });
  expect(ev).toEqual({
    event: "PostToolUseFailure",
    sessionId: "s1",
    toolName: "Edit",
    status: "error",
    exitCode: undefined,
  });
});

test("validateHookEvent: reads tool_response as a defensive fallback for tool_output", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_response: { exit_code: 1 },
  });
  expect(ev?.status).toBe("error");
});

test("validateHookEvent: Notification with type", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "Notification",
    notification_type: "idle_prompt",
    message: "waiting",
  });
  expect(ev).toEqual({
    event: "Notification",
    sessionId: "s1",
    notificationType: "idle_prompt",
    message: "waiting",
    unknown: false,
  });
});

test("validateHookEvent: missing session_id → null", () => {
  expect(validateHookEvent({ hook_event_name: "PostToolUse" })).toBeNull();
  expect(validateHookEvent({ session_id: 42, hook_event_name: "PostToolUse" })).toBeNull();
});

test("validateHookEvent: non-object → null", () => {
  expect(validateHookEvent(null)).toBeNull();
  expect(validateHookEvent("nope")).toBeNull();
  expect(validateHookEvent(123)).toBeNull();
});

test("validateHookEvent: unknown hook_event_name → accepted with unknown:true (not dropped)", () => {
  const ev = validateHookEvent({ session_id: "s1", hook_event_name: "TotallyNovelEvent" });
  expect(ev).toEqual({ event: "TotallyNovelEvent", sessionId: "s1", unknown: true });
});

test("validateHookEvent: Notification with unknown/absent type → flagged unknown, not dropped", () => {
  const ev = validateHookEvent({ session_id: "s1", hook_event_name: "Notification" });
  expect(ev?.event).toBe("Notification");
  expect(ev?.unknown).toBe(true);
});

test("validateHookEvent: SessionStart with source → recognized, not unknown", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "SessionStart",
    source: "startup",
  });
  expect(ev).toEqual({ event: "SessionStart", sessionId: "s1", source: "startup" });
  expect(ev?.unknown).toBeUndefined();
});

test("validateHookEvent: SessionStart without source → source undefined, not unknown", () => {
  const ev = validateHookEvent({ session_id: "s1", hook_event_name: "SessionStart" });
  expect(ev).toEqual({ event: "SessionStart", sessionId: "s1", source: undefined });
  expect(ev?.unknown).toBeUndefined();
});

test("validateHookEvent: Stop with stop_hook_active:false → recognized, stopHookActive false", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  expect(ev).toEqual({ event: "Stop", sessionId: "s1", stopHookActive: false });
  expect(ev?.unknown).toBeUndefined();
});

test("validateHookEvent: SessionEnd with reason → recognized, not unknown", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "SessionEnd",
    reason: "logout",
  });
  expect(ev).toEqual({ event: "SessionEnd", sessionId: "s1", reason: "logout" });
  expect(ev?.unknown).toBeUndefined();
});

test("validateHookEvent: SubagentStart → recognized, normalizes agent_id/agent_type", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "SubagentStart",
    agent_id: "a1",
    agent_type: "general-purpose",
  });
  expect(ev).toEqual({
    event: "SubagentStart",
    sessionId: "s1",
    agentId: "a1",
    agentType: "general-purpose",
  });
  expect(ev?.unknown).toBeUndefined();
});

test("validateHookEvent: SubagentStop → recognized, normalizes agent_id/agent_type", () => {
  const ev = validateHookEvent({
    session_id: "s1",
    hook_event_name: "SubagentStop",
    agent_id: "a1",
    agent_type: "Explore",
  });
  expect(ev).toEqual({
    event: "SubagentStop",
    sessionId: "s1",
    agentId: "a1",
    agentType: "Explore",
  });
  expect(ev?.unknown).toBeUndefined();
});

// ── HookIngest ring buffer ─────────────────────────────────────────────────────

function ev(over: Partial<HookEvent> = {}): HookEvent {
  return { event: "PostToolUse", sessionId: "s1", receivedAt: Date.now(), ...over };
}

test("HookIngest: record + snapshot round-trips", () => {
  const h = new HookIngest();
  h.record("s1", ev({ toolName: "Bash" }));
  const snap = h.snapshot("s1");
  expect(snap).toHaveLength(1);
  expect(snap[0]?.toolName).toBe("Bash");
});

test("HookIngest: snapshot returns a copy (mutation does not leak back)", () => {
  const h = new HookIngest();
  h.record("s1", ev());
  const snap = h.snapshot("s1");
  snap.push(ev());
  expect(h.snapshot("s1")).toHaveLength(1);
});

test("HookIngest: snapshot of unknown session → []", () => {
  expect(new HookIngest().snapshot("nope")).toEqual([]);
});

test("HookIngest: ring buffer caps at 50, evicting oldest", () => {
  const h = new HookIngest();
  for (let i = 0; i < 60; i++) h.record("s1", ev({ exitCode: i }));
  const snap = h.snapshot("s1");
  expect(snap).toHaveLength(50);
  expect(snap[0]?.exitCode).toBe(10); // first 10 evicted
  expect(snap[49]?.exitCode).toBe(59);
});

test("HookIngest: prune drops inactive sessions", () => {
  const h = new HookIngest();
  h.record("s1", ev());
  h.record("s2", ev({ sessionId: "s2" }));
  h.prune(new Set(["s1"]));
  expect(h.snapshot("s1")).toHaveLength(1);
  expect(h.snapshot("s2")).toEqual([]);
});

test("HookIngest: onSignal called on matched event, skipped on mismatch", () => {
  const seen: string[] = [];
  const h = new HookIngest((id) => seen.push(id));
  h.record("s1", ev({ match: true }));
  h.record("s1", ev({ match: false }));
  h.record("s1", ev()); // match undefined ⇒ treated as ok
  expect(seen).toEqual(["s1", "s1"]);
});

test("HookIngest: record never throws even if onSignal does", () => {
  const h = new HookIngest(() => {
    throw new Error("boom");
  });
  expect(() => h.record("s1", ev({ match: true }))).not.toThrow();
  // The event is still buffered despite the forward fault.
  expect(h.snapshot("s1")).toHaveLength(1);
});

// ── HookIngest sub-agent roster (Phase 3, #710) ─────────────────────────────────

function sub(over: Partial<HookEvent> = {}): HookEvent {
  return {
    event: "SubagentStart",
    sessionId: "s1",
    agentId: "a1",
    agentType: "general-purpose",
    receivedAt: Date.now(),
    ...over,
  };
}

test("HookIngest roster: SubagentStart makes a live entry (endedAt undefined)", () => {
  const h = new HookIngest();
  h.record("s1", sub({ receivedAt: 100 }));
  const roster = h.subagentSnapshot("s1");
  expect(roster).toHaveLength(1);
  expect(roster[0]).toEqual({ agentId: "a1", agentType: "general-purpose", startedAt: 100 });
  expect(roster[0]?.endedAt).toBeUndefined();
});

test("HookIngest roster: matching SubagentStop sets endedAt, keeps startedAt", () => {
  const h = new HookIngest();
  h.record("s1", sub({ receivedAt: 100 }));
  h.record("s1", sub({ event: "SubagentStop", receivedAt: 250 }));
  const roster = h.subagentSnapshot("s1");
  expect(roster).toHaveLength(1);
  expect(roster[0]?.startedAt).toBe(100);
  expect(roster[0]?.endedAt).toBe(250);
});

test("HookIngest roster: SubagentStop with no prior Start → fail-open done entry", () => {
  const h = new HookIngest();
  h.record("s1", sub({ event: "SubagentStop", receivedAt: 300 }));
  const roster = h.subagentSnapshot("s1");
  expect(roster).toHaveLength(1);
  expect(roster[0]).toEqual({
    agentId: "a1",
    agentType: "general-purpose",
    startedAt: 300,
    endedAt: 300,
  });
});

test("HookIngest roster: duplicate SubagentStart is idempotent (keeps original startedAt)", () => {
  const h = new HookIngest();
  h.record("s1", sub({ receivedAt: 100 }));
  h.record("s1", sub({ receivedAt: 999 }));
  const roster = h.subagentSnapshot("s1");
  expect(roster).toHaveLength(1);
  expect(roster[0]?.startedAt).toBe(100);
});

test("HookIngest roster: match:false event does NOT mutate the roster (fail-closed)", () => {
  const h = new HookIngest();
  h.record("s1", sub({ match: false }));
  expect(h.subagentSnapshot("s1")).toEqual([]);
});

test("HookIngest roster: setSubagentSink fires on a roster change with the updated array", () => {
  const seen: Array<{ id: string; roster: SubagentEntry[] }> = [];
  const h = new HookIngest();
  h.setSubagentSink((id, roster) => seen.push({ id, roster }));
  h.record("s1", sub({ receivedAt: 100 }));
  expect(seen).toHaveLength(1);
  expect(seen[0]?.id).toBe("s1");
  expect(seen[0]?.roster).toEqual([
    { agentId: "a1", agentType: "general-purpose", startedAt: 100 },
  ]);
});

test("HookIngest roster: prune drops roster entries for inactive sessions", () => {
  const h = new HookIngest();
  h.record("s1", sub());
  h.record("s2", sub({ sessionId: "s2" }));
  h.prune(new Set(["s1"]));
  expect(h.subagentSnapshot("s1")).toHaveLength(1);
  expect(h.subagentSnapshot("s2")).toEqual([]);
});

test("HookIngest roster: allSubagentsSnapshot returns every session's roster array", () => {
  const h = new HookIngest();
  h.record("s1", sub({ receivedAt: 100 }));
  h.record("s2", sub({ sessionId: "s2", agentId: "b1", agentType: "Explore", receivedAt: 200 }));
  expect(h.allSubagentsSnapshot()).toEqual({
    s1: [{ agentId: "a1", agentType: "general-purpose", startedAt: 100 }],
    s2: [{ agentId: "b1", agentType: "Explore", startedAt: 200 }],
  });
});

test("HookIngest roster: empty agentId is a no-op", () => {
  const h = new HookIngest();
  h.record("s1", sub({ agentId: undefined }));
  expect(h.subagentSnapshot("s1")).toEqual([]);
});
