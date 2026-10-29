/**
 * The Operator Assistant's action tools (Settings → Assistant), driven with a fake in-process
 * dispatch and a real in-memory store: the request each tool builds, the `off` gate, target
 * resolution, and the bounded answers.
 */
import { expect, test } from "bun:test";
import {
  applyOperatorAction,
  OPERATOR_ACTION_TOOLS,
  type OperatorActionRequest,
} from "../src/operator-assistant-actions";
import {
  ASSISTANT_ACTION_GROUPS,
  DEFAULT_ASSISTANT_PERMISSIONS,
  type AssistantActionTool,
  type AssistantPermissions,
} from "../src/operator-assistant-permissions";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { ACTION_REQUEST_EVENT, ActionRequestService } from "../src/action-request";
import type { AgentControlDeps } from "../src/agent-control";
import type { GitState } from "../src/forge/types";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function addSession(
  store: SessionStore,
  name: string,
  opts: { terminal?: boolean; operatorAssistant?: boolean; repoPath?: string } = {},
) {
  return store.create({
    name,
    prompt: "p",
    repoPath: "/r/alpha",
    baseBranch: "main",
    branch: `shepherd/${name}`,
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "sess",
    herdrAgentId: `agent-${name}`,
    claudeSessionId: `claude-${name}`,
    model: null,
    ...opts,
  });
}

const ASSISTANT_ID = "assistant-session";
const HEAD = "a".repeat(40);
const OPEN_PR = { state: "open", number: 12, headSha: HEAD, baseRefName: "main" } as GitState;

function setup(
  opts: {
    permissions?: Partial<AssistantPermissions>;
    answer?: (req: OperatorActionRequest) => { status: number; body: unknown };
    /** The approval seam for `ask` groups; default: every call is already approved. */
    actionRequests?: AgentControlDeps["actionRequests"];
    /** Every session's cached PR state; default an open PR at HEAD onto main. */
    pr?: GitState | null;
  } = {},
) {
  const store = new SessionStore(":memory:");
  const requests: OperatorActionRequest[] = [];
  const logs: string[] = [];
  const permissions = { ...DEFAULT_ASSISTANT_PERMISSIONS, ...opts.permissions };
  const cache = { pr: opts.pr === undefined ? OPEN_PR : opts.pr };
  const deps = {
    store,
    prCache: { get: () => cache.pr ?? undefined },
    actionRequests: opts.actionRequests ?? {
      request: () => ({ status: "approved" as const }),
      wait: async () => "approved" as const,
    },
    actionWaitMs: 20,
    operatorDiag: {
      repos: () => ["/r/alpha", "/r/beta"],
      logPaths: {} as never,
      herdrSocketPath: "/nonexistent",
    },
    operatorActions: {
      permissions: () => permissions,
      taskDefaults: (repoPath: string) => ({
        baseBranch: repoPath === "/r/beta" ? "trunk" : "main",
        agentProvider: "claude" as const,
        model: "opus",
        effort: null,
      }),
      dispatch: async (req: OperatorActionRequest) => {
        requests.push(req);
        return opts.answer?.(req) ?? { status: 200, body: { ok: true } };
      },
      log: (line: string) => logs.push(line),
    },
  };
  const worker = addSession(store, "worker");
  const run = (tool: AssistantActionTool, args: Record<string, unknown>) =>
    applyOperatorAction(deps, tool, args, { sessionId: ASSISTANT_ID, scope: null });
  /** `run` as a repo-scoped assistant of `scope`. */
  const runScoped = (scope: string, tool: AssistantActionTool, args: Record<string, unknown>) =>
    applyOperatorAction(deps, tool, args, { sessionId: ASSISTANT_ID, scope });
  return { store, deps, requests, logs, worker, run, runScoped, cache };
}

test("the catalog is exactly the action groups' tools, in group order", () => {
  expect(OPERATOR_ACTION_TOOLS.map((t) => t.name)).toEqual(
    Object.values(ASSISTANT_ACTION_GROUPS).flat(),
  );
});

test("each session tool runs its operator route on the resolved session", async () => {
  const cases: [
    AssistantActionTool,
    Record<string, unknown>,
    Omit<OperatorActionRequest, "path">,
    string,
  ][] = [
    ["session_steer", { text: "go on" }, { method: "POST", body: { text: "go on" } }, "reply"],
    [
      "plan_answer",
      { answers: [{ blockId: "b", questionId: "q", optionIndices: [1] }] },
      {
        method: "POST",
        body: { answers: [{ blockId: "b", questionId: "q", optionIndices: [1] }] },
      },
      "answer-plan-questions",
    ],
    ["session_interrupt", {}, { method: "POST" }, "interrupt"],
    ["session_resume", {}, { method: "POST", body: {} }, "resume"],
    ["session_relaunch", {}, { method: "POST" }, "relaunch"],
    ["session_archive", {}, { method: "DELETE" }, ""],
    ["plan_release", {}, { method: "POST" }, "go"],
    ["queue_approve", {}, { method: "POST" }, "queue/approve"],
    ["pr_ready", {}, { method: "POST" }, "git/ready"],
    [
      "pr_merge",
      {},
      { method: "POST", body: { confirm: { headSha: HEAD, baseRefName: "main" } } },
      "git/merge",
    ],
  ];
  for (const [tool, args, expected, sub] of cases) {
    const { worker, requests, run } = setup();
    const res = await run(tool, { desig: worker.desig, ...args });
    expect(res.ok).toBe(true);
    const path = `/api/sessions/${worker.id}${sub ? `/${sub}` : ""}`;
    expect(requests).toEqual([{ ...expected, path }]);
  }
});

test("session_start creates a session in the resolved repo with New Task's defaults", async () => {
  const { requests, run } = setup({
    answer: () => ({
      status: 201,
      body: { id: crypto.randomUUID(), desig: "TASK-42", prompt: "fix the footer" },
    }),
  });
  const res = await run("session_start", { repo: "beta", prompt: "fix the footer" });
  expect(res).toEqual({
    ok: true,
    data: {
      ok: true,
      action: "session_start",
      target: "beta",
      baseBranch: "trunk",
      desig: "TASK-42",
    },
  });
  expect(requests).toEqual([
    {
      method: "POST",
      path: "/api/sessions",
      body: {
        repoPath: "/r/beta",
        baseBranch: "trunk",
        prompt: "fix the footer",
        agentProvider: "claude",
        model: "opus",
        effort: null,
      },
    },
  ]);
  expect(JSON.stringify(res)).not.toMatch(UUID_RE);

  // An explicit base branch wins over the repo default.
  await run("session_start", { repo: "/r/alpha", prompt: "x", baseBranch: "epic/7-y" });
  expect(requests[1]!.body).toMatchObject({ repoPath: "/r/alpha", baseBranch: "epic/7-y" });
});

test("session_start answers the held task's id when the usage hold queued it", async () => {
  const { run } = setup({
    answer: () => ({ status: 200, body: { held: true, id: "held-9", count: 2 } }),
  });
  const res = await run("session_start", { repo: "alpha", prompt: "later" });
  expect(res.ok && res.data).toEqual({
    ok: true,
    action: "session_start",
    target: "alpha",
    baseBranch: "main",
    held: true,
    heldId: "held-9",
  });
});

test("session_start refuses a missing prompt or repo and a blank base branch before dispatching", async () => {
  const { requests, run } = setup();
  for (const args of [
    { repo: "alpha" },
    { repo: "alpha", prompt: "  " },
    { prompt: "x" },
    { repo: "gamma", prompt: "x" },
    { repo: "alpha", prompt: "x", baseBranch: "" },
    { repo: "alpha", prompt: "x", baseBranch: 3 },
  ]) {
    expect((await run("session_start", args)).ok).toBe(false);
  }
  expect(requests).toEqual([]);
});

test("session_start is its own group: off refuses it, other groups off leave it running", async () => {
  const off = setup({ permissions: { start: "off" } });
  const res = await off.run("session_start", { repo: "alpha", prompt: "x" });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("start actions are turned off");
  expect(off.requests).toEqual([]);

  const on = setup({
    permissions: { steer: "off", sessions: "off", approve: "off", automation: "off" },
  });
  expect((await on.run("session_start", { repo: "alpha", prompt: "x" })).ok).toBe(true);
});

test("pr_merge never sends a takeover confirmation, and hands the refusal back with its code", async () => {
  const { worker, requests, run } = setup({
    answer: () => ({
      status: 409,
      body: {
        error: "this merge is someone else's responsibility",
        code: "merge_confirm_required",
      },
    }),
  });
  const res = await run("pr_merge", {
    desig: worker.desig,
    confirm: { headSha: "abc", handoff: "merger", handoffWho: "x" },
  });
  // Only the revision it captured — never a takeover, never the agent's own confirm.
  expect(requests[0]!.body).toEqual({ confirm: { headSha: HEAD, baseRefName: "main" } });
  expect(res).toEqual({
    ok: false,
    status: 409,
    error: "merge_confirm_required: this merge is someone else's responsibility",
  });
});

test("a group set to off is refused before anything is dispatched", async () => {
  const { worker, requests, logs, run } = setup({ permissions: { approve: "off" } });
  const res = await run("pr_merge", { desig: worker.desig });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(403);
    expect(res.error).toContain("turned off in Settings → Assistant");
  }
  expect(requests).toEqual([]);
  expect(logs).toEqual([]);
  // Another group is unaffected.
  expect((await run("session_interrupt", { desig: worker.desig })).ok).toBe(true);
});

test("only herd sessions are targets: unknown, archived, terminal and the assistant itself are 404", async () => {
  const { store, requests, run } = setup();
  const archived = addSession(store, "gone");
  store.archive(archived.id);
  const terminal = addSession(store, "shell", { terminal: true });
  const assistant = addSession(store, "assistant", { operatorAssistant: true });
  for (const desig of ["TASK-999", archived.desig, terminal.desig, assistant.desig, 7, undefined]) {
    const res = await run("session_interrupt", { desig });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  }
  expect(requests).toEqual([]);
});

test("repo_automation_set: a unique basename resolves, only the automation fields pass", async () => {
  const { requests, run } = setup();
  const res = await run("repo_automation_set", {
    repo: "alpha",
    autoDrainEnabled: true,
    maxAuto: 2,
  });
  expect(res).toEqual({
    ok: true,
    data: {
      ok: true,
      action: "repo_automation_set",
      target: "alpha",
      set: { autoDrainEnabled: true, maxAuto: 2 },
    },
  });
  expect(requests).toEqual([
    {
      method: "PUT",
      path: "/api/repo-config?repo=%2Fr%2Falpha",
      body: { autoDrainEnabled: true, maxAuto: 2 },
    },
  ]);

  for (const bad of [
    { repo: "alpha", sandboxProfile: "trusted" },
    { repo: "alpha", sharedBrowserEnabled: true },
    { repo: "alpha" },
    { repo: "gamma", autoDrainEnabled: true },
  ]) {
    expect((await run("repo_automation_set", bad)).ok).toBe(false);
  }
  expect(requests).toHaveLength(1);
});

test("session_automation_set runs one route per toggle given", async () => {
  const { worker, requests, run } = setup();
  const res = await run("session_automation_set", {
    desig: worker.desig,
    autopilot: true,
    autoMerge: null,
  });
  expect(res.ok).toBe(true);
  expect(requests).toEqual([
    { method: "PUT", path: `/api/sessions/${worker.id}/autopilot`, body: { enabled: true } },
    { method: "PUT", path: `/api/sessions/${worker.id}/automerge`, body: { enabled: null } },
  ]);
  expect((await run("session_automation_set", { desig: worker.desig })).ok).toBe(false);
  expect((await run("session_automation_set", { desig: worker.desig, autopilot: "on" })).ok).toBe(
    false,
  );
});

test("epic_run_set pauses or resumes one epic, nothing else", async () => {
  const { requests, run } = setup();
  expect((await run("epic_run_set", { repo: "beta", epicParent: 12, status: "paused" })).ok).toBe(
    true,
  );
  expect(requests).toEqual([
    { method: "PUT", path: "/api/epic?repo=%2Fr%2Fbeta&parent=12", body: { status: "paused" } },
  ]);
  for (const bad of [
    { repo: "beta", epicParent: 0, status: "paused" },
    { repo: "beta", epicParent: 12, status: "idle" },
  ]) {
    expect((await run("epic_run_set", bad)).ok).toBe(false);
  }
});

test("held_task spawns or discards a held task that exists", async () => {
  const { store, requests, run } = setup();
  store.addHeldTask({
    id: "held-1",
    repoPath: "/r/alpha",
    input: { prompt: "later" } as never,
    createdAt: 1,
    reason: "capacity",
  });
  expect((await run("held_task", { heldId: "held-1", action: "spawn" })).ok).toBe(true);
  expect((await run("held_task", { heldId: "held-1", action: "discard" })).ok).toBe(true);
  expect(requests).toEqual([
    { method: "POST", path: "/api/held/held-1/spawn" },
    { method: "DELETE", path: "/api/held/held-1" },
  ]);
  expect((await run("held_task", { heldId: "nope", action: "spawn" })).ok).toBe(false);
  expect((await run("held_task", { heldId: "held-1", action: "keep" })).ok).toBe(false);
});

test("herd_halt and herd_retry: the herd routes, retry by desig", async () => {
  const { worker, requests, run } = setup({
    answer: (req) => ({
      status: 200,
      body: req.path === "/api/halt" ? { halted: 3 } : { resumed: 1, steered: 0, total: 1 },
    }),
  });
  expect(await run("herd_halt", {})).toEqual({
    ok: true,
    data: { ok: true, action: "herd_halt", target: "herd", halted: 3 },
  });
  const retry = await run("herd_retry", { desigs: [worker.desig], text: "continue" });
  expect(retry.ok && retry.data).toMatchObject({ resumed: 1, steered: 0, total: 1 });
  expect(requests[1]).toEqual({
    method: "POST",
    path: "/api/retry",
    body: { text: "continue", ids: [worker.id] },
  });
});

// ── repo-scoped assistant ────────────────────────────────────────────────────

/** The refusal's status and message, or null when the action ran. */
const refusal = (res: Awaited<ReturnType<typeof applyOperatorAction>>) =>
  res.ok ? null : { status: res.status, error: res.error };

test("a scoped assistant acts on its own repo's sessions and refuses every other one", async () => {
  const { store, worker, requests, runScoped } = setup();
  const beta = addSession(store, "beta-worker", { repoPath: "/r/beta" });
  // Every desig-targeted tool, plus herd_retry, goes through the same scoped resolver.
  for (const [tool, args] of [
    ["session_steer", { text: "hi" }],
    ["session_interrupt", {}],
    ["session_archive", {}],
    ["plan_release", {}],
    ["pr_merge", {}],
    ["session_automation_set", { autopilot: true }],
  ] as [AssistantActionTool, Record<string, unknown>][]) {
    expect(refusal(await runScoped("/r/beta", tool, { desig: worker.desig, ...args }))).toEqual({
      status: 403,
      error: `session "${worker.desig}" is outside this assistant's repo beta — the global Operator Assistant covers every repo; the operator can ask there`,
    });
  }
  expect(
    refusal(await runScoped("/r/beta", "herd_retry", { desigs: [beta.desig, worker.desig] })),
  ).toMatchObject({ status: 403 });
  expect(requests).toEqual([]);

  expect((await runScoped("/r/beta", "session_interrupt", { desig: beta.desig })).ok).toBe(true);
  expect((await runScoped("/r/beta", "herd_retry", { desigs: [beta.desig] })).ok).toBe(true);
  expect(requests.map((r) => r.path)).toEqual([`/api/sessions/${beta.id}/interrupt`, "/api/retry"]);
  // Unknown stays 404, as for the global assistant.
  expect(
    refusal(await runScoped("/r/beta", "session_interrupt", { desig: "TASK-999" })),
  ).toMatchObject({ status: 404 });
});

test("a scoped assistant's repo tools default to nothing but accept only its own repo", async () => {
  const { requests, runScoped } = setup();
  for (const repo of ["beta", "/r/beta"]) {
    expect((await runScoped("/r/beta", "repo_automation_set", { repo, maxAuto: 2 })).ok).toBe(true);
  }
  expect(
    (await runScoped("/r/beta", "epic_run_set", { repo: "beta", epicParent: 3, status: "paused" }))
      .ok,
  ).toBe(true);
  for (const res of [
    await runScoped("/r/beta", "repo_automation_set", { repo: "alpha", maxAuto: 2 }),
    await runScoped("/r/beta", "epic_run_set", {
      repo: "/r/alpha",
      epicParent: 3,
      status: "paused",
    }),
  ]) {
    expect(refusal(res)?.status).toBe(403);
    expect(refusal(res)?.error).toContain("outside this assistant's repo beta (/r/beta)");
  }
  // session_start: only in its own repo.
  expect((await runScoped("/r/beta", "session_start", { repo: "beta", prompt: "x" })).ok).toBe(
    true,
  );
  const elsewhere = refusal(
    await runScoped("/r/beta", "session_start", { repo: "alpha", prompt: "x" }),
  );
  expect(elsewhere?.status).toBe(403);
  expect(elsewhere?.error).toContain("outside this assistant's repo beta (/r/beta)");
  // repo stays required for the action tools, scoped or not.
  expect(refusal(await runScoped("/r/beta", "repo_automation_set", { maxAuto: 2 }))?.status).toBe(
    400,
  );
  expect(requests.map((r) => r.path)).toEqual([
    "/api/repo-config?repo=%2Fr%2Fbeta",
    "/api/repo-config?repo=%2Fr%2Fbeta",
    "/api/epic?repo=%2Fr%2Fbeta&parent=3",
    "/api/sessions",
  ]);
  expect(requests[3]!.body).toMatchObject({ repoPath: "/r/beta" });
});

test("a scoped assistant's held_task reaches only its repo's held tasks", async () => {
  const { store, requests, runScoped } = setup();
  for (const [id, repoPath] of [
    ["held-a", "/r/alpha"],
    ["held-b", "/r/beta"],
  ] as const) {
    store.addHeldTask({
      id,
      repoPath,
      input: { prompt: "x" } as never,
      createdAt: 1,
      reason: "usage",
    });
  }
  expect(
    refusal(await runScoped("/r/beta", "held_task", { heldId: "held-a", action: "spawn" })),
  ).toMatchObject({ status: 403 });
  expect((await runScoped("/r/beta", "held_task", { heldId: "held-b", action: "spawn" })).ok).toBe(
    true,
  );
  expect(requests).toEqual([{ method: "POST", path: "/api/held/held-b/spawn" }]);
});

test("herd_halt is herd-wide: refused for a scoped assistant, pointing at the global one", async () => {
  const { requests, runScoped, run } = setup();
  const res = refusal(await runScoped("/r/beta", "herd_halt", {}));
  expect(res?.status).toBe(403);
  expect(res?.error).toContain("global Operator Assistant");
  expect(res?.error).toContain("session_interrupt");
  expect(requests).toEqual([]);
  // The global assistant still halts the herd.
  expect((await run("herd_halt", {})).ok).toBe(true);
});

test("answers never carry a route's body: no session row, no UUID", async () => {
  const { worker, run, logs } = setup({
    answer: () => ({ status: 201, body: { session: { id: crypto.randomUUID(), prompt: "x" } } }),
  });
  const res = await run("session_relaunch", { desig: worker.desig });
  expect(res.ok).toBe(true);
  expect(JSON.stringify(res)).not.toMatch(UUID_RE);
  expect(logs).toEqual([`[operator-assistant] session_relaunch ${worker.desig} → 201`]);
  expect(logs.join("")).not.toMatch(UUID_RE);
});

test("route errors are redacted and clipped", async () => {
  const { worker, run } = setup({
    answer: () => ({
      status: 502,
      body: { error: `token=ghp_${"a".repeat(36)} ${"x".repeat(900)}` },
    }),
  });
  const res = await run("session_steer", { desig: worker.desig, text: "hi" });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).not.toContain("ghp_");
    expect(res.error.length).toBeLessThanOrEqual(501);
  }
});

test("without operator action deps every action is unavailable", async () => {
  const store = new SessionStore(":memory:");
  const res = await applyOperatorAction(
    { store },
    "herd_halt",
    {},
    {
      sessionId: ASSISTANT_ID,
      scope: null,
    },
  );
  expect(res).toEqual({ ok: false, status: 503, error: "operator actions unavailable" });
});

test("drain_enqueue exposes the three operations in automation", () => {
  const tool = OPERATOR_ACTION_TOOLS.find((t) => t.name === "drain_enqueue");
  expect(tool).toBeDefined();
  expect(ASSISTANT_ACTION_GROUPS.automation as readonly string[]).toContain("drain_enqueue");
});

test("drain_enqueue maps each operation to the guarded issue route", async () => {
  for (const payload of [
    { operation: "queue", enabled: true },
    { operation: "queue", enabled: false },
    { operation: "priority", priority: "high" },
    { operation: "priority", priority: "normal" },
    { operation: "priority", priority: "low" },
    { operation: "release" },
  ]) {
    const { run, requests } = setup();
    const result = await run("drain_enqueue" as AssistantActionTool, {
      repo: "alpha",
      issueNumber: 42,
      ...payload,
    });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/issues/42/drain?repo=%2Fr%2Falpha",
        body: payload,
      },
    ]);
  }
});

test("drain_enqueue rejects invalid or operation-foreign arguments without dispatch", async () => {
  for (const payload of [
    { operation: "queue" },
    { operation: "queue", enabled: "true" },
    { operation: "queue", enabled: true, priority: "high" },
    { operation: "priority", priority: "urgent" },
    { operation: "release", enabled: false },
    { operation: "release", force: true },
    { operation: "close" },
    { operation: "release", issueNumber: 0 },
    { operation: "release", issueNumber: 1.5 },
    { operation: "release", issueNumber: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const { run, requests } = setup();
    const res = await run("drain_enqueue" as AssistantActionTool, {
      repo: "alpha",
      issueNumber: 42,
      ...payload,
    });
    expect(res.ok).toBe(false);
    expect(requests).toEqual([]);
  }
});

test("automation off refuses every drain operation before dispatch", async () => {
  for (const payload of [
    { operation: "queue", enabled: true },
    { operation: "priority", priority: "high" },
    { operation: "release" },
  ]) {
    const { run, requests } = setup({ permissions: { automation: "off" } });
    expect(
      await run("drain_enqueue" as AssistantActionTool, {
        repo: "alpha",
        issueNumber: 42,
        ...payload,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(requests).toEqual([]);
  }
});

test("repo-scoped drain actions cannot mutate another repo", async () => {
  for (const payload of [
    { operation: "queue", enabled: true },
    { operation: "priority", priority: "high" },
    { operation: "release" },
  ]) {
    const { runScoped, requests } = setup();
    expect(
      await runScoped("/r/alpha", "drain_enqueue", { repo: "beta", issueNumber: 42, ...payload }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(requests).toEqual([]);
    expect(
      (await runScoped("/r/alpha", "drain_enqueue", { repo: "alpha", issueNumber: 42, ...payload }))
        .ok,
    ).toBe(true);
    expect(requests).toHaveLength(1);
  }
});

// ── F08: `ask` is enforced by the server, bound to the exact call ─────────────

function approvals() {
  const events = new EventHub();
  const emitted: unknown[] = [];
  events.subscribe((event, data) => {
    if (event === ACTION_REQUEST_EVENT) emitted.push(data);
  });
  return { service: new ActionRequestService({ events }), events, emitted };
}

test("F08: an `ask` action never dispatches without the operator's approval", async () => {
  const { service, emitted } = approvals();
  const { run, requests, worker } = setup({
    permissions: { sessions: "ask" },
    actionRequests: service,
  });
  const pending = await run("session_interrupt", { desig: worker.desig });
  expect(pending).toMatchObject({ ok: true, data: { status: "awaiting_approval" } });
  expect(requests).toEqual([]);
  const open = service.snapshot()[ASSISTANT_ID]!;
  expect(open).toMatchObject({ tool: "session_interrupt", target: worker.desig });
  expect(emitted).toHaveLength(1);
  // The operator approves between two long-polls: the next IDENTICAL call runs, once.
  expect(service.resolve(ASSISTANT_ID, open.id, "approved")).toBe(true);
  expect((await run("session_interrupt", { desig: worker.desig })).ok).toBe(true);
  expect(requests).toHaveLength(1);
  const again = await run("session_interrupt", { desig: worker.desig });
  expect(again).toMatchObject({ ok: true, data: { status: "awaiting_approval" } });
  expect(requests).toHaveLength(1);
});

test("F08: an approval is bound to the tool and its arguments", async () => {
  const { service } = approvals();
  const { run, requests, worker, store } = setup({
    permissions: { sessions: "ask", steer: "ask" },
    actionRequests: service,
  });
  const other = addSession(store, "other");
  await run("session_interrupt", { desig: worker.desig });
  const open = service.snapshot()[ASSISTANT_ID]!;
  service.resolve(ASSISTANT_ID, open.id, "approved");
  // A different target or tool does not inherit it.
  await run("session_interrupt", { desig: other.desig });
  await run("session_steer", { desig: worker.desig, text: "go" });
  expect(requests).toEqual([]);
});

test("F08: a waiting call runs on approval, a denial refuses, `allow` never asks", async () => {
  const { service } = approvals();
  const { deps, requests, worker } = setup({
    permissions: { sessions: "ask", start: "allow" },
    actionRequests: service,
  });
  deps.actionWaitMs = 5_000;
  const caller = { sessionId: ASSISTANT_ID, scope: null };
  const waiting = applyOperatorAction(deps, "session_interrupt", { desig: worker.desig }, caller);
  await Bun.sleep(0);
  service.resolve(ASSISTANT_ID, service.snapshot()[ASSISTANT_ID]!.id, "approved");
  expect((await waiting).ok).toBe(true);
  expect(requests).toHaveLength(1);

  const denied = applyOperatorAction(deps, "session_interrupt", { desig: worker.desig }, caller);
  await Bun.sleep(0);
  service.resolve(ASSISTANT_ID, service.snapshot()[ASSISTANT_ID]!.id, "denied");
  expect(await denied).toMatchObject({ ok: false, status: 403 });
  expect(requests).toHaveLength(1);

  expect(
    (await applyOperatorAction(deps, "session_start", { repo: "alpha", prompt: "x" }, caller)).ok,
  ).toBe(true);
  expect(service.snapshot()).toEqual({});
});

test("F08: `ask` without an approval service fails closed", async () => {
  const { deps, requests, worker } = setup({ permissions: { sessions: "ask" } });
  delete (deps as { actionRequests?: unknown }).actionRequests;
  const res = await applyOperatorAction(
    deps,
    "session_interrupt",
    { desig: worker.desig },
    { sessionId: ASSISTANT_ID, scope: null },
  );
  expect(res).toMatchObject({ ok: false, status: 503 });
  expect(requests).toEqual([]);
});

// ── R2-F05: an assistant merge is bound to the PR revision it was built (and approved) for ──

test("pr_merge names the PR revision it binds in its target", async () => {
  const { worker, run } = setup();
  const res = await run("pr_merge", { desig: worker.desig });
  expect(res).toMatchObject({
    ok: true,
    data: { target: `${worker.desig} PR #12 @ ${HEAD.slice(0, 12)} → main` },
  });
});

test("pr_merge refuses without a cached open PR head, dispatching nothing", async () => {
  for (const pr of [
    null,
    { ...OPEN_PR, state: "merged" },
    { ...OPEN_PR, headSha: undefined },
    { ...OPEN_PR, number: undefined },
  ] as (GitState | null)[]) {
    const { worker, requests, run } = setup({ pr });
    const res = await run("pr_merge", { desig: worker.desig });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(requests).toEqual([]);
  }
});

test("pr_merge without a known base still binds the head", async () => {
  const { worker, requests, run } = setup({ pr: { ...OPEN_PR, baseRefName: undefined } });
  expect((await run("pr_merge", { desig: worker.desig })).ok).toBe(true);
  expect(requests[0]!.body).toEqual({ confirm: { headSha: HEAD, baseRefName: null } });
});

test("pr_merge relays a moved head's merge_confirm_stale refusal", async () => {
  const { worker, run } = setup({
    answer: () => ({ status: 409, body: { error: "the PR changed", code: "merge_confirm_stale" } }),
  });
  expect(await run("pr_merge", { desig: worker.desig })).toEqual({
    ok: false,
    status: 409,
    error: "merge_confirm_stale: the PR changed",
  });
});

test("an `ask` merge shows the bound revision, and an approval never runs a moved head", async () => {
  const { service } = approvals();
  const { run, requests, worker, cache } = setup({
    permissions: { approve: "ask" },
    actionRequests: service,
  });
  await run("pr_merge", { desig: worker.desig, pr: { headSha: "spoofed" } });
  const first = service.snapshot()[ASSISTANT_ID]!;
  expect(first.args).toEqual({
    desig: worker.desig,
    pr: { number: 12, headSha: HEAD, baseRefName: "main" },
  });
  expect(first.target).toContain(HEAD.slice(0, 12));
  // Approved between long-polls, but the head moved before the model called again.
  service.resolve(ASSISTANT_ID, first.id, "approved");
  const moved = "b".repeat(40);
  cache.pr = { ...OPEN_PR, headSha: moved };
  const res = await run("pr_merge", { desig: worker.desig, pr: { headSha: "spoofed" } });
  expect(res).toMatchObject({ ok: true, data: { status: "awaiting_approval" } });
  expect(requests).toEqual([]);
  const second = service.snapshot()[ASSISTANT_ID]!;
  expect(second.id).not.toBe(first.id);
  expect(second.args.pr).toEqual({ number: 12, headSha: moved, baseRefName: "main" });
  // Approving the new card runs the merge bound to the new head.
  service.resolve(ASSISTANT_ID, second.id, "approved");
  expect((await run("pr_merge", { desig: worker.desig, pr: { headSha: "spoofed" } })).ok).toBe(
    true,
  );
  expect(requests[0]!.body).toEqual({ confirm: { headSha: moved, baseRefName: "main" } });
});

const SCHEDULE = {
  repo: "beta",
  name: "Morning triage",
  prompt: "/triage-feedback",
  days: ["mon", "fri", "mon"],
  times: ["09:00"],
};

test("schedule_create posts the schedule with the days as a mask, answering its id and nextAt only", async () => {
  const nextAt = Date.UTC(2026, 9, 30, 8);
  const { run, requests } = setup({
    answer: () => ({
      status: 201,
      body: { id: "sch-1", prompt: "/triage-feedback", repoPath: "/r/beta", nextAt },
    }),
  });
  const res = await run("schedule_create", { ...SCHEDULE, baseBranch: "trunk", enabled: false });
  expect(requests).toEqual([
    {
      method: "POST",
      path: "/api/schedules",
      body: {
        repoPath: "/r/beta",
        name: "Morning triage",
        prompt: "/triage-feedback",
        days: 0b0010001,
        times: ["09:00"],
        enabled: false,
        launch: { baseBranch: "trunk" },
      },
    },
  ]);
  expect(res).toEqual({
    ok: true,
    data: {
      ok: true,
      action: "schedule_create",
      target: 'beta schedule "Morning triage"',
      days: ["mon", "fri", "mon"],
      times: ["09:00"],
      scheduleId: "sch-1",
      nextAt: new Date(nextAt).toISOString(),
    },
  });
});

test("schedule_create without baseBranch or enabled leaves the launch to the route's defaults", async () => {
  const { run, requests } = setup();
  expect((await run("schedule_create", SCHEDULE)).ok).toBe(true);
  expect(requests[0]!.body).not.toHaveProperty("launch");
  expect(requests[0]!.body).not.toHaveProperty("enabled");
});

test("schedule_create refuses bad arguments before dispatching", async () => {
  const { run, requests } = setup();
  for (const bad of [
    { name: " " },
    { prompt: "" },
    { days: [] },
    { days: ["monday"] },
    { times: "09:00" },
    { enabled: "yes" },
    { baseBranch: "" },
    { autopilotEnabled: true },
  ]) {
    expect(refusal(await run("schedule_create", { ...SCHEDULE, ...bad }))?.status).toBe(400);
  }
  expect(requests).toEqual([]);
});

test("schedule_create relays the route's validation error", async () => {
  const { run } = setup({
    answer: () => ({ status: 400, body: { error: "times must be HH:MM" } }),
  });
  expect(await run("schedule_create", { ...SCHEDULE, times: ["9am"] })).toMatchObject({
    ok: false,
    status: 400,
    error: "times must be HH:MM",
  });
});

test("schedule_create: automation off refuses it; a scoped assistant creates only in its repo", async () => {
  const off = setup({ permissions: { automation: "off" } });
  expect(refusal(await off.run("schedule_create", SCHEDULE))?.status).toBe(403);
  expect(off.requests).toEqual([]);
  const { runScoped, requests } = setup();
  expect((await runScoped("/r/beta", "schedule_create", SCHEDULE)).ok).toBe(true);
  const elsewhere = refusal(
    await runScoped("/r/beta", "schedule_create", { ...SCHEDULE, repo: "alpha" }),
  );
  expect(elsewhere?.status).toBe(403);
  expect(requests).toHaveLength(1);
});

test("handoff history cannot replay an allowed action before fresh operator input", async () => {
  const { store, requests, run, worker } = setup({ permissions: { sessions: "allow" } });
  store.setSetting(`assistantHandoff:${ASSISTANT_ID}`, "awaiting-operator");
  expect(await run("session_interrupt", { desig: worker.desig })).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(requests).toHaveLength(0);
  store.deleteSetting(`assistantHandoff:${ASSISTANT_ID}`);
  expect(await run("session_interrupt", { desig: worker.desig })).toMatchObject({ ok: true });
  expect(requests).toHaveLength(1);
});
