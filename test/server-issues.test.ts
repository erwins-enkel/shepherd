import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, Issue } from "../src/forge/types";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-issues-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const ISSUE: Issue = { number: 1, title: "Bug", body: "boom", url: "u1", labels: ["bug"] };

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "gitea",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [ISSUE],
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
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
  expect(await res.json()).toEqual({ slug: null, issues: [] });
});

test("GET /api/issues swallows forge errors → {slug, issues:[]}", async () => {
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
  expect(await res.json()).toEqual({ slug: "team/proj", issues: [] });
});

test("GET /api/issues?repo outside root → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(req("/etc"));
  expect(res.status).toBe(400);
});
