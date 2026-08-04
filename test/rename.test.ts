import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeMgr } from "../src/worktree";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { makeApp, type AppDeps } from "../src/server";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { PrCache } from "../src/pr-poller";

const ORIGIN = "http://localhost";

// ── WorktreeMgr.renameBranch / branchExists ────────────────────────────────
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shepherd-rn-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("renameBranch moves a branch checked out in a worktree", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "old-name");
  expect(r.branch).toBe("shepherd/old-name");
  expect(wt.branchExists(repo, "shepherd/old-name")).toBe(true);

  wt.renameBranch(repo, "shepherd/old-name", "shepherd/new-name");

  expect(wt.branchExists(repo, "shepherd/new-name")).toBe(true);
  expect(wt.branchExists(repo, "shepherd/old-name")).toBe(false);
  const list = execFileSync("git", ["branch", "--list", "shepherd/*"], { cwd: repo }).toString();
  expect(list).toContain("shepherd/new-name");
  expect(list).not.toContain("shepherd/old-name");
});

test("renameBranch throws when the target name already exists", () => {
  const wt = new WorktreeMgr();
  wt.create(repo, "main", "a");
  wt.create(repo, "main", "b");
  expect(() => wt.renameBranch(repo, "shepherd/a", "shepherd/b")).toThrow();
});

// ── SessionService.rename ──────────────────────────────────────────────────
function makeService(store: SessionStore, wtLog: string[]) {
  return new SessionService({
    store,
    namer: () => "x",
    herdr: {
      list: () => [],
      start: async () => ({}) as never,
      stop: async () => {},
      send: () => {},
    } as never,
    worktree: {
      create: () => ({}) as never,
      remove: () => {},
      branchExists: () => false,
      renameBranch: (r: string, o: string, n: string) => wtLog.push(`${o}->${n}`),
    } as never,
  });
}

function seed(store: SessionStore) {
  return store.create({
    name: "old-name",
    prompt: "p",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/old-name",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a1",
  });
}

test("service.rename updates name + branch and runs git rename when renameLocalBranch", () => {
  const store = new SessionStore(":memory:");
  const wtLog: string[] = [];
  const svc = makeService(store, wtLog);
  const s = seed(store);

  const out = svc.rename(s.id, "new-name", { renameLocalBranch: true });

  expect(out?.name).toBe("new-name");
  expect(out?.branch).toBe("shepherd/new-name");
  expect(wtLog).toEqual(["shepherd/old-name->shepherd/new-name"]);
});

test("service.rename keeps the branch (display-only) when renameLocalBranch is false", () => {
  const store = new SessionStore(":memory:");
  const wtLog: string[] = [];
  const svc = makeService(store, wtLog);
  const s = seed(store);

  const out = svc.rename(s.id, "new-name", { renameLocalBranch: false });

  expect(out?.name).toBe("new-name");
  expect(out?.branch).toBe("shepherd/old-name"); // untouched
  expect(wtLog).toEqual([]); // no git branch -m
});

test("service.rename returns null for an unknown id", () => {
  const store = new SessionStore(":memory:");
  const svc = makeService(store, []);
  expect(svc.rename("nope", "x", { renameLocalBranch: true })).toBeNull();
});

// ── POST /api/sessions/:id/rename ──────────────────────────────────────────
function fakeForge(over: Partial<GitForge> = {}): GitForge {
  const base: GitForge = {
    kind: "gitea",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return Object.assign(base, over);
}

type RenameDeps = AppDeps & {
  emitted: { event: string; data: unknown }[];
  cacheWrites: string[];
  _wtLog: string[];
  _prStatusCalls: string[];
  _sessionId: string;
};

function makeDeps(opts: {
  forge?: GitForge | null;
  /** Seed the poller cache with this PR state (no entry when absent). */
  cached?: "open" | "none";
  branchExists?: boolean;
}): RenameDeps {
  const store = new SessionStore(":memory:");
  const s = seed(store);
  const wtLog: string[] = [];
  const service = new SessionService({
    store,
    namer: () => "x",
    herdr: {
      list: () => [],
      start: async () => ({}) as never,
      stop: async () => {},
      send: () => {},
    } as never,
    worktree: {
      create: () => ({}) as never,
      remove: () => {},
      branchExists: () => opts.branchExists ?? false,
      renameBranch: (r: string, o: string, n: string) => wtLog.push(`${o}->${n}`),
    } as never,
  });
  const emitted: { event: string; data: unknown }[] = [];
  const cacheWrites: string[] = [];
  const snap: Record<string, GitState> = {};
  if (opts.cached) {
    snap[s.id] = { kind: "github", state: opts.cached, checks: "none", deployConfigured: false };
  }
  const prCache: PrCache = {
    snapshot: () => snap,
    get: (id) => snap[id],
    set: (id) => cacheWrites.push(id),
    drop: (id) => cacheWrites.push(`drop:${id}`),
  };
  // Record every live PR lookup so a test can assert the forge was (or wasn't) consulted.
  const prStatusCalls: string[] = [];
  const inner = opts.forge;
  const forge: GitForge | null = inner
    ? {
        ...inner,
        prStatus: (b: string) => {
          prStatusCalls.push(b);
          return inner.prStatus(b);
        },
      }
    : null;
  return Object.assign(
    {
      store,
      service,
      events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as never,
      usageLimits: { limits: () => ({}) } as never,
      resolveForge: () => forge,
      prCache,
    } as AppDeps,
    { emitted, cacheWrites, _wtLog: wtLog, _prStatusCalls: prStatusCalls, _sessionId: s.id },
  );
}

function post(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("rename → 400 on empty/blank name", async () => {
  const app = makeApp(makeDeps({}));
  expect((await app.fetch(post("/api/sessions/s1/rename", { name: "   " }))).status).toBe(400);
});

test("rename → 404 on unknown id", async () => {
  const app = makeApp(makeDeps({}));
  const res = await app.fetch(post("/api/sessions/does-not-exist/rename", { name: "x" }));
  expect(res.status).toBe(404);
});

test("rename → 409 when the target branch already exists", async () => {
  const deps = makeDeps({ branchExists: true });
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${deps._sessionId}/rename`, { name: "taken" }));
  expect(res.status).toBe(409);
});

test("a taken branch name doesn't block a display-only rename", async () => {
  const deps = makeDeps({ forge: fakeForge(), cached: "open", branchExists: true });
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${deps._sessionId}/rename`, { name: "taken" }));
  expect(res.status).toBe(200); // no branch moves → nothing to collide with
  const body = await res.json();
  expect(body.session.name).toBe("taken");
  expect(body.branchRenamed).toBe(false);
});

test("rename with no forge renames the local branch + emits session:renamed", async () => {
  const deps = makeDeps({ forge: null });
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "Fresh Name" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.branchRenamed).toBe(true);
  expect(body.session.name).toBe("fresh-name");
  expect(body.session.branch).toBe("shepherd/fresh-name");
  expect(deps._wtLog).toEqual(["shepherd/old-name->shepherd/fresh-name"]);
  expect(deps.cacheWrites).toContain(`drop:${id}`);
  expect(deps.emitted.find((e) => e.event === "session:renamed")).toBeTruthy();
});

// #1927: GitHub's branch-rename API CLOSES a PR that uses the branch as its head, so an
// open PR must pin the branch on every host — no remote rename, no `git branch -m`.
test("cached open PR on GitHub → display-only rename, branch kept", async () => {
  const deps = makeDeps({ forge: fakeForge({ kind: "github" }), cached: "open" });
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "renamed" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.branchRenamed).toBe(false);
  expect(body.session.name).toBe("renamed");
  expect(body.session.branch).toBe("shepherd/old-name"); // PR branch untouched
  expect(deps._wtLog).toEqual([]); // no git branch -m
  expect(deps._prStatusCalls).toEqual([]); // cached "open" is trusted as-is
  expect(deps.cacheWrites).toEqual([]); // still-valid PR state survives the rename
});

test("cached open PR on Gitea → display-only rename, branch kept", async () => {
  const deps = makeDeps({ forge: fakeForge(), cached: "open" });
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "renamed" }));
  const body = await res.json();
  expect(body.branchRenamed).toBe(false);
  expect(body.session.branch).toBe("shepherd/old-name");
  expect(deps._wtLog).toEqual([]);
});

test("cache miss + forge reports an open PR → display-only rename", async () => {
  const deps = makeDeps({ forge: fakeForge({ kind: "github" }) }); // fakeForge.prStatus → open
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "renamed" }));
  const body = await res.json();
  expect(body.branchRenamed).toBe(false);
  expect(body.session.branch).toBe("shepherd/old-name");
  expect(deps._wtLog).toEqual([]);
  expect(deps._prStatusCalls).toEqual(["shepherd/old-name"]);
});

// The poller can still hold a "none" from before the agent opened the PR.
test("stale cached none + forge reports an open PR → display-only rename", async () => {
  const deps = makeDeps({ forge: fakeForge({ kind: "github" }), cached: "none" });
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "renamed" }));
  expect((await res.json()).branchRenamed).toBe(false);
  expect(deps._wtLog).toEqual([]);
  expect(deps._prStatusCalls).toEqual(["shepherd/old-name"]);
});

test("cache miss + forge lookup throws → assume open, branch kept", async () => {
  const forge = fakeForge({
    kind: "github",
    prStatus: async () => {
      throw new Error("gh exploded");
    },
  });
  const deps = makeDeps({ forge });
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "renamed" }));
  expect(res.status).toBe(200);
  expect((await res.json()).branchRenamed).toBe(false);
  expect(deps._wtLog).toEqual([]);
});

test("cached none confirmed by the forge → local branch renamed", async () => {
  const forge = fakeForge({
    kind: "github",
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
  });
  const deps = makeDeps({ forge, cached: "none" });
  const id = deps._sessionId;
  const app = makeApp(deps);
  const res = await app.fetch(post(`/api/sessions/${id}/rename`, { name: "renamed" }));
  const body = await res.json();
  expect(body.branchRenamed).toBe(true);
  expect(body.session.branch).toBe("shepherd/renamed");
  expect(deps._wtLog).toEqual(["shepherd/old-name->shepherd/renamed"]);
  expect(deps.cacheWrites).toContain(`drop:${id}`); // moved branch → cached state is stale
});
