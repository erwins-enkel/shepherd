import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

// #4232: GET /api/postgres/repos lists the repos with on-demand Postgres switched on
// (postgresMode on-request); a repo switched back off drops out.

let repoA: string;
let repoB: string;
let store: SessionStore;

beforeEach(() => {
  // Direct children of the repo root, so listRepos enumerates them.
  repoA = mkdtempSync(join(config.repoRoot, "shepherd-postgres-repos-a-"));
  repoB = mkdtempSync(join(config.repoRoot, "shepherd-postgres-repos-b-"));
  store = new SessionStore(":memory:");
});
afterEach(() => {
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
});

function app() {
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => null,
  };
  return makeApp(deps);
}

async function put(repo: string, body: unknown): Promise<void> {
  const res = await app().fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repo)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
}

type Row = { repoPath: string; name: string };

async function list(): Promise<Row[]> {
  const res = await app().fetch(new Request("http://x/api/postgres/repos"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { repos: Row[] }).repos;
}

test("a repo switched to on-request is listed; switched off it drops out", async () => {
  await put(repoA, { maxAuto: 2 }); // a config row that keeps Postgres off
  expect(await list()).toEqual([]);

  await put(repoA, { postgresMode: "on-request" });
  expect(await list()).toEqual([{ repoPath: realpathSync(repoA), name: basename(repoA) }]);

  await put(repoA, { postgresMode: "off" });
  expect(await list()).toEqual([]);
});

test("rows are sorted by name", async () => {
  await put(repoB, { postgresMode: "on-request" });
  await put(repoA, { postgresMode: "on-request" });
  expect((await list()).map((r) => r.name)).toEqual([basename(repoA), basename(repoB)]);
});

test("a stored row for a repo no longer under the repo root is omitted", async () => {
  const cfg = store.getRepoConfig("/gone/repo");
  store.setRepoConfig("/gone/repo", { ...cfg, postgresMode: "on-request" });
  expect([...store.postgresRepoPaths()]).toEqual(["/gone/repo"]);
  expect(await list()).toEqual([]);
});

test("a non-GET request is not answered with the list", async () => {
  await put(repoA, { postgresMode: "on-request" });
  const res = await app().fetch(new Request("http://x/api/postgres/repos", { method: "POST" }));
  expect(res.status).toBe(404);
});
