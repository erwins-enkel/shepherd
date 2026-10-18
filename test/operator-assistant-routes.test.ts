/**
 * The Operator Assistant's operator routes (#1446): GET /api/operator-assistant and the ensure /
 * reset POSTs — availability from Settings → Diagnose, 503 without a spawn when unavailable, the
 * `operator-assistant:update` event on success, the auth gate, and the agent ingress never
 * reaching them.
 */
import { afterEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentIngressApp, makeApp, type AppDeps } from "../src/server";
import { AssistantViewRegistry, UNKNOWN_VIEW } from "../src/operator-assistant-view";
import { config } from "../src/config";
import { hashPassword } from "../src/operator-auth";
import { OperatorAssistantSessionError, type SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import type { EventHub } from "../src/events";
import type { EpicRun } from "../src/epic-core";
import type { DiagnosticCheck, Session } from "../src/types";

const OK_CHECKS: DiagnosticCheck[] = [
  { id: "herdr", state: "ok", hintKey: "diagnostics_hint_herdr_ok" },
  { id: "claude", state: "ok", hintKey: "diagnostics_hint_claude_ok" },
  { id: "codex", state: "optional", hintKey: "diagnostics_hint_codex_optional" },
];

function assistantRow(store: SessionStore): Session {
  return store.create({
    name: "operator-assistant",
    prompt: "",
    repoPath: "/assistant",
    baseBranch: "",
    branch: null,
    worktreePath: "/assistant",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: "term_a",
    claudeSessionId: "claude-a",
    model: null,
    operatorAssistant: true,
  });
}

function setup(checks: DiagnosticCheck[] = OK_CHECKS) {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  const calls: string[] = [];
  let failWith: unknown = null;
  const lifecycle = (verb: string) => async () => {
    calls.push(verb);
    if (failWith) throw failWith;
    return store.getLiveOperatorAssistant() ?? assistantRow(store);
  };
  const deps: AppDeps = {
    store,
    service: {
      ensureOperatorAssistant: lifecycle("ensure"),
      resetOperatorAssistant: lifecycle("reset"),
    } as unknown as SessionService,
    events: {
      emit: (event: string, data: unknown) => emitted.push({ event, data }),
    } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    diagnostics: {
      current: async () => ({ checks, generatedAt: 0, overall: "ok" as const }),
      check: async () => ({ checks, generatedAt: 0, overall: "ok" as const }),
      fix: async () => ({ checks, generatedAt: 0, overall: "ok" as const }),
    },
  };
  return {
    deps,
    store,
    emitted,
    calls,
    app: makeApp(deps),
    failNextWith: (e: unknown) => (failWith = e),
  };
}

const post = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

test("GET reports available with no session before the first open", async () => {
  const { app } = setup();
  const res = await app.fetch(new Request("http://localhost/api/operator-assistant"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    available: true,
    reason: null,
    session: null,
    permissions: config.assistantPermissions,
  });
});

test("GET returns the live assistant row once it exists", async () => {
  const { app, store } = setup();
  const row = assistantRow(store);
  const body = await (
    await app.fetch(new Request("http://localhost/api/operator-assistant"))
  ).json();
  expect(body.available).toBe(true);
  expect(body.session.id).toBe(row.id);
  expect(body.session.operatorAssistant).toBe(true);
});

test("POST ensures the assistant and emits operator-assistant:update with it", async () => {
  const { app, emitted, calls } = setup();
  const res = await app.fetch(post("/api/operator-assistant"));
  expect(res.status).toBe(200);
  const { session } = await res.json();
  expect(session.operatorAssistant).toBe(true);
  expect(calls).toEqual(["ensure"]);
  expect(emitted).toEqual([
    {
      event: "operator-assistant:update",
      data: { session, permissions: config.assistantPermissions },
    },
  ]);
  expect(emitted.some((e) => e.event === "session:new")).toBe(false);
});

test("POST /reset starts a new conversation and emits the update", async () => {
  const { app, emitted, calls } = setup();
  const res = await app.fetch(post("/api/operator-assistant/reset"));
  expect(res.status).toBe(200);
  const { session } = await res.json();
  expect(calls).toEqual(["reset"]);
  expect(emitted).toEqual([
    {
      event: "operator-assistant:update",
      data: { session, permissions: config.assistantPermissions },
    },
  ]);
});

const UNAVAILABLE: [string, DiagnosticCheck[]][] = [
  [
    "claude_missing",
    [
      { id: "herdr", state: "ok", hintKey: "diagnostics_hint_herdr_ok" },
      // Missing while codex is present: `optional`, still nothing for the assistant to run.
      { id: "claude", state: "optional", hintKey: "diagnostics_hint_claude_optional" },
    ],
  ],
  [
    "claude_missing",
    [{ id: "claude", state: "error", hintKey: "diagnostics_hint_claude_missing" }],
  ],
  [
    "herdr_unreachable",
    [
      { id: "herdr", state: "error", hintKey: "diagnostics_hint_herdr_offline" },
      { id: "claude", state: "ok", hintKey: "diagnostics_hint_claude_ok" },
    ],
  ],
];

for (const [reason, checks] of UNAVAILABLE) {
  test(`unavailable (${reason}, ${checks.map((c) => `${c.id}:${c.state}`).join(" ")}): GET says why, POSTs 503 and spawn nothing`, async () => {
    const { app, emitted, calls } = setup(checks);
    const get = await (
      await app.fetch(new Request("http://localhost/api/operator-assistant"))
    ).json();
    expect(get).toEqual({
      available: false,
      reason,
      session: null,
      permissions: config.assistantPermissions,
    });
    for (const path of ["/api/operator-assistant", "/api/operator-assistant/reset"]) {
      const res = await app.fetch(post(path));
      expect(res.status).toBe(503);
      expect((await res.json()).reason).toBe(reason);
    }
    expect(calls).toEqual([]);
    expect(emitted).toEqual([]);
  });
}

test("an outdated-but-live herdr or a herdr_health warning does not block the assistant", async () => {
  const { app } = setup([
    { id: "herdr", state: "warning", hintKey: "diagnostics_hint_herdr_outdated" },
    { id: "herdr_health", state: "warning", hintKey: "diagnostics_hint_herdr_health_leftover" },
    { id: "claude", state: "ok", hintKey: "diagnostics_hint_claude_ok" },
  ]);
  const res = await app.fetch(post("/api/operator-assistant"));
  expect(res.status).toBe(200);
});

test("a failed spawn maps like a session create and emits nothing", async () => {
  const { app, emitted, failNextWith } = setup();
  failNextWith(new Error("herdr refused the command"));
  const res = await app.fetch(post("/api/operator-assistant"));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("herdr refused");
  failNextWith(new OperatorAssistantSessionError("relaunch"));
  expect((await app.fetch(post("/api/operator-assistant/reset"))).status).toBe(409);
  expect(emitted).toEqual([]);
});

test("other methods and sub-paths fall through to 404", async () => {
  const { app, calls } = setup();
  for (const req of [
    new Request("http://localhost/api/operator-assistant", { method: "DELETE" }),
    new Request("http://localhost/api/operator-assistant/reset"),
    post("/api/operator-assistant/other"),
    post("/api/operator-assistant/reset/x"),
  ])
    expect((await app.fetch(req)).status).toBe(404);
  expect(calls).toEqual([]);
});

test("the routes require operator auth", async () => {
  const saved = {
    secret: config.cookieSecret,
    hash: config.passwordHash,
    token: config.token,
  };
  restore = () => {
    config.cookieSecret = saved.secret;
    config.passwordHash = saved.hash;
    config.token = saved.token;
  };
  config.cookieSecret = "test-cookie-signing-secret";
  config.passwordHash = await hashPassword("operator-password");
  config.token = null;
  const { app, calls } = setup();
  expect((await app.fetch(new Request("http://localhost/api/operator-assistant"))).status).toBe(
    401,
  );
  expect((await app.fetch(post("/api/operator-assistant"))).status).toBe(401);
  expect((await app.fetch(post("/api/operator-assistant/reset"))).status).toBe(401);
  expect(calls).toEqual([]);
});

test("the agent ingress never reaches them", async () => {
  const { deps, calls } = setup();
  const ingress = makeAgentIngressApp(deps);
  for (const req of [
    new Request("http://localhost/api/operator-assistant"),
    post("/api/operator-assistant"),
    post("/api/operator-assistant/reset"),
  ])
    expect((await ingress.fetch(req)).status).toBe(404);
  expect(calls).toEqual([]);
});

test("the assistant's MCP endpoint reads the real services: drain, epic diagnosis, config log paths", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oa-diag-")));
  const repo = join(root, "alpha");
  mkdirSync(repo);
  const log = join(root, "shepherd.log");
  writeFileSync(log, "boot\nSHEPHERD_PASSWORD=hunter2 leaked\n");
  const saved = { repoRoot: config.repoRoot, log: config.shepherdLogPath };
  restore = () => {
    config.repoRoot = saved.repoRoot;
    config.shepherdLogPath = saved.log;
    rmSync(root, { recursive: true, force: true });
  };
  config.repoRoot = root;
  config.shepherdLogPath = log;
  const { deps, store } = setup();
  const diagnosed: EpicRun[] = [];
  deps.drain = {
    snapshot: async () => [],
    diagnoseEpic: async (_dir: string, run: EpicRun) => {
      diagnosed.push(run);
      return {
        parentIssueNumber: run.parentIssueNumber,
        recognized: true,
        source: "native",
        findings: [],
        additionalWarnings: [],
      };
    },
  } as unknown as AppDeps["drain"];
  store.setEpicRun({ repoPath: repo, parentIssueNumber: 7, mode: "auto", status: "running" });
  const assistant = assistantRow(store);
  const app = makeApp(deps);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${assistant.id}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text);
  };
  const automation = await tool("repo_automation", { repo: "alpha", epicParent: 7 });
  expect(automation.repos[0].repoPath).toBe(repo);
  expect(automation.repos[0].epicDiagnosis.parentIssueNumber).toBe(7);
  // The repo's stored run for that parent, as GET /api/epic/diagnose picks it.
  expect(diagnosed).toMatchObject([{ repoPath: repo, parentIssueNumber: 7, status: "running" }]);
  const tail = await tool("logs_tail", { source: "shepherd" });
  expect(tail).toMatchObject({ path: log, found: true, lines: 2 });
  expect(tail.text).not.toContain("hunter2");
});

/** A herd session the assistant's actions may target. */
function workerRow(store: SessionStore): Session {
  return store.create({
    name: "worker",
    prompt: "p",
    repoPath: "/r/alpha",
    baseBranch: "main",
    branch: "shepherd/worker",
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: "term_w",
    claudeSessionId: "claude-w",
    model: null,
  });
}

/** One `tools/call` on the assistant's MCP endpoint: the tool result's payload and isError. */
async function callTool(
  app: ReturnType<typeof makeApp>,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await app.fetch(
    new Request(`http://localhost/api/sessions/${sessionId}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await res.json()) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return { isError: body.result.isError ?? false, data: JSON.parse(body.result.content[0]!.text) };
}

test("assistant actions run the operator's own routes in-process: interrupt and steer reach the service", async () => {
  const saved = config.assistantPermissions;
  restore = () => (config.assistantPermissions = saved);
  config.assistantPermissions = { ...saved, steer: "ask", sessions: "allow" };
  const { deps, store } = setup();
  const seen: string[] = [];
  deps.service = {
    interrupt: async (id: string) => (seen.push(`interrupt ${id}`), true),
    operatorReply: async (id: string, text: string) => (seen.push(`reply ${id} ${text}`), true),
  } as unknown as SessionService;
  const assistant = assistantRow(store);
  const worker = workerRow(store);
  const app = makeApp(deps);

  const interrupted = await callTool(app, assistant.id, "session_interrupt", {
    desig: worker.desig,
  });
  expect(interrupted).toEqual({
    isError: false,
    data: { ok: true, action: "session_interrupt", target: worker.desig },
  });
  const steered = await callTool(app, assistant.id, "session_steer", {
    desig: worker.desig,
    text: "rebase please",
  });
  expect(steered.isError).toBe(false);
  expect(seen).toEqual([`interrupt ${worker.id}`, `reply ${worker.id} rebase please`]);
});

test("an action of a group turned off never reaches its route, even with the route's service wired", async () => {
  const saved = config.assistantPermissions;
  restore = () => (config.assistantPermissions = saved);
  config.assistantPermissions = { ...saved, sessions: "off" };
  const { deps, store } = setup();
  let interrupts = 0;
  deps.service = { interrupt: async () => (interrupts++, true) } as unknown as SessionService;
  const assistant = assistantRow(store);
  const worker = workerRow(store);
  const out = await callTool(makeApp(deps), assistant.id, "session_interrupt", {
    desig: worker.desig,
  });
  expect(out.isError).toBe(true);
  expect(out.data.error).toContain("turned off in Settings → Assistant");
  expect(interrupts).toBe(0);
});

test("the agent ingress serves the assistant's actions only on the assistant's own MCP endpoint", async () => {
  const { deps, store } = setup();
  let interrupts = 0;
  deps.service = { interrupt: async () => (interrupts++, true) } as unknown as SessionService;
  const worker = workerRow(store);
  const ingress = makeAgentIngressApp(deps);
  // A herd agent calling an action tool on its own endpoint: the entitlement error.
  const res = await ingress.fetch(
    new Request(`http://localhost/api/sessions/${worker.id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "session_interrupt", arguments: { desig: worker.desig } },
      }),
    }),
  );
  expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
  // And the operator route itself stays off the ingress.
  const direct = await ingress.fetch(post(`/api/sessions/${worker.id}/interrupt`));
  expect(direct.status).toBe(404);
  expect(interrupts).toBe(0);
});

// ── The view hook (#3161) ────────────────────────────────────────────────────────────────────

const hook = (id: string, body: unknown) =>
  new Request(`http://localhost/api/sessions/${id}/assistant-view`, {
    method: "POST",
    body: JSON.stringify(body),
  });

test("the view hook answers the owner's view as UserPromptSubmit additionalContext", async () => {
  const { deps, store } = setup();
  const registry = new AssistantViewRegistry();
  deps.assistantView = registry;
  const app = makeApp(deps);
  const assistant = assistantRow(store);
  const task = store.create({
    name: "taegliche-101",
    prompt: "go",
    repoPath: "/p/shepherd",
    baseBranch: "main",
    branch: "shepherd/taegliche-101",
    worktreePath: "/p/.shepherd-worktrees/shepherd-taegliche-101",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_t",
  });
  const prompt = { session_id: "claude-a", hook_event_name: "UserPromptSubmit", prompt: "why?" };

  // Nobody reported a view yet → the explicit unknown block, never an empty answer.
  let res = await app.fetch(hook(assistant.id, prompt));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: UNKNOWN_VIEW },
  });

  registry.set(assistant.id, {
    v: 1,
    client: { kind: "pwa", platform: "ios" },
    repoFilter: ["/p/shepherd"],
    focus: { kind: "session", id: task.id, tab: "diff" },
  });
  res = await app.fetch(hook(assistant.id, prompt));
  const context: string = (await res.json()).hookSpecificOutput.additionalContext;
  expect(context).toContain("client: pwa · ios");
  expect(context).toContain("repo filter: shepherd (/p/shepherd)");
  expect(context).toContain(`session in view: ${task.desig} taegliche-101 · repo shepherd`);
  expect(context).toContain("· tab Diff ·");
  expect(context).not.toContain(task.id);
});

test("the view hook is the assistant's alone and still answers after /clear", async () => {
  const { deps, store } = setup();
  deps.assistantView = new AssistantViewRegistry();
  const app = makeApp(deps);
  const assistant = assistantRow(store);
  const task = store.create({
    name: "task",
    prompt: "go",
    repoPath: "/p/shepherd",
    baseBranch: "main",
    branch: null,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_t",
  });
  expect((await app.fetch(hook(task.id, {}))).status).toBe(404);
  expect((await app.fetch(hook("nope", {}))).status).toBe(404);
  // /clear gives the conversation a new session_id while the pinned claudeSessionId stays: every
  // later message must still get its block.
  const cleared = await app.fetch(hook(assistant.id, { session_id: "claude-b" }));
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).hookSpecificOutput.additionalContext).toBe(UNKNOWN_VIEW);
  // The agent ingress serves it — that's where the assistant's claude posts its hooks.
  const ingress = makeAgentIngressApp(deps);
  const viaIngress = await ingress.fetch(hook(assistant.id, { session_id: "claude-a" }));
  expect(viaIngress.status).toBe(200);
  expect((await viaIngress.json()).hookSpecificOutput.additionalContext).toBe(UNKNOWN_VIEW);
});
