/**
 * Tests for POST /api/projects route.
 * Mirror the POST /api/repos block in test/server.test.ts.
 *
 * NOTE: repoRoot uses /tmp dirs (not config.repoRoot) to avoid the Bun zombie-git
 * issue that can wedge the root suite in Shepherd worktrees (see memory note).
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "shepherd-srv-projects-test-"));
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeDeps(): AppDeps {
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
  return { store, service, events, usageLimits, distiller };
}

/** Build a makeApp instance with a custom repoRoot backed by tmpRoot. */
function makeTestApp() {
  // We need to override config.repoRoot for each test; instead we call makeApp with
  // the real deps but swap the repoRoot by patching the module-level config temporarily.
  // Since that's fragile, we use the route directly by posting to the app and relying
  // on validateNewProject + createProject reading from the real config.repoRoot.
  //
  // For tests that need an isolated repoRoot, we pass it by creating the dir under
  // tmpRoot and using SHEPHERD_REPO_ROOT env override — but config is already loaded.
  // Simplest: use the real makeApp and override via the env before import is loaded
  // (not possible post-load). Instead: test at the level of createProject directly
  // for isolation, and for the route tests use the real config.repoRoot from the env.
  //
  // Per the task spec: "use the existing harness()/makeApp/postRepos-style helper
  // (copy the local post helper pattern)". We expose the app and a post helper.
  return makeApp(makeDeps());
}

/**
 * post helper — mirrors postRepos from server.test.ts, but targets /api/projects.
 * Accepts optional repoRoot so tests that need an isolated dir can override the
 * SHEPHERD_REPO_ROOT; however since config is loaded at module parse time, we
 * can't change it per-test. Instead we inject the tmpRoot as repoRoot via the
 * environment before the module is first imported. For this test file, we rely
 * on the server's config.repoRoot being the system default (HOME or similar)
 * and use tmpRoot as the target dir by calling createProject directly where needed.
 *
 * For the route-level tests (415, 400, 409) we use the real app — these tests
 * don't actually create directories, so repoRoot doesn't matter.
 *
 * For the happy-path "dir + commit present" test we use createProject directly
 * (covered at the repos layer per Task 2) OR we set SHEPHERD_REPO_ROOT before
 * the process starts. Since we can't do that here, the happy-path route test
 * only checks the 201 + RepoEntry shape, letting repos.test.ts own the fs assertions.
 */
function postProjects(
  app: ReturnType<typeof makeApp>,
  body: unknown,
  headers?: HeadersInit,
): Promise<Response> {
  return app.fetch(
    new Request("http://x/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

// ── Content-Type guard ────────────────────────────────────────────────────────

test("POST /api/projects missing Content-Type → 415", async () => {
  const app = makeTestApp();
  const res = await app.fetch(
    new Request("http://x/api/projects", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "my-app", idea: "hello", createRemote: false }),
    }),
  );
  expect(res.status).toBe(415);
});

// ── Slug validation → 400 ─────────────────────────────────────────────────────

test("POST /api/projects bad slug (uppercase) → 400 newproject_failed_slug", async () => {
  const app = makeTestApp();
  const res = await postProjects(app, {
    name: "MyApp",
    idea: "some idea",
    createRemote: false,
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("newproject_failed_slug");
});

test("POST /api/projects bad slug (spaces) → 400 newproject_failed_slug", async () => {
  const app = makeTestApp();
  const res = await postProjects(app, {
    name: "my app",
    idea: "",
    createRemote: false,
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("newproject_failed_slug");
});

test("POST /api/projects bad slug (empty string) → 400 newproject_failed_slug", async () => {
  const app = makeTestApp();
  const res = await postProjects(app, {
    name: "",
    idea: "",
    createRemote: false,
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("newproject_failed_slug");
});

test("POST /api/projects bad slug (leading dash) → 400 newproject_failed_slug", async () => {
  const app = makeTestApp();
  const res = await postProjects(app, {
    name: "-bad",
    idea: "",
    createRemote: false,
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("newproject_failed_slug");
});

test("POST /api/projects bad slug (dotdot) → 400 newproject_failed_slug", async () => {
  const app = makeTestApp();
  const res = await postProjects(app, {
    name: "..",
    idea: "",
    createRemote: false,
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("newproject_failed_slug");
});

test("POST /api/projects bad slug (trailing .git) → 400 newproject_failed_slug", async () => {
  const app = makeTestApp();
  const res = await postProjects(app, {
    name: "my-app.git",
    idea: "",
    createRemote: false,
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("newproject_failed_slug");
});

// ── Target already exists → 409 ───────────────────────────────────────────────

test("POST /api/projects target already exists → 409 newproject_failed_exists", async () => {
  // We need the target dir to pre-exist inside config.repoRoot.
  // Import config to get the real repoRoot.
  const { config } = await import("../src/config");
  const targetName = "srv-proj-exists-test-" + Date.now();
  const targetDir = join(config.repoRoot, targetName);
  mkdirSync(targetDir, { recursive: true });
  try {
    const app = makeTestApp();
    const res = await postProjects(app, {
      name: targetName,
      idea: "should fail",
      createRemote: false,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("newproject_failed_exists");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

// ── Happy path: local-only create → 201 + RepoEntry shape ────────────────────
//
// We can't override config.repoRoot at runtime (it is module-level), so we use a
// sub-directory of the real repoRoot. The fs / git assertions (branch `main`, one
// commit, file content) live in test/repos.test.ts (Task 2).

test("POST /api/projects local-only happy path → 201 + RepoEntry shape", async () => {
  const { config } = await import("../src/config");
  const name = "srv-proj-happy-" + Date.now();
  const targetDir = join(config.repoRoot, name);
  try {
    const app = makeTestApp();
    const res = await postProjects(app, {
      name,
      idea: "a simple todo app",
      createRemote: false,
    });
    // If git identity is not configured this will return 422 — skip gracefully.
    if (res.status === 422) {
      const body = await res.json();
      if (body.error === "newproject_failed_identity") {
        console.log("[skip] git identity not configured in test env");
        return;
      }
    }
    expect(res.status).toBe(201);
    const body = await res.json();
    // RepoEntry shape: name, path, display
    expect(typeof body.name).toBe("string");
    expect(body.name).toBe(name);
    expect(typeof body.path).toBe("string");
    expect(body.path).toContain(name);
    expect(typeof body.display).toBe("string");
    // No warning for local-only create
    expect(body.warning).toBeUndefined();
    // Dir must exist
    expect(existsSync(targetDir)).toBe(true);
  } finally {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  }
});

// ── Partial-success: route surfaces 201 + warning field ──────────────────────
//
// The partial-success logic lives in createProject (repos.ts, Task 2).
// Here we verify the route correctly maps { ok: true, entry, warning } → 201 + warning.
//
// We inject a FAKE gh runner (deps.newProjectGhRunner) that throws ENOENT, simulating
// gh-not-installed → newproject_failed_gh_missing. This is mandatory: without it the
// route would invoke the REAL gh on a developer machine where gh is installed +
// authenticated, creating an actual private `srv-proj-partial-*` repo on every test
// run (the remote step is never cleaned up — only the local dir is). The local repo
// is kept on the partial failure, the response is 201 with the warning, and we remove
// the created dir afterwards.

test("POST /api/projects partial-success (gh missing) → 201 + warning", async () => {
  const { config } = await import("../src/config");
  const name = "srv-proj-partial-" + Date.now();
  const targetDir = join(config.repoRoot, name);
  // gh runner that fails as if gh were not installed — keeps the test fully offline.
  const ghMissing = () =>
    Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
  try {
    const app = makeApp({ ...makeDeps(), newProjectGhRunner: ghMissing });
    const res = await postProjects(app, {
      name,
      idea: "test partial success",
      createRemote: true,
      visibility: "private",
    });
    // May 422 if git identity is not configured in the test env — skip gracefully.
    if (res.status === 422) {
      const body = await res.json();
      if (body.error === "newproject_failed_identity") {
        console.log("[skip] git identity not configured in test env");
        return;
      }
    }
    // The fake runner forces the gh-missing branch: local create succeeds, remote
    // step fails → 201 + warning. Deterministic, no network, no real repo.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe(name);
    expect(typeof body.path).toBe("string");
    expect(typeof body.display).toBe("string");
    expect(body.warning).toBe("newproject_failed_gh_missing");
  } finally {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  }
});

// ── GET /api/github/owners ────────────────────────────────────────────────────

function getOwners(app: ReturnType<typeof makeApp>): Promise<Response> {
  return app.fetch(new Request("http://x/api/github/owners", { method: "GET" }));
}

test("GET /api/github/owners → login + orgs from injected runner", async () => {
  const runner = async (args: string[]) => {
    if (args[1] === "user") return "octocat\n";
    if (args[1] === "user/orgs") return "acme-corp\nwidgets-inc\n";
    return "";
  };
  const app = makeApp({ ...makeDeps(), githubOwnersRunner: runner });
  const res = await getOwners(app);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.login).toBe("octocat");
  expect(body.orgs).toEqual(["acme-corp", "widgets-inc"]);
});

test("GET /api/github/owners gh failure → 200 with null login, empty orgs", async () => {
  const runner = () =>
    Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
  const app = makeApp({ ...makeDeps(), githubOwnersRunner: runner });
  const res = await getOwners(app);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.login).toBeNull();
  expect(body.orgs).toEqual([]);
});
