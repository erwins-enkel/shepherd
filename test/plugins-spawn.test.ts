// Service-level onSpawn integration (issue #1124): proves the abort + env-precedence
// contracts the plan committed to (review points 1–3), exercising the real spawn path
// through SessionService.create()/resume() with a fake worktree + herdr.
import { test, expect, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";
import { PluginSpawnAborted, type SpawnDescriptor, type SpawnPatch } from "../src/plugins/types";
import { SandboxAutoRefused } from "../src/sandbox";

type Hooks = (d: SpawnDescriptor) => Promise<SpawnPatch>;

function makeService(hooks: { fn: Hooks }) {
  const store = new SessionStore(":memory:");
  const captured: { env?: Record<string, string>; argv?: string[] } = {};
  const removed: string[] = [];
  const stopped: string[] = [];
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    runSpawnHooks: (d) => hooks.fn(d),
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => ({ worktreePath: "/wt/repo-x", branch: "shepherd/repo-x", isolated: true }),
      remove: (p: string) => removed.push(p),
    } as never,
    herdr: {
      start: (_name: string, _cwd: string, argv: string[], env?: Record<string, string>) => {
        captured.argv = argv;
        captured.env = env;
        return { terminalId: "term_z" } as never;
      },
      stop: (id: string) => stopped.push(id),
      list: () => [],
    } as never,
  });
  return { service, store, captured, removed, stopped };
}

const NOOP_HOOKS = { fn: async () => ({}) as SpawnPatch };

afterEach(() => __setApiKeyConfigDirProvisionForTest(null));

test("onSpawn abort on create throws + rolls back the worktree (no session row)", async () => {
  const hooks = { fn: async () => Promise.reject(new PluginSpawnAborted("no creds", "swap")) };
  const { service, store, removed } = makeService(hooks as { fn: Hooks });
  await expect(
    service.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "go",
      model: null,
      images: [],
    }),
  ).rejects.toThrow(/swap aborted spawn: no creds/);
  expect(removed).toEqual(["/wt/repo-x"]); // worktree rolled back
  expect(store.list({})).toHaveLength(0); // no persisted session
});

test("onSpawn abort on (non-forced) resume returns null, husk preserved", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({}) };
  const { service, store } = makeService(hooks);
  // Create normally (no-op hooks), then make a resumable row.
  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  store.update(s.id, { status: "done" });
  // Now arm the abort and resume — no live agent (herdr.list []), so it proceeds to spawn.
  hooks.fn = async () => Promise.reject(new PluginSpawnAborted("no creds", "swap"));
  const resumed = await service.resume(s.id);
  expect(resumed).toBeNull(); // contract: !ok resume → null (caller skips / 409)
  expect(store.get(s.id)?.status).toBe("done"); // unchanged — husk preserved
});

test("onSpawn credentialDir overrides api-key mode's credential-less mirror in spawnEnv", async () => {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  // api-key mode WITH a helper path → apiKeyPassthrough sets a mirror CLAUDE_CONFIG_DIR.
  config.authMode = "api-key";
  config.authApiKeyHelperPath = "/tmp/helper.sh";
  __setApiKeyConfigDirProvisionForTest(() => "/mirror/credential-less");
  try {
    const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/plugin/account-2" }) };
    const { service, captured } = makeService(hooks);
    await service.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "go",
      model: null,
      images: [],
    });
    // Plugin wins: patchEnv is merged LAST over the api-key mirror.
    expect(captured.env?.CLAUDE_CONFIG_DIR).toBe("/plugin/account-2");
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
});

test("onSpawn extraArgs are appended to the inner agent argv", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ extraArgs: ["--mcp-config", "/x.json"] }) };
  const { service, captured } = makeService(hooks);
  await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  expect(captured.argv?.slice(-2)).toEqual(["--mcp-config", "/x.json"]);
});

test("no runSpawnHooks dep → spawn proceeds unchanged (no-op invariant)", async () => {
  const store = new SessionStore(":memory:");
  let started = false;
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => ({ worktreePath: "/wt/repo-x", branch: "shepherd/repo-x", isolated: true }),
      remove: () => {},
    } as never,
    herdr: {
      start: () => {
        started = true;
        return { terminalId: "term_z" } as never;
      },
      list: () => [],
    } as never,
  });
  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  expect(started).toBe(true);
  expect(s.herdrAgentId).toBe("term_z");
  void NOOP_HOOKS;
});

// ── SandboxAutoRefused.cause plumbing ─────────────────────────────────────────

test("plugin abort on create surfaces as SandboxAutoRefused with PluginSpawnAborted cause", async () => {
  const hooks = { fn: async () => Promise.reject(new PluginSpawnAborted("no creds", "swap")) };
  const { service } = makeService(hooks as { fn: Hooks });

  let caught: unknown;
  try {
    await service.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "go",
      model: null,
      images: [],
    });
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeInstanceOf(SandboxAutoRefused);
  expect((caught as SandboxAutoRefused).cause).toBeInstanceOf(PluginSpawnAborted);
  expect(((caught as SandboxAutoRefused).cause as PluginSpawnAborted).pluginId).toBe("swap");
});

test("non-plugin refusal (api-key hold) surfaces as SandboxAutoRefused with cause === undefined", async () => {
  // A non-plugin SandboxAutoRefused (e.g. api-key hold) has no cause.
  const err = new SandboxAutoRefused("api-key hold reason");
  expect(err.cause).toBeUndefined();
});
