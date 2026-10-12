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
  expect(await res.json()).toEqual({ available: true, reason: null, session: null });
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
  expect(emitted).toEqual([{ event: "operator-assistant:update", data: { session } }]);
  expect(emitted.some((e) => e.event === "session:new")).toBe(false);
});

test("POST /reset starts a new conversation and emits the update", async () => {
  const { app, emitted, calls } = setup();
  const res = await app.fetch(post("/api/operator-assistant/reset"));
  expect(res.status).toBe(200);
  const { session } = await res.json();
  expect(calls).toEqual(["reset"]);
  expect(emitted).toEqual([{ event: "operator-assistant:update", data: { session } }]);
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
    expect(get).toEqual({ available: false, reason, session: null });
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
