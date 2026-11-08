import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

// #3447: GET /api/repo-run-defaults lists the repos whose coding CLI, model, effort or execution
// effort is their own; a repo set back to inherit drops out.

let repoA: string;
let repoB: string;
let store: SessionStore;

beforeEach(() => {
  // Direct children of the repo root, so listRepos enumerates them.
  repoA = mkdtempSync(join(config.repoRoot, "shepherd-run-defaults-a-"));
  repoB = mkdtempSync(join(config.repoRoot, "shepherd-run-defaults-b-"));
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

type Row = { repoPath: string; name: string } & Record<string, string>;

async function list(): Promise<Row[]> {
  const res = await app().fetch(new Request("http://x/api/repo-run-defaults"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { repos: Row[] }).repos;
}

test("a repo set to Codex is listed; set back to inherit it drops out", async () => {
  await put(repoA, { maxAuto: 2 }); // a config row that keeps every run default inherited
  expect(await list()).toEqual([]);

  await put(repoA, { agentProvider: "codex" });
  expect(await list()).toEqual([
    {
      repoPath: realpathSync(repoA),
      name: basename(repoA),
      agentProvider: "codex",
      defaultModel: "inherit",
      defaultEffort: "inherit",
      defaultExecutionEffort: "inherit",
    },
  ]);

  await put(repoA, { agentProvider: "inherit" });
  expect(await list()).toEqual([]);
});

test("an own execution effort alone lists the repo; rows are sorted by name", async () => {
  await put(repoB, { defaultExecutionEffort: "high" });
  await put(repoA, { defaultEffort: "low" });
  const rows = await list();
  expect(rows.map((r) => r.name)).toEqual([basename(repoA), basename(repoB)]);
  expect(rows[0]).toMatchObject({ defaultEffort: "low", defaultExecutionEffort: "inherit" });
  expect(rows[1]).toMatchObject({ defaultEffort: "inherit", defaultExecutionEffort: "high" });
});

test("a stored row for a repo no longer under the repo root is omitted", async () => {
  const cfg = store.getRepoConfig("/gone/repo");
  store.setRepoConfig("/gone/repo", { ...cfg, agentProvider: "claude" });
  expect(store.reposWithOwnRunDefaults().map((d) => d.repoPath)).toEqual(["/gone/repo"]);
  expect(await list()).toEqual([]);
});
