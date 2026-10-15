import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, Issue } from "../src/forge/types";
import type { HouseStack, HouseStackResolution } from "../src/house-stack";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-readiness-drift-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.70.0" } }),
  );
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function resolverFor(version: string | null): AppDeps["houseStackResolver"] {
  return {
    async resolve(stack: HouseStack): Promise<HouseStackResolution> {
      const name = stack.npm[0]!;
      if (!version) return { ok: false, errors: [{ ecosystem: "npm", name, reason: "timed out" }] };
      return {
        ok: true,
        resolvedAt: "2026-10-15T00:00:00.000Z",
        npm: [{ name, version }],
        crates: [],
        rustToolchain: null,
      };
    },
  };
}

function fakeForge(o: { fail?: boolean } = {}) {
  const issues: Issue[] = [];
  const labels: string[] = [];
  const forge = {
    kind: "github",
    isFork: false,
    listPullRequests: async () => [],
    listIssues: async () => issues,
    createIssue: async (i: { title: string; body: string }) => {
      if (o.fail) throw new Error("gh: HTTP 403 secret stderr");
      issues.push({ number: 7, url: "https://x/issues/7", body: i.body } as Issue);
      return { number: 7, url: "https://x/issues/7" };
    },
    addIssueLabel: async (_n: number, l: string) => {
      labels.push(l);
    },
  } as unknown as GitForge;
  return { forge, labels };
}

function deps(forge: GitForge | null, version: string | null = "3.0.1"): AppDeps {
  return {
    store: {
      getRepoConfig: () => ({ autoLabel: "shepherd:auto" }),
      getSetting: () => null,
      getEpicRun: () => ({ repoPath: repoDir, parentIssueNumber: 3114, status: "running" }),
    } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => forge,
    houseStackResolver: resolverFor(version),
  };
}

const url = (path: string, repo = repoDir) =>
  `http://localhost/api/readiness/drift${path}?repo=${encodeURIComponent(repo)}`;
const post = () => new Request(url("/story"), { method: "POST" });

test("GET: major behind → behind row, running epic, story available", async () => {
  const { forge } = fakeForge();
  const res = await makeApp(deps(forge)).fetch(new Request(url("")));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toMatchObject([
    { name: "@sveltejs/kit", installed: "2", target: "3", state: "behind" },
  ]);
  expect(body.runningEpic).toBe(3114);
  expect(body.canCreateStory).toBe(true);
  expect(body.openStory).toBeNull();
});

test("GET: offline resolver → unknown, no forge → no story", async () => {
  const res = await makeApp(deps(null, null)).fetch(new Request(url("")));
  const body = await res.json();
  expect(body.resolver).toBe("offline");
  expect(body.rows[0].state).toBe("unknown");
  expect(body.canCreateStory).toBe(false);
});

test("GET: invalid repo → 400", async () => {
  const res = await makeApp(deps(null)).fetch(new Request(url("", "/etc")));
  expect(res.status).toBe(400);
});

test("POST story: created with labels, then exists", async () => {
  const { forge, labels } = fakeForge();
  const app = makeApp(deps(forge));
  const first = await app.fetch(post());
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ status: "created", number: 7, url: "https://x/issues/7" });
  expect(labels).toEqual(["shepherd:auto", "shepherd:priority"]);
  expect((await (await app.fetch(post())).json()).status).toBe("exists");
});

test("POST story: no drift / no forge → 409", async () => {
  const { forge } = fakeForge();
  const upToDate = await makeApp(deps(forge, "2.99.0")).fetch(post());
  expect(upToDate.status).toBe(409);
  expect(await upToDate.json()).toEqual({ error: "no_drift" });
  const none = await makeApp(deps(null)).fetch(post());
  expect(await none.json()).toEqual({ error: "unsupported" });
});

test("POST story: forge failure → 502 with a generic body", async () => {
  const { forge } = fakeForge({ fail: true });
  const res = await makeApp(deps(forge)).fetch(post());
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "story_failed" });
});

test("GET on /story and POST on the read route are not routed", async () => {
  const app = makeApp(deps(null));
  expect((await app.fetch(new Request(url("/story")))).status).not.toBe(200);
  expect((await app.fetch(new Request(url(""), { method: "POST" }))).status).not.toBe(200);
});
