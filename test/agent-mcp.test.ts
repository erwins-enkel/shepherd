/**
 * The agent control plane as an MCP tool surface (issue #2003): protocol handling, the
 * session-gated tool catalog, and the appliers the REST routes now share.
 */
import { test, expect } from "bun:test";
import {
  agentMcpConfigArg,
  agentTools,
  applyEpicDraft,
  applyQueueStep,
  applyQueueWrite,
  handleMcpRequest,
  hasAgentTools,
  sessionCapabilities,
  MCP_PROTOCOL_VERSION,
  type AgentControlDeps,
} from "../src/agent-control";
import { SessionStore } from "../src/store";

function harness(opts: { buildQueue?: boolean; epicAuthoring?: boolean } = {}): {
  deps: AgentControlDeps;
  store: SessionStore;
  sessionId: string;
  emitted: { event: string; data: unknown }[];
} {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  if (opts.buildQueue) {
    store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), buildQueueEnabled: true });
  }
  const session = store.create({
    name: "test-session",
    prompt: "do something",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/test-session",
    worktreePath: "/repo",
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: "claude-x",
    model: null,
    epicAuthoring: opts.epicAuthoring,
  });
  return {
    deps: { store, events: { emit: (event, data) => emitted.push({ event, data }) } },
    store,
    sessionId: session.id,
    emitted,
  };
}

function call(
  deps: AgentControlDeps,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return handleMcpRequest(deps, sessionId, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

/** The parsed payload of a tool result, plus whether it was flagged as an error. */
function toolPayload(outcome: ReturnType<typeof handleMcpRequest>): {
  isError: boolean;
  payload: any;
} {
  const body = outcome.body as { result?: { content: { text: string }[]; isError?: boolean } };
  const res = body.result!;
  return { isError: res.isError === true, payload: JSON.parse(res.content[0]!.text) };
}

// ── tool catalog ─────────────────────────────────────────────────────────────

test("no build queue and no epic authoring → no tools, so no MCP config is warranted", () => {
  const { deps, sessionId } = harness();
  expect(agentTools(deps, sessionId)).toEqual([]);
  expect(hasAgentTools(sessionCapabilities(deps, sessionId))).toBe(false);
});

test("buildQueueEnabled exposes exactly the two queue tools", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  expect(agentTools(deps, sessionId).map((t) => t.name)).toEqual(["queue_write", "queue_step"]);
  expect(hasAgentTools(sessionCapabilities(deps, sessionId))).toBe(true);
});

test("an epic-authoring session gets epic_draft, and only it when the queue is off", () => {
  const { deps, sessionId } = harness({ epicAuthoring: true });
  expect(agentTools(deps, sessionId).map((t) => t.name)).toEqual(["epic_draft"]);
});

test("queue_step's status parameter enumerates the whole vocabulary — the semantic the prose used to carry", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const step = agentTools(deps, sessionId).find((t) => t.name === "queue_step")!;
  const props = step.inputSchema.properties as { status: { enum: string[] } };
  expect(props.status.enum).toEqual(["pending", "active", "done", "skipped"]);
  expect(step.inputSchema.required).toEqual(["stepId", "status"]);
});

test("queue_write requires a caller-owned step id, making id stability structural", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const write = agentTools(deps, sessionId).find((t) => t.name === "queue_write")!;
  const steps = (write.inputSchema.properties as { steps: { items: { required: string[] } } })
    .steps;
  expect(steps.items.required).toContain("id");
});

test("an unknown session gets no tools", () => {
  const { deps } = harness({ buildQueue: true });
  expect(agentTools(deps, "no-such-session")).toEqual([]);
  expect(sessionCapabilities(deps, "no-such-session")).toEqual({
    buildQueue: false,
    epicDraft: false,
  });
});

// ── protocol ─────────────────────────────────────────────────────────────────

test("initialize echoes a known protocol version and advertises tools", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const out = handleMcpRequest(deps, sessionId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  expect(out.status).toBe(200);
  const body = out.body as { result: { protocolVersion: string; capabilities: unknown } };
  expect(body.result.protocolVersion).toBe("2025-03-26");
  expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
});

test("initialize with an unknown protocol version answers with ours", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const out = handleMcpRequest(deps, sessionId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  const body = out.body as { result: { protocolVersion: string } };
  expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
});

test("a notification (no id) gets a bodyless 202", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const out = handleMcpRequest(deps, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  expect(out).toEqual({ status: 202, body: null });
});

test("tools/list reports the session's catalog", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const out = handleMcpRequest(deps, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const body = out.body as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((t) => t.name)).toEqual(["queue_write", "queue_step"]);
});

test("an unknown method is a JSON-RPC -32601, not a crash", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const out = handleMcpRequest(deps, sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  });
  const body = out.body as { error: { code: number } };
  expect(body.error.code).toBe(-32601);
});

test("a non-object request is a JSON-RPC -32600", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const body = handleMcpRequest(deps, sessionId, "nope").body as { error: { code: number } };
  expect(body.error.code).toBe(-32600);
});

test("calling a tool the session doesn't have is -32602, even when the tool exists elsewhere", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  const out = call(deps, sessionId, "epic_draft", {
    parent: { title: "x", body: "y" },
    children: [],
  });
  const body = out.body as { error: { code: number; message: string } };
  expect(body.error.code).toBe(-32602);
  expect(body.error.message).toContain("epic_draft");
  // …and nothing was written.
  expect(deps.store.getEpicDraft(sessionId)).toBeNull();
});

// ── tool calls ───────────────────────────────────────────────────────────────

test("queue_write authors the queue and emits queue:update", () => {
  const { deps, sessionId, emitted } = harness({ buildQueue: true });
  const out = call(deps, sessionId, "queue_write", {
    steps: [
      { id: "s1", title: "First" },
      { id: "s2", title: "Second", detail: "with detail" },
    ],
  });
  const { isError, payload } = toolPayload(out);
  expect(isError).toBe(false);
  expect(payload.steps.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
  expect(emitted.filter((e) => e.event === "queue:update")).toHaveLength(1);
});

test("queue_step advances a step, forward-fills earlier ones, and emits", () => {
  const { deps, sessionId, emitted } = harness({ buildQueue: true });
  call(deps, sessionId, "queue_write", {
    steps: [
      { id: "s1", title: "First" },
      { id: "s2", title: "Second" },
    ],
  });
  const { isError, payload } = toolPayload(
    call(deps, sessionId, "queue_step", { stepId: "s2", status: "active" }),
  );
  expect(isError).toBe(false);
  const byId = Object.fromEntries(
    payload.steps.map((s: { id: string; status: string }) => [s.id, s.status]),
  );
  expect(byId).toEqual({ s1: "done", s2: "active" });
  expect(emitted.filter((e) => e.event === "queue:update")).toHaveLength(2);
});

test("queue_step on an unknown step is an isError result the model can correct, not a protocol error", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  call(deps, sessionId, "queue_write", { steps: [{ id: "s1", title: "First" }] });
  const { isError, payload } = toolPayload(
    call(deps, sessionId, "queue_step", { stepId: "nope", status: "done" }),
  );
  expect(isError).toBe(true);
  expect(payload.error).toContain("not found");
});

test("queue_write with an invalid step is an isError result and leaves the queue alone", () => {
  const { deps, sessionId } = harness({ buildQueue: true });
  call(deps, sessionId, "queue_write", { steps: [{ id: "s1", title: "First" }] });
  const { isError } = toolPayload(call(deps, sessionId, "queue_write", { steps: [{ id: "s2" }] }));
  expect(isError).toBe(true);
  expect(deps.store.getBuildQueue(sessionId).steps.map((s) => s.id)).toEqual(["s1"]);
});

test("epic_draft stores the draft and emits session:epic-draft", () => {
  const { deps, sessionId, emitted } = harness({ epicAuthoring: true });
  const { isError, payload } = toolPayload(
    call(deps, sessionId, "epic_draft", {
      parent: { title: "Epic", body: "Why" },
      children: [
        { key: "c1", title: "Slice 1" },
        { key: "c2", title: "Slice 2", blockedBy: ["c1"] },
      ],
    }),
  );
  expect(isError).toBe(false);
  expect(payload.children.map((c: { key: string }) => c.key)).toEqual(["c1", "c2"]);
  expect(emitted.filter((e) => e.event === "session:epic-draft")).toHaveLength(1);
});

test("epic_draft rejects a dependency cycle as an isError result", () => {
  const { deps, sessionId } = harness({ epicAuthoring: true });
  const { isError, payload } = toolPayload(
    call(deps, sessionId, "epic_draft", {
      parent: { title: "Epic", body: "Why" },
      children: [
        { key: "c1", title: "One", blockedBy: ["c2"] },
        { key: "c2", title: "Two", blockedBy: ["c1"] },
      ],
    }),
  );
  expect(isError).toBe(true);
  expect(String(payload.error)).toMatch(/cycle/i);
});

// ── appliers (the seam the REST routes share) ────────────────────────────────

test("applyQueueStep reports an ambiguous prefix as 409 with the matches", () => {
  const { deps, sessionId, store } = harness({ buildQueue: true });
  store.replaceBuildQueue(sessionId, [
    { id: "abcdefgh-one", title: "A" },
    { id: "abcdefgh-two", title: "B" },
  ]);
  const res = applyQueueStep(deps, sessionId, "abcdefgh", { status: "done" });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(409);
    expect(res.matches).toEqual(["abcdefgh-one", "abcdefgh-two"]);
  }
});

test("applyQueueWrite / applyEpicDraft surface validation failures as 400", () => {
  const { deps, sessionId } = harness({ buildQueue: true, epicAuthoring: true });
  const bad = applyQueueWrite(deps, sessionId, { steps: "nope" });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.status).toBe(400);
  const badDraft = applyEpicDraft(deps, sessionId, { parent: { title: "x" } });
  expect(badDraft.ok).toBe(false);
  if (!badDraft.ok) expect(badDraft.status).toBe(400);
});

test("applyEpicDraft refuses to edit a draft that has left draft status", () => {
  const { deps, sessionId, store } = harness({ epicAuthoring: true });
  store.replaceEpicDraft(sessionId, {
    parent: { title: "E", body: "b", acceptanceCriteria: [], nonGoals: [] },
    children: [],
  });
  store.setEpicDraftApproved(sessionId, 42, "https://example.test/42");
  const res = applyEpicDraft(deps, sessionId, { parent: { title: "E2", body: "b" }, children: [] });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(409);
});

// ── spawn wiring ─────────────────────────────────────────────────────────────

test("agentMcpConfigArg points at the session's own endpoint over the resolved ingress base", () => {
  const cfg = JSON.parse(agentMcpConfigArg("sess-1", "http://127.0.0.1:7331"));
  expect(cfg).toEqual({
    mcpServers: {
      shepherd: { type: "http", url: "http://127.0.0.1:7331/api/sessions/sess-1/mcp" },
    },
  });
});

test("agentMcpConfigArg carries no credential — the ingress listener is the auth boundary", () => {
  expect(agentMcpConfigArg("sess-1", "http://10.0.2.2:7331")).not.toMatch(/authorization|bearer/i);
});
