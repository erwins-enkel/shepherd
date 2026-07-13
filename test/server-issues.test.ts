import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, Issue } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-issues-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const ISSUE: Issue = {
  number: 1,
  title: "Bug",
  body: "boom",
  url: "u1",
  labels: ["bug"],
  createdAt: 1_700_000_000_000,
  assignees: [],
};

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "gitea",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [ISSUE],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
    ...over,
  };
}

function makeDeps(resolveForge: AppDeps["resolveForge"]): AppDeps {
  return {
    store: {} as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge,
  };
}

function req(repo: string): Request {
  return new Request(`http://localhost/api/issues?repo=${encodeURIComponent(repo)}`);
}

function repoWebReq(repo: string): Request {
  return new Request(`http://localhost/api/repo-web?repo=${encodeURIComponent(repo)}`);
}

test("GET /api/repo-web resolves lightweight forge link metadata", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({ kind: "github", webUrl: "https://github.com/team/proj" } as Partial<GitForge>),
    ),
  );
  const res = await app.fetch(repoWebReq(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    slug: "team/proj",
    webUrl: "https://github.com/team/proj",
    kind: "github",
  });
});

test("GET /api/repo-web?repo outside root → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(repoWebReq("/etc"));
  expect(res.status).toBe(400);
});

test("GET /api/issues resolves via the forge → {slug, issues}", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.slug).toBe("team/proj");
  expect(body.issues).toEqual([ISSUE]);
});

test("GET /api/issues with no forge for repo → {slug:null, issues:[]}", async () => {
  const app = makeApp(makeDeps(() => null));
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: null, webUrl: null, issues: [], viewer: null });
});

test("GET /api/issues flags forge errors → {slug, issues:[], error}", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listIssues: async () => {
          throw new Error("gh not authed");
        },
      }),
    ),
  );
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  // Empty issues but error set, so the UI can say "couldn't load" instead of
  // the indistinguishable "no open issues" (e.g. a rate-limited forge).
  expect(await res.json()).toEqual({
    slug: "team/proj",
    webUrl: null,
    issues: [],
    viewer: null,
    error: "fetch_failed",
  });
});

test("GET /api/issues includes the operator login as viewer (#824)", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ currentUser: async () => "octocat" })));
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  expect((await res.json()).viewer).toBe("octocat");
});

test("GET /api/issues viewer is null when the forge cannot resolve a user", async () => {
  // fakeForge has no currentUser → forge.currentUser?.() is undefined → fail open.
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(req(repoDir));
  expect((await res.json()).viewer).toBeNull();
});

test("GET /api/issues includes forge webUrl in response", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ webUrl: "https://github.com/team/proj" })));
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  expect((await res.json()).webUrl).toBe("https://github.com/team/proj");
});

test("GET /api/issues?repo outside root → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(req("/etc"));
  expect(res.status).toBe(400);
});

// ── blockedBy merge (listBlockedByOpen) ───────────────────────────────────

test("GET /api/issues merges blockedBy onto matching issues", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listBlockedByOpen: async () => new Map([[1, [42, 43]]]),
      }),
    ),
  );
  const res = await app.fetch(req(repoDir));
  const body = await res.json();
  expect(body.issues).toEqual([{ ...ISSUE, blockedBy: [42, 43] }]);
});

test("GET /api/issues leaves blockedBy unset for issues absent from the blocked map", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listBlockedByOpen: async () => new Map([[999, [1]]]),
      }),
    ),
  );
  const res = await app.fetch(req(repoDir));
  const body = await res.json();
  expect(body.issues).toEqual([ISSUE]);
});

test("GET /api/issues without listBlockedByOpen (optional) → issues returned unmodified", async () => {
  const app = makeApp(makeDeps(() => fakeForge())); // fakeForge has no listBlockedByOpen
  const res = await app.fetch(req(repoDir));
  const body = await res.json();
  expect(body.issues).toEqual([ISSUE]);
});

test("GET /api/issues: a failing listBlockedByOpen fails open — issues still return", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listBlockedByOpen: async () => {
          throw new Error("dependency query failed");
        },
      }),
    ),
  );
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.issues).toEqual([ISSUE]);
  expect(body.error).toBeUndefined();
});

// ── POST /api/issues (handleIssueCreate) ─────────────────────────────────────

function postIssue(
  app: ReturnType<typeof makeApp>,
  body: unknown,
  headers?: HeadersInit,
): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/api/issues", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/issues 201 happy path returns number, url, slug", async () => {
  const created = { number: 7, url: "https://github.com/o/r/issues/7" };
  const forge = fakeForge({ slug: "o/r", createIssue: async () => created });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await postIssue(app, { repo: repoDir, title: "Hello", body: "world" });
  expect(res.status).toBe(201);
  const out = await res.json();
  expect(out.number).toBe(7);
  expect(out.url).toBe(created.url);
  expect(out.slug).toBe("o/r");
});

test("POST /api/issues passes trimmed title + body to the forge", async () => {
  const calls: { title: string; body: string }[] = [];
  const forge = fakeForge({
    createIssue: async (o) => {
      calls.push(o);
      return { number: 1, url: "u" };
    },
  });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  await postIssue(app, { repo: repoDir, title: "  spaced  ", body: "ctx" });
  expect(calls[0]).toEqual({ title: "spaced", body: "ctx" });
});

test("POST /api/issues out-of-root repo → 400 invalid repo", async () => {
  const forge = fakeForge({ createIssue: async () => ({ number: 1, url: "u" }) });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await postIssue(app, { repo: "/etc/passwd", title: "x", body: "" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid repo");
});

test("POST /api/issues unknown repo (resolveForge null) → 400", async () => {
  const app = makeApp(makeDeps(() => null));
  const res = await postIssue(app, { repo: repoDir, title: "x", body: "" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("issues unavailable for repo");
});

test("POST /api/issues blank title → 400", async () => {
  const forge = fakeForge({ createIssue: async () => ({ number: 1, url: "u" }) });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await postIssue(app, { repo: repoDir, title: "   ", body: "" });
  expect(res.status).toBe(400);
});

test("POST /api/issues missing title → 400", async () => {
  const forge = fakeForge({ createIssue: async () => ({ number: 1, url: "u" }) });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await postIssue(app, { repo: repoDir, body: "" });
  expect(res.status).toBe(400);
});

test("POST /api/issues forge without createIssue → 400", async () => {
  const forge = fakeForge(); // no createIssue
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await postIssue(app, { repo: repoDir, title: "x", body: "" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("issues unavailable for repo");
});

test("POST /api/issues createIssue throws → 502 with message", async () => {
  const forge = fakeForge({
    createIssue: async () => {
      throw new Error("boom");
    },
  });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await postIssue(app, { repo: repoDir, title: "x", body: "" });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("boom");
});

test("POST /api/issues without JSON content type → 415", async () => {
  const forge = fakeForge({ createIssue: async () => ({ number: 1, url: "u" }) });
  const app = makeApp(makeDeps((p) => (p === repoDir ? forge : null)));
  const res = await app.fetch(
    new Request("http://localhost/api/issues", { method: "POST", body: "{}" }),
  );
  expect(res.status).toBe(415);
});
