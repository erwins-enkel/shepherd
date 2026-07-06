import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";

type Spy = { event: string; data: unknown };

// Route-level harness for /variant + /experiments/:id/compare. The service methods are faked;
// these tests assert the routes' guard/validation/event behavior (the service logic itself is
// covered by the relaunch/create suites).
function harness(opts: {
  original?: Partial<Session> | null;
  startVariant?: (id: string, choice: unknown) => Promise<{ variant: Session; original: Session }>;
  startComparison?: (experimentId: string, choice: unknown) => Promise<Session>;
  replaceAgent?: (id: string, choice: unknown) => Promise<Session>;
  resolveForge?: AppDeps["resolveForge"];
}) {
  const emitted: Spy[] = [];
  const calls = {
    startVariant: [] as Array<{ id: string; choice: unknown }>,
    startComparison: [] as Array<{ experimentId: string; choice: unknown }>,
    replaceAgent: [] as Array<{ id: string; choice: unknown }>,
  };

  const originalSession =
    opts.original === null
      ? undefined
      : ({ id: "orig", repoPath: "/r", status: "running", ...opts.original } as unknown as Session);

  const store = {
    get: (id: string) => (id === "orig" ? originalSession : undefined),
  } as unknown as SessionStore;

  const service = {
    startVariant: async (id: string, choice: unknown) => {
      calls.startVariant.push({ id, choice });
      if (opts.startVariant) return opts.startVariant(id, choice);
      const variant = {
        id: "var",
        desig: "TASK-02",
        experimentId: "exp",
        experimentRole: "variant",
      } as unknown as Session;
      const original = {
        id: "orig",
        experimentId: "exp",
        experimentRole: "variant",
      } as unknown as Session;
      return { variant, original };
    },
    startComparison: async (experimentId: string, choice: unknown) => {
      calls.startComparison.push({ experimentId, choice });
      if (opts.startComparison) return opts.startComparison(experimentId, choice);
      return {
        id: "cmp",
        desig: "TASK-03",
        experimentId,
        experimentRole: "comparison",
      } as unknown as Session;
    },
    replaceAgent: async (id: string, choice: unknown) => {
      calls.replaceAgent.push({ id, choice });
      if (opts.replaceAgent) return opts.replaceAgent(id, choice);
      return {
        ...originalSession,
        id,
        agentProvider: "codex",
        model: "gpt-5.5",
        worktreePath: "/same-wt",
      } as unknown as Session;
    },
  } as unknown as SessionService;

  const events = {
    emit: (event: string, data: unknown) => emitted.push({ event, data }),
  } as unknown as EventHub;

  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: opts.resolveForge,
  } as unknown as AppDeps;

  return { app: makeApp(deps), emitted, calls };
}

function variantReq(
  id = "orig",
  body: unknown = { agentProvider: "claude", model: "opus" },
): Request {
  return new Request(`http://localhost/api/sessions/${id}/variant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function compareReq(experimentId = "exp", body: unknown = { model: "opus" }): Request {
  return new Request(`http://localhost/api/experiments/${experimentId}/compare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function replaceReq(
  id = "orig",
  body: unknown = { agentProvider: "codex", model: "gpt-5.5" },
): Request {
  return new Request(`http://localhost/api/sessions/${id}/replace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("variant: spawns, returns 201, emits session:new (variant) + session:experiment (original)", async () => {
  const h = harness({});
  const res = await h.app.fetch(variantReq());
  expect(res.status).toBe(201);
  const body = (await res.json()) as { session: { id: string } };
  expect(body.session.id).toBe("var");
  expect(h.calls.startVariant[0]).toEqual({
    id: "orig",
    choice: { agentProvider: "claude", model: "opus", effort: null },
  });
  expect(h.emitted.find((e) => e.event === "session:new")?.data).toMatchObject({ id: "var" });
  expect(h.emitted.find((e) => e.event === "session:experiment")?.data).toMatchObject({
    id: "orig",
    experimentId: "exp",
    experimentRole: "variant",
  });
});

test("variant: 404 when the original is missing", async () => {
  const h = harness({ original: null });
  const res = await h.app.fetch(variantReq("orig"));
  expect(res.status).toBe(404);
  expect(h.calls.startVariant).toHaveLength(0);
});

test("variant: 409 when the original is already archived", async () => {
  const h = harness({ original: { status: "archived" } });
  const res = await h.app.fetch(variantReq());
  expect(res.status).toBe(409);
  expect(h.calls.startVariant).toHaveLength(0);
});

test("variant: 400 on an invalid model/provider pair", async () => {
  const h = harness({});
  const res = await h.app.fetch(variantReq("orig", { agentProvider: "claude", model: "gpt-5.5" }));
  expect(res.status).toBe(400);
  expect(h.calls.startVariant).toHaveLength(0);
});

test("variant: threads a supplied effort tier through to the service (#1418)", async () => {
  const h = harness({});
  const res = await h.app.fetch(
    variantReq("orig", { agentProvider: "claude", model: "opus", effort: "high" }),
  );
  expect(res.status).toBe(201);
  expect(h.calls.startVariant[0]).toEqual({
    id: "orig",
    choice: { agentProvider: "claude", model: "opus", effort: "high" },
  });
});

test("variant: 400 on an invalid effort tier", async () => {
  const h = harness({});
  const res = await h.app.fetch(
    variantReq("orig", { agentProvider: "claude", model: "opus", effort: "bogus" }),
  );
  expect(res.status).toBe(400);
  expect(h.calls.startVariant).toHaveLength(0);
});

test("replace: updates the existing session and emits no new/archive events", async () => {
  const h = harness({ original: { worktreePath: "/same-wt", agentProvider: "claude" } });
  const res = await h.app.fetch(replaceReq());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { session: Session };
  expect(body.session.id).toBe("orig");
  expect(body.session.worktreePath).toBe("/same-wt");
  expect(h.calls.replaceAgent[0]).toEqual({
    id: "orig",
    choice: { agentProvider: "codex", model: "gpt-5.5", handoffMode: "resume", effort: null },
  });
  expect(h.emitted.map((e) => e.event)).toEqual(["session:status"]);
  expect(h.emitted[0]?.data).toMatchObject({
    id: "orig",
    status: "running",
    worktreePath: "/same-wt",
    agentProvider: "codex",
  });
});

test("replace: 400 on an invalid model/provider pair", async () => {
  const h = harness({});
  const res = await h.app.fetch(replaceReq("orig", { agentProvider: "claude", model: "gpt-5.5" }));
  expect(res.status).toBe(400);
  expect(h.calls.replaceAgent).toHaveLength(0);
});

test("replace: 400 on an invalid handoff mode", async () => {
  const h = harness({});
  const res = await h.app.fetch(
    replaceReq("orig", { agentProvider: "codex", model: "gpt-5.5", handoffMode: "start" }),
  );
  expect(res.status).toBe(400);
  expect(h.calls.replaceAgent).toHaveLength(0);
});

test("replace: threads a supplied effort tier through to the service (#1418)", async () => {
  const h = harness({ original: { worktreePath: "/same-wt", agentProvider: "claude" } });
  const res = await h.app.fetch(
    replaceReq("orig", { agentProvider: "codex", model: "gpt-5.5", effort: "high" }),
  );
  expect(res.status).toBe(200);
  expect(h.calls.replaceAgent[0]).toEqual({
    id: "orig",
    choice: { agentProvider: "codex", model: "gpt-5.5", handoffMode: "resume", effort: "high" },
  });
});

test("replace: issue-linked session re-resolves issue context before service call", async () => {
  const h = harness({
    original: {
      repoPath: "/r",
      issueNumber: 225,
      worktreePath: "/same-wt",
      agentProvider: "claude",
    },
    resolveForge: () =>
      ({
        getIssue: async (number: number) => ({
          number,
          title: "Child task",
          body: "Full body",
          url: "https://example/225",
          labels: [],
          createdAt: 0,
          assignees: [],
        }),
      }) as never,
  });
  const res = await h.app.fetch(replaceReq());
  expect(res.status).toBe(200);
  expect(h.calls.replaceAgent[0]).toEqual({
    id: "orig",
    choice: {
      agentProvider: "codex",
      model: "gpt-5.5",
      handoffMode: "resume",
      effort: null,
      issueRef: {
        number: 225,
        title: "Child task",
        body: "Full body",
        url: "https://example/225",
      },
    },
  });
});

test("replace: unresolved issue returns issue_unresolved before service mutation", async () => {
  const h = harness({
    original: {
      repoPath: "/r",
      issueNumber: 225,
      worktreePath: "/same-wt",
      agentProvider: "claude",
    },
    resolveForge: () => ({ getIssue: async () => null }) as never,
  });
  const res = await h.app.fetch(replaceReq());
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ code: "issue_unresolved" });
  expect(h.calls.replaceAgent).toHaveLength(0);
});

test("compare: spawns, returns 201 and emits session:new", async () => {
  const h = harness({});
  const res = await h.app.fetch(compareReq());
  expect(res.status).toBe(201);
  const body = (await res.json()) as { session: { id: string } };
  expect(body.session.id).toBe("cmp");
  expect(h.calls.startComparison[0]).toEqual({
    experimentId: "exp",
    choice: { model: "opus", effort: null },
  });
  expect(h.emitted.find((e) => e.event === "session:new")?.data).toMatchObject({ id: "cmp" });
});

test("compare: threads a supplied effort tier through to the service (#1418)", async () => {
  const h = harness({});
  const res = await h.app.fetch(compareReq("exp", { model: "opus", effort: "high" }));
  expect(res.status).toBe(201);
  expect(h.calls.startComparison[0]).toEqual({
    experimentId: "exp",
    choice: { model: "opus", effort: "high" },
  });
});

test("compare: 502 when the service rejects (e.g. too few variants)", async () => {
  const h = harness({
    startComparison: async () => {
      throw new Error("experiment exp needs at least 2 variants to compare");
    },
  });
  const res = await h.app.fetch(compareReq());
  expect(res.status).toBe(502);
});
