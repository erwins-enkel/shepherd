import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

// #3441: the repo's coding CLI on the repo-config route, and the write-time model/effort clamp.

let tmpRoot: string;
let repoDir: string;
let store: SessionStore;
let savedProvider: typeof config.defaultAgentProvider;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-repo-cli-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  store = new SessionStore(":memory:");
  savedProvider = config.defaultAgentProvider;
  config.defaultAgentProvider = "claude";
});
afterEach(() => {
  config.defaultAgentProvider = savedProvider;
  rmSync(tmpRoot, { recursive: true, force: true });
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

const url = () => `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;

async function put(body: unknown): Promise<Response> {
  return app().fetch(
    new Request(url(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function get(): Promise<Record<string, unknown>> {
  return (await (await app().fetch(new Request(url()))).json()) as Record<string, unknown>;
}

test("agentProvider defaults to inherit and round-trips", async () => {
  expect((await get()).agentProvider).toBe("inherit");
  const r = await put({ agentProvider: "codex" });
  expect(r.status).toBe(200);
  expect(((await r.json()) as Record<string, unknown>).agentProvider).toBe("codex");
  expect((await get()).agentProvider).toBe("codex");
  expect(store.getRepoConfig(repoDir).agentProvider).toBe("codex");
});

test("an unknown agentProvider is a 400 and changes nothing", async () => {
  for (const bad of ["gemini", "", 3, null]) {
    const r = await put({ agentProvider: bad });
    expect(r.status).toBe(400);
  }
  expect(store.getRepoConfig(repoDir).agentProvider).toBe("inherit");
});

test("switching the CLI to Codex drops a Claude repo model to inherit, keeps a fitting effort", async () => {
  expect((await put({ defaultModel: "opus", defaultEffort: "high" })).status).toBe(200);
  const view = (await (await put({ agentProvider: "codex" })).json()) as Record<string, unknown>;
  expect(view).toMatchObject({
    agentProvider: "codex",
    defaultModel: "inherit",
    defaultEffort: "high",
  });
});

test("switching to Claude drops a Codex model and ultra; inherit keeps a fitting Claude model", async () => {
  await put({ agentProvider: "codex", defaultModel: "gpt-5.4", defaultEffort: "ultra" });
  expect(store.getRepoConfig(repoDir)).toMatchObject({
    defaultModel: "gpt-5.4",
    defaultEffort: "ultra",
  });
  const view = (await (await put({ agentProvider: "claude" })).json()) as Record<string, unknown>;
  expect(view).toMatchObject({ defaultModel: "inherit", defaultEffort: "inherit" });
  await put({ defaultModel: "sonnet" });
  const kept = (await (await put({ agentProvider: "inherit" })).json()) as Record<string, unknown>;
  expect(kept.defaultModel).toBe("sonnet"); // inherit → global Claude: sonnet still fits
});

test("an edit that leaves the CLI alone never clamps", async () => {
  config.defaultAgentProvider = "codex";
  const view = (await (await put({ defaultModel: "opus" })).json()) as Record<string, unknown>;
  expect(view.defaultModel).toBe("opus"); // ignored at spawn time, not rewritten here
});
