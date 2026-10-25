/**
 * The Operator Assistant's operator routes (#1446): GET /api/operator-assistant and the ensure /
 * reset / close POSTs — availability from Settings → Diagnose, 503 without a spawn when
 * unavailable, the repo scopes, the `operator-assistant:update` event on success, the auth gate,
 * and the agent ingress never reaching them.
 */
import { afterEach, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentIngressApp, makeApp, type AppDeps } from "../src/server";
import { BrowserTokenSigner } from "../src/browser-token";
import { ActionRequestService } from "../src/action-request";
import { EventHub } from "../src/events";
import { AssistantViewRegistry, UNKNOWN_VIEW } from "../src/operator-assistant-view";
import { config } from "../src/config";
import { hashPassword } from "../src/operator-auth";
import {
  OperatorAssistantNotFoundError,
  OperatorAssistantSessionError,
  type SessionService,
} from "../src/service";
import { SessionStore } from "../src/store";
import type { EpicRun } from "../src/epic-core";
import type { DiagnosticCheck, Session } from "../src/types";

const OK_CHECKS: DiagnosticCheck[] = [
  { id: "herdr", state: "ok", hintKey: "diagnostics_hint_herdr_ok" },
  { id: "claude", state: "ok", hintKey: "diagnostics_hint_claude_ok" },
  { id: "codex", state: "optional", hintKey: "diagnostics_hint_codex_optional" },
];

function assistantRow(store: SessionStore, assistantRepo: string | null = null): Session {
  const name = assistantRepo
    ? `operator-assistant-${assistantRepo.split("/").pop()}`
    : "operator-assistant";
  return store.create({
    name,
    prompt: "",
    repoPath: "/assistant",
    baseBranch: "",
    branch: null,
    worktreePath: "/assistant",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: `term_${name}`,
    claudeSessionId: `claude-${name}`,
    model: null,
    operatorAssistant: true,
    assistantRepo,
  });
}

function setup(checks: DiagnosticCheck[] = OK_CHECKS) {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  const calls: string[] = [];
  let failWith: unknown = null;
  const lifecycle =
    (verb: string) =>
    async (repo: string | null = null) => {
      calls.push(repo ? `${verb} ${repo}` : verb);
      if (failWith) throw failWith;
      return store.getLiveOperatorAssistant(repo) ?? assistantRow(store, repo);
    };
  const deps: AppDeps = {
    store,
    service: {
      ensureOperatorAssistant: lifecycle("ensure"),
      resetOperatorAssistant: lifecycle("reset"),
      closeOperatorAssistant: async (repo: string) => {
        calls.push(`close ${repo}`);
        const live = store.getLiveOperatorAssistant(repo);
        if (!live) throw new OperatorAssistantNotFoundError(repo);
        store.archive(live.id);
      },
      syncOperatorAssistantPermissions: () => {},
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

const post = (path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** Exactly one `operator-assistant:update`: the global row's id as `session`, every live
 *  assistant's id as `sessions`, and the current permissions. */
function expectOneUpdate(
  emitted: { event: string; data: unknown }[],
  sessionId: string | null,
  sessionIds: string[],
) {
  expect(emitted.map((e) => e.event)).toEqual(["operator-assistant:update"]);
  const data = emitted[0]!.data as {
    session: Session | null;
    sessions: Session[];
    permissions: unknown;
  };
  expect(data.session?.id ?? null).toBe(sessionId);
  expect(data.sessions.map((s) => s.id)).toEqual(sessionIds);
  expect(data.permissions).toEqual(config.assistantPermissions);
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** A repo root holding `alpha` and `beta`, set as config.repoRoot until the test ends — through a
 *  symlink, so a repo's listed path (`alpha`) and its realpath (`alphaReal`) differ. */
function withRepos() {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "oa-repos-")));
  const root = join(real, "root");
  mkdirSync(root);
  for (const name of ["alpha", "beta"]) mkdirSync(join(root, name));
  const link = join(real, "link");
  symlinkSync(root, link);
  const saved = config.repoRoot;
  restore = () => {
    config.repoRoot = saved;
    rmSync(real, { recursive: true, force: true });
  };
  config.repoRoot = link;
  return {
    root: link,
    alpha: join(link, "alpha"),
    alphaReal: join(root, "alpha"),
    beta: join(link, "beta"),
  };
}

test("GET reports available with no session before the first open", async () => {
  const { app } = setup();
  const res = await app.fetch(new Request("http://localhost/api/operator-assistant"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    available: true,
    reason: null,
    session: null,
    sessions: [],
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
  expectOneUpdate(emitted, session.id, [session.id]);
  expect(emitted.some((e) => e.event === "session:new")).toBe(false);
});

test("POST /reset starts a new conversation and emits the update", async () => {
  const { app, emitted, calls } = setup();
  const res = await app.fetch(post("/api/operator-assistant/reset"));
  expect(res.status).toBe(200);
  const { session } = await res.json();
  expect(calls).toEqual(["reset"]);
  expectOneUpdate(emitted, session.id, [session.id]);
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
      sessions: [],
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
  expect((await app.fetch(post("/api/operator-assistant/close", { repo: "/r" }))).status).toBe(401);
  expect(calls).toEqual([]);
});

test("the agent ingress never reaches them", async () => {
  const { deps, calls, store } = setup();
  const { alpha } = withRepos();
  assistantRow(store, alpha);
  const ingress = makeAgentIngressApp(deps);
  for (const req of [
    new Request("http://localhost/api/operator-assistant"),
    post("/api/operator-assistant"),
    post("/api/operator-assistant", { repo: alpha }),
    post("/api/operator-assistant/reset"),
    post("/api/operator-assistant/reset", { repo: alpha }),
    post("/api/operator-assistant/close", { repo: alpha }),
  ])
    expect((await ingress.fetch(req)).status).toBe(404);
  expect(calls).toEqual([]);
  expect(store.getLiveOperatorAssistant(alpha)).not.toBeNull();
});

// ── Repo-scoped assistants ───────────────────────────────────────────────────────────────────

const getState = async (app: ReturnType<typeof makeApp>) =>
  (await app.fetch(new Request("http://localhost/api/operator-assistant"))).json();

test("GET lists every live assistant as sessions; session stays the global one", async () => {
  const { app, store } = setup();
  const { alpha } = withRepos();
  const scoped = assistantRow(store, alpha);
  let body = await getState(app);
  // Only a repo assistant: older clients see no assistant at all.
  expect(body.session).toBeNull();
  expect(body.sessions.map((s: Session) => s.id)).toEqual([scoped.id]);
  const global = assistantRow(store);
  body = await getState(app);
  expect(body.session.id).toBe(global.id);
  expect(body.sessions.map((s: Session) => [s.id, s.assistantRepo])).toEqual([
    [global.id, null],
    [scoped.id, alpha],
  ]);
});

test("POST {repo} ensures that repo's assistant; the event's session is still the global row", async () => {
  const { app, store, emitted, calls } = setup();
  const { alpha, alphaReal } = withRepos();
  const res = await app.fetch(post("/api/operator-assistant", { repo: alpha }));
  expect(res.status).toBe(200);
  const { session } = await res.json();
  expect(session.assistantRepo).toBe(alpha);
  expect(calls).toEqual([`ensure ${alpha}`]);
  // No global assistant yet: the event says so, and lists the repo one.
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.event).toBe("operator-assistant:update");
  const first = emitted[0]!.data as { session: Session | null; sessions: Session[] };
  expect(first.session).toBeNull();
  expect(first.sessions.map((s) => s.id)).toEqual([session.id]);

  const global = assistantRow(store);
  // A realpath names the same repo, answered in the repo-list form; an empty body is global.
  expect((await app.fetch(post("/api/operator-assistant/reset", { repo: alphaReal }))).status).toBe(
    200,
  );
  expect((await app.fetch(post("/api/operator-assistant", { repo: "" }))).status).toBe(200);
  expect(calls).toEqual([`ensure ${alpha}`, `reset ${alpha}`, "ensure"]);
  for (const e of emitted.slice(1)) {
    const data = e.data as { session: Session; sessions: Session[] };
    expect(data.session.id).toBe(global.id);
    expect(data.sessions.map((s) => s.id)).toEqual([global.id, session.id]);
  }
});

test("POST with an unknown or malformed repo is a 400 and spawns nothing", async () => {
  const { app, emitted, calls } = setup();
  const { root } = withRepos();
  for (const path of ["/api/operator-assistant", "/api/operator-assistant/reset"]) {
    for (const body of [
      { repo: join(root, "gamma") },
      { repo: "/etc" },
      { repo: "alpha" }, // a basename is not a repo path
      { repo: 7 },
      "not json",
      "[]",
    ]) {
      const res = await app.fetch(post(path, body));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
  }
  expect(calls).toEqual([]);
  expect(emitted).toEqual([]);
});

test("POST /close archives a repo's assistant and emits the update; 400 without repo, 404 without one live", async () => {
  const { app, store, emitted, calls } = setup();
  const { root, alpha, beta } = withRepos();
  const global = assistantRow(store);
  const scoped = assistantRow(store, alpha);
  const res = await app.fetch(post("/api/operator-assistant/close", { repo: alpha }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(store.get(scoped.id)!.status).toBe("archived");
  expect(emitted).toHaveLength(1);
  const data = emitted[0]!.data as { session: Session; sessions: Session[] };
  expect(data.session.id).toBe(global.id);
  expect(data.sessions.map((s) => s.id)).toEqual([global.id]);

  for (const body of [undefined, {}, { repo: "" }, { repo: null }]) {
    const missing = await app.fetch(post("/api/operator-assistant/close", body));
    expect(missing.status).toBe(400);
  }
  expect(
    (await app.fetch(post("/api/operator-assistant/close", { repo: join(root, "gamma") }))).status,
  ).toBe(400);
  const none = await app.fetch(post("/api/operator-assistant/close", { repo: beta }));
  expect(none.status).toBe(404);
  expect(calls).toEqual([`close ${alpha}`, `close ${beta}`]);
  expect(emitted).toHaveLength(1);
  // The global assistant is never closed this way.
  expect(store.get(global.id)!.status).not.toBe("archived");
});

test("POST /close still closes the assistant of a repo that left the repo root", async () => {
  const { app, store, calls } = setup();
  withRepos();
  const scoped = assistantRow(store, "/gone/repo");
  const res = await app.fetch(post("/api/operator-assistant/close", { repo: "/gone/repo" }));
  expect(res.status).toBe(200);
  expect(calls).toEqual(["close /gone/repo"]);
  expect(store.get(scoped.id)!.status).toBe("archived");
});

test("close needs no availability: it works while the assistant can't run", async () => {
  const { app, store } = setup([
    { id: "claude", state: "error", hintKey: "diagnostics_hint_claude_missing" },
  ]);
  const { alpha } = withRepos();
  assistantRow(store, alpha);
  expect((await app.fetch(post("/api/operator-assistant/close", { repo: alpha }))).status).toBe(
    200,
  );
  expect((await app.fetch(post("/api/operator-assistant", { repo: alpha }))).status).toBe(503);
});

test("the settings-change emit carries the global row and every live assistant", async () => {
  const saved = config.assistantPermissions;
  restore = () => (config.assistantPermissions = saved);
  const { app, store, emitted } = setup();
  const global = assistantRow(store);
  const scoped = assistantRow(store, "/r/alpha");
  const res = await app.fetch(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantPermissions: { steer: "allow" } }),
    }),
  );
  expect(res.status).toBe(200);
  const update = emitted.find((e) => e.event === "operator-assistant:update");
  const data = update!.data as { session: Session; sessions: Session[] };
  expect(data.session.id).toBe(global.id);
  expect(data.sessions.map((s) => s.id)).toEqual([global.id, scoped.id]);
});

test("a repo assistant's MCP tools are scoped to its repo by the server", async () => {
  const { deps, store } = setup();
  const saved = config.assistantPermissions;
  restore = () => (config.assistantPermissions = saved);
  config.assistantPermissions = { ...saved, sessions: "allow" };
  let interrupts = 0;
  deps.service = { interrupt: async () => (interrupts++, true) } as unknown as SessionService;
  const app = makeApp(deps);
  const scoped = assistantRow(store, "/r/beta");
  const alphaWorker = workerRow(store);
  const betaWorker = store.create({
    name: "beta-worker",
    prompt: "p",
    repoPath: "/r/beta",
    baseBranch: "main",
    branch: "shepherd/beta-worker",
    worktreePath: "/wt-beta",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: "term_b",
  });
  const herd = await callTool(app, scoped.id, "herd_status", {});
  expect(herd.data.sessions.map((s: { desig: string }) => s.desig)).toEqual([betaWorker.desig]);
  const refused = await callTool(app, scoped.id, "session_interrupt", { desig: alphaWorker.desig });
  expect(refused.isError).toBe(true);
  expect(refused.data.error).toContain("outside this assistant's repo beta");
  const halt = await callTool(app, scoped.id, "herd_halt", {});
  expect(halt.isError).toBe(true);
  expect(
    (await callTool(app, scoped.id, "session_interrupt", { desig: betaWorker.desig })).isError,
  ).toBe(false);
  expect(interrupts).toBe(1);
  // The global assistant still sees the whole herd.
  const global = assistantRow(store);
  const all = await callTool(app, global.id, "herd_status", {});
  expect(all.data.sessions).toHaveLength(2);
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
    releasePlanOnOperatorReply: () => false,
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
  // steer is `ask`: the server holds it until the operator approves THAT call in the HUD (F08).
  const requests = new ActionRequestService({ events: new EventHub() });
  deps.actionRequests = requests;
  deps.actionWaitMs = 10;
  const steer = () =>
    callTool(app, assistant.id, "session_steer", { desig: worker.desig, text: "rebase please" });
  expect((await steer()).data).toMatchObject({ status: "awaiting_approval" });
  expect(seen).toEqual([`interrupt ${worker.id}`]);
  const open = await (await app.fetch(new Request("http://localhost/api/action-requests"))).json();
  const requestId = open[assistant.id].id as string;
  expect(open[assistant.id]).toMatchObject({ tool: "session_steer", target: worker.desig });
  const answer = (body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`http://localhost/api/sessions/${assistant.id}/action-request`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  expect((await answer({ requestId: "nope", outcome: "approved" })).status).toBe(404);
  expect((await answer({ requestId, outcome: "approved" })).status).toBe(200);
  const steered = await steer();
  expect(steered.isError).toBe(false);
  expect(seen).toEqual([`interrupt ${worker.id}`, `reply ${worker.id} rebase please`]);
  // The assistant's own ingress cannot reach the answer route.
  const viaIngress = await makeAgentIngressApp(deps).fetch(
    new Request(`http://127.0.0.1/api/sessions/${assistant.id}/action-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, outcome: "approved" }),
    }),
  );
  expect(viaIngress.status).toBe(404);
});

test("session_steer never releases a plan gate: plan_release/queue_approve stay in approve (#2586)", async () => {
  const saved = config.assistantPermissions;
  restore = () => (config.assistantPermissions = saved);
  config.assistantPermissions = { ...saved, steer: "allow", approve: "off" };
  const { deps, store } = setup();
  const assistant = assistantRow(store);
  const worker = workerRow(store);
  store.setPlanPhase(worker.id, "planning");
  const released: string[] = [];
  deps.service = {
    operatorReply: async () => true,
    // Does what the real release does, so a call would show in the store.
    releasePlanOnOperatorReply: (id: string) => {
      released.push(id);
      store.setPlanPhase(id, "executing");
      store.setBuildQueueApproved(id, true, "operator");
      return true;
    },
  } as unknown as SessionService;
  const app = makeApp(deps);
  const steered = await callTool(app, assistant.id, "session_steer", {
    desig: worker.desig,
    text: "go ahead",
  });
  expect(steered.isError).toBe(false);
  expect(released).toEqual([]);
  expect(store.get(worker.id)!.planPhase).toBe("planning");
  expect(store.getBuildQueue(worker.id).approved).toBe(false);
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

test("session_start runs New Task's create in-process: the repo's branch, the operator's model, the desig back", async () => {
  const repos = withRepos();
  const saved = { perms: config.assistantPermissions, model: config.defaultModel };
  const cleanRepos = restore;
  restore = () => {
    cleanRepos?.();
    config.assistantPermissions = saved.perms;
    config.defaultModel = saved.model;
  };
  config.assistantPermissions = { ...saved.perms, start: "allow" };
  config.defaultModel = "opus";
  // A repo on `trunk` with no origin: the base falls back to its current branch, as in New Task.
  execFileSync("git", ["init", "-q", "-b", "trunk", repos.beta]);
  execFileSync("git", [
    ...[
      "-C",
      repos.beta,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
    ],
    ...["commit", "-q", "--allow-empty", "-m", "init"],
  ]);
  const { deps, store, emitted } = setup();
  const created: Record<string, unknown>[] = [];
  deps.service = {
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: crypto.randomUUID(), desig: "TASK-77" };
    },
  } as unknown as SessionService;
  const scoped = assistantRow(store, repos.beta);
  const app = makeApp(deps);

  const started = await callTool(app, scoped.id, "session_start", {
    repo: "beta",
    prompt: "fix the footer",
  });
  expect(started).toEqual({
    isError: false,
    data: {
      ok: true,
      action: "session_start",
      target: "beta",
      baseBranch: "trunk",
      desig: "TASK-77",
    },
  });
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    repoPath: repos.beta,
    baseBranch: "trunk",
    prompt: "fix the footer",
    model: "opus",
  });
  expect(emitted.map((e) => e.event)).toContain("session:new");

  // Out of its repo, the scoped assistant starts nothing.
  const refused = await callTool(app, scoped.id, "session_start", { repo: "alpha", prompt: "x" });
  expect(refused.isError).toBe(true);
  expect(created).toHaveLength(1);
});

test("the agent ingress serves the assistant's actions only on the assistant's own MCP endpoint", async () => {
  const { deps, store } = setup();
  let interrupts = 0;
  deps.service = { interrupt: async () => (interrupts++, true) } as unknown as SessionService;
  const worker = workerRow(store);
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 5));
  const ingress = makeAgentIngressApp({ ...deps, assistantIngress: signer });
  // A herd agent calling an action tool on its own endpoint (with its own key): the entitlement error.
  const res = await ingress.fetch(
    new Request(`http://localhost/api/sessions/${worker.id}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shepherd-ingress-key": signer.sign(worker.id),
      },
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
  // The agent ingress serves it — that's where the assistant's claude posts its hooks — but only
  // with the assistant's ingress key (audit F08).
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 3));
  deps.assistantIngress = signer;
  const ingress = makeAgentIngressApp(deps);
  expect((await ingress.fetch(hook(assistant.id, { session_id: "claude-a" }))).status).toBe(401);
  const keyed = hook(assistant.id, { session_id: "claude-a" });
  keyed.headers.set("x-shepherd-ingress-key", signer.sign(assistant.id));
  const viaIngress = await ingress.fetch(keyed);
  expect(viaIngress.status).toBe(200);
  expect((await viaIngress.json()).hookSpecificOutput.additionalContext).toBe(UNKNOWN_VIEW);
});

test("assistant drain operations round-trip through MCP and repo_automation with shell off", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oa-issue-drain-")));
  const repo = join(root, "alpha");
  mkdirSync(repo);
  const saved = { repoRoot: config.repoRoot, permissions: config.assistantPermissions };
  restore = () => {
    config.repoRoot = saved.repoRoot;
    config.assistantPermissions = saved.permissions;
    rmSync(root, { recursive: true, force: true });
  };
  config.repoRoot = root;
  config.assistantPermissions = { ...saved.permissions, shell: "off", automation: "allow" };
  const { deps, store } = setup();
  const labels = new Set<string>(["shepherd:active"]);
  let writes = 0;
  deps.resolveForge = () =>
    ({
      kind: "github",
      slug: "owner/repo",
      getIssue: async () => ({
        number: 42,
        title: "untrusted title",
        body: "private body",
        url: "",
        labels: [...labels],
        state: "open",
        createdAt: 0,
        assignees: [],
      }),
      addIssueLabel: async (_n: number, label: string) => {
        writes++;
        labels.add(label);
      },
      removeIssueLabel: async (_n: number, label: string) => {
        writes++;
        labels.delete(label);
      },
      hasOpenPrForIssue: async () => false,
    }) as never;
  const assistant = assistantRow(store);
  const app = makeApp(deps);
  for (const [payload, expected] of [
    [
      { operation: "queue", enabled: true },
      { queued: true, claimed: true, priority: "normal" },
    ],
    [
      { operation: "priority", priority: "low" },
      { queued: true, claimed: true, priority: "low" },
    ],
    [{ operation: "release" }, { queued: true, claimed: false, priority: "low" }],
    [
      { operation: "queue", enabled: false },
      { queued: false, claimed: false, priority: "low" },
    ],
  ] as const) {
    expect(
      (
        await callTool(app, assistant.id, "drain_enqueue", {
          repo: "alpha",
          issueNumber: 42,
          ...payload,
        })
      ).isError,
    ).toBe(false);
    const read = await callTool(app, assistant.id, "repo_automation", {
      repo: "alpha",
      issueNumber: 42,
    });
    expect(read.isError).toBe(false);
    expect(read.data.repos[0].issue).toMatchObject(expected);
    expect(JSON.stringify(read)).not.toContain("private body");
  }
  config.assistantPermissions = { ...config.assistantPermissions, automation: "off" };
  const before = writes;
  for (const payload of [
    { operation: "queue", enabled: true },
    { operation: "priority", priority: "high" },
    { operation: "release" },
  ]) {
    const result = await callTool(app, assistant.id, "drain_enqueue", {
      repo: "alpha",
      issueNumber: 42,
      ...payload,
    });
    expect(result.isError).toBe(true);
    expect(result.data.error).toContain("turned off");
  }
  expect(writes).toBe(before);
  const worker = workerRow(store);
  const denied = await app.fetch(
    new Request(`http://localhost/api/sessions/${worker.id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "drain_enqueue",
          arguments: { repo: "alpha", issueNumber: 42, operation: "release" },
        },
      }),
    }),
  );
  expect((await denied.json()).error.code).toBe(-32602);
});

test("F08: the ingress refuses an assistant action carrying only the session UUID", async () => {
  const saved = config.assistantPermissions;
  restore = () => (config.assistantPermissions = saved);
  config.assistantPermissions = { ...saved, sessions: "allow" };
  const { deps, store } = setup();
  const interrupted: string[] = [];
  deps.service.interrupt = (async (id: string) => {
    interrupted.push(id);
  }) as never;
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 5));
  const assistant = assistantRow(store);
  const worker = workerRow(store);
  const call = (key?: string) =>
    makeAgentIngressApp({ ...deps, assistantIngress: signer }).fetch(
      new Request(`http://127.0.0.1/api/sessions/${assistant.id}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "x-shepherd-ingress-key": key } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "session_interrupt", arguments: { desig: worker.desig } },
        }),
      }),
    );
  expect((await call()).status).toBe(401);
  expect((await call("0".repeat(64))).status).toBe(401);
  expect((await call(signer.sign(worker.id))).status).toBe(401);
  expect(interrupted).toEqual([]);
  expect((await call(signer.sign(assistant.id))).status).toBe(200);
  expect(interrupted).toEqual([worker.id]);
  // #3337: a task session's ingress needs its own key too — the UUID alone is refused.
  const own = (key?: string) =>
    makeAgentIngressApp({ ...deps, assistantIngress: signer }).fetch(
      new Request(`http://127.0.0.1/api/sessions/${worker.id}`, {
        headers: key ? { "x-shepherd-ingress-key": key } : {},
      }),
    );
  expect((await own()).status).toBe(401);
  expect((await own(signer.sign(worker.id))).status).not.toBe(401);
});
