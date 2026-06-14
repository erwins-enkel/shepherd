/**
 * Tests for POST /api/repos/fork route. Mirrors test/server-projects.test.ts.
 * Route-level tests own the 415/400/201-shape contract; the deeper error mapping
 * (auth/exists/url) is owned by forkRepo in test/repos.test.ts.
 *
 * A recording gh runner is injected via deps.newProjectGhRunner so no real `gh`
 * fork is performed; the happy path resolves to a 201 without touching the network
 * or the filesystem.
 */
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import type { GhRunner } from "../src/repos";

function makeDeps(ghRunner?: GhRunner): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
      stop: () => {},
      send: () => {},
    } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
  };
  const distiller = { distillNow: () => {} };
  return { store, service, events, usageLimits, distiller, newProjectGhRunner: ghRunner };
}

function postFork(
  app: ReturnType<typeof makeApp>,
  body: unknown,
  headers?: HeadersInit,
): Promise<Response> {
  return app.fetch(
    new Request("http://x/api/repos/fork", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/repos/fork missing Content-Type → 415", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/repos/fork", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ target: "dannymcc/may" }),
    }),
  );
  expect(res.status).toBe(415);
});

test("POST /api/repos/fork invalid target → 400 forkrepo_failed_url", async () => {
  const app = makeApp(makeDeps());
  const res = await postFork(app, { target: "just-a-repo" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("forkrepo_failed_url");
});

test("POST /api/repos/fork happy path → 201 + RepoEntry, runs gh fork", async () => {
  const calls: string[][] = [];
  const ghRunner: GhRunner = async (args) => {
    calls.push(args);
  };
  const app = makeApp(makeDeps(ghRunner));
  // Unique name so the existence guard never collides with a real repoRoot entry.
  const name = `forktest-${process.pid}-${Date.now()}`;
  const res = await postFork(app, { target: `dannymcc/${name}` });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.name).toBe(name);
  expect(typeof body.path).toBe("string");
  // auth status + repo fork were invoked through the injected runner
  expect(calls[0]).toEqual(["auth", "status"]);
  expect(calls[1]?.slice(0, 4)).toEqual(["repo", "fork", `dannymcc/${name}`, "--clone"]);
});
