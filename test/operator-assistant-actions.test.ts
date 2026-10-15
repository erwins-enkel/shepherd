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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function addSession(
  store: SessionStore,
  name: string,
  opts: { terminal?: boolean; operatorAssistant?: boolean } = {},
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

function setup(
  opts: {
    permissions?: Partial<AssistantPermissions>;
    answer?: (req: OperatorActionRequest) => { status: number; body: unknown };
  } = {},
) {
  const store = new SessionStore(":memory:");
  const requests: OperatorActionRequest[] = [];
  const logs: string[] = [];
  const permissions = { ...DEFAULT_ASSISTANT_PERMISSIONS, ...opts.permissions };
  const deps = {
    store,
    operatorDiag: {
      repos: () => ["/r/alpha", "/r/beta"],
      logPaths: {} as never,
      herdrSocketPath: "/nonexistent",
    },
    operatorActions: {
      permissions: () => permissions,
      dispatch: async (req: OperatorActionRequest) => {
        requests.push(req);
        return opts.answer?.(req) ?? { status: 200, body: { ok: true } };
      },
      log: (line: string) => logs.push(line),
    },
  };
  const worker = addSession(store, "worker");
  const run = (tool: AssistantActionTool, args: Record<string, unknown>) =>
    applyOperatorAction(deps, tool, args);
  return { store, deps, requests, logs, worker, run };
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
    ["pr_merge", {}, { method: "POST", body: {} }, "git/merge"],
  ];
  for (const [tool, args, expected, sub] of cases) {
    const { worker, requests, run } = setup();
    const res = await run(tool, { desig: worker.desig, ...args });
    expect(res.ok).toBe(true);
    const path = `/api/sessions/${worker.id}${sub ? `/${sub}` : ""}`;
    expect(requests).toEqual([{ ...expected, path }]);
  }
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
  const res = await run("pr_merge", { desig: worker.desig, confirm: { headSha: "abc" } });
  expect(requests[0]!.body).toEqual({});
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
  const res = await applyOperatorAction({ store }, "herd_halt", {});
  expect(res).toEqual({ ok: false, status: 503, error: "operator actions unavailable" });
});
