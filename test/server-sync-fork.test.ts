/**
 * Tests for POST /api/repos/sync-fork. The route resolves the repo's forge, rejects
 * non-fork repos (400), runs `forge.syncFork()` and classifies its failures, then
 * best-effort fast-forwards the local clone. The forge is injected via
 * deps.resolveForge so no real `gh` runs; the fast-forward against the temp dir
 * (not a git repo) fails silently — which is the point: the remote sync still
 * reports ok.
 *
 * The temp repo dir lives INSIDE config.repoRoot so safeRepoDir accepts it.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import type { GitForge } from "../src/forge/types";

const repoDir = mkdtempSync(join(config.repoRoot, ".sync-fork-test-"));
afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "github",
    slug: "dannymcc/may",
    mergeMethod: "squash",
    deployWorkflow: null,
    isFork: true,
    syncFork: async () => {},
    defaultBranch: async () => "main",
    ...over,
  } as unknown as GitForge;
}

function makeDeps(resolveForge?: (dir: string) => GitForge | null): AppDeps {
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
      start: async () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  const distiller = { distillNow: async () => {} };
  return { store, service, events, usageLimits, distiller, resolveForge } as AppDeps;
}

function postSync(app: ReturnType<typeof makeApp>, body: unknown): Promise<Response> {
  return app.fetch(
    new Request("http://x/api/repos/sync-fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/repos/sync-fork invalid repo → 400 invalid repo", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await postSync(app, { repo: "/definitely/outside/the/root" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid repo");
});

test("POST /api/repos/sync-fork on a non-fork repo → 400 syncfork_failed_not_fork", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ isFork: false })));
  const res = await postSync(app, { repo: repoDir });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("syncfork_failed_not_fork");
});

test("POST /api/repos/sync-fork happy path → 200 { ok:true }, syncFork invoked", async () => {
  let synced = false;
  const app = makeApp(makeDeps(() => fakeForge({ syncFork: async () => void (synced = true) })));
  const res = await postSync(app, { repo: repoDir });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(synced).toBe(true);
});

test("POST /api/repos/sync-fork diverged fork → 409 syncfork_failed_diverged", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        syncFork: async () => {
          throw new Error("can't sync because the branches have diverged");
        },
      }),
    ),
  );
  const res = await postSync(app, { repo: repoDir });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("syncfork_failed_diverged");
});
