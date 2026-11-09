import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, mergeAgentExtensions, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

// #3780: per-repo plugin/skill allowlists on the repo-config route + the picker's choices.

let tmpRoot: string;
let repoDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-allowlist-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  store = new SessionStore(":memory:");
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function app() {
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => null,
    agentExtensions: async () => ({
      plugins: [{ name: "context7@c", clis: ["claude"] }],
      skills: [{ name: "tdd", clis: ["claude", "codex"] }],
    }),
  };
  return makeApp(deps);
}

async function put(body: unknown): Promise<Response> {
  return app().fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("allowlists default to null on a fresh repo", async () => {
  const r = await app().fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`),
  );
  const cfg = (await r.json()) as Record<string, unknown>;
  expect(cfg.pluginAllowlist).toBeNull();
  expect(cfg.skillAllowlist).toBeNull();
});

test("PUT stores trimmed, deduped lists; [] stays []; null clears", async () => {
  let r = await put({ pluginAllowlist: [" a@x ", "a@x", "b@y"], skillAllowlist: [] });
  expect(r.status).toBe(200);
  expect(store.getRepoConfig(repoDir).pluginAllowlist).toEqual(["a@x", "b@y"]);
  expect(store.getRepoConfig(repoDir).skillAllowlist).toEqual([]);
  r = await put({ pluginAllowlist: null });
  expect(r.status).toBe(200);
  expect(store.getRepoConfig(repoDir).pluginAllowlist).toBeNull();
  expect(store.getRepoConfig(repoDir).skillAllowlist).toEqual([]); // untouched by the patch
});

test("PUT rejects malformed allowlists", async () => {
  for (const bad of [
    { pluginAllowlist: "a@x" },
    { pluginAllowlist: [1] },
    { skillAllowlist: [""] },
    { skillAllowlist: ["x".repeat(201)] },
    { skillAllowlist: Array.from({ length: 201 }, (_, i) => `s${i}`) },
  ]) {
    expect((await put(bad)).status).toBe(400);
  }
  expect(store.getRepoConfig(repoDir).pluginAllowlist).toBeNull();
});

test("GET /api/agent-extensions returns the picker's choices", async () => {
  const r = await app().fetch(new Request("http://x/api/agent-extensions"));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    plugins: [{ name: "context7@c", clis: ["claude"] }],
    skills: [{ name: "tdd", clis: ["claude", "codex"] }],
  });
});

test("mergeAgentExtensions: one entry per name across CLIs, sorted, clis in provider order", () => {
  expect(
    mergeAgentExtensions({
      codex: { plugins: ["canva@remote"], skills: ["tdd", "grilling", "tdd"] },
      claude: { plugins: ["vercel@v", "context7@c"], skills: ["tdd"] },
    }),
  ).toEqual({
    plugins: [
      { name: "canva@remote", clis: ["codex"] },
      { name: "context7@c", clis: ["claude"] },
      { name: "vercel@v", clis: ["claude"] },
    ],
    skills: [
      { name: "grilling", clis: ["codex"] },
      { name: "tdd", clis: ["claude", "codex"] },
    ],
  });
});
