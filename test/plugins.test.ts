import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import { PluginSpawnAborted, type SpawnDescriptor } from "../src/plugins/types";

const DESC: SpawnDescriptor = {
  sessionId: "sess-1",
  kind: "session",
  repoRoot: "/repo",
  model: null,
  agentProvider: "claude",
  argv: ["claude", "--session-id", "x"],
  env: {},
  isolated: true,
};

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "shep-plugins-"));
  return d;
}

/** Write a self-contained inline plugin (plain ESM .js so it imports anywhere). */
function writePlugin(
  root: string,
  id: string,
  opts: { manifest?: unknown; index?: string; config?: unknown } = {},
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const manifest = opts.manifest ?? { id, name: id, version: "1.0.0", apiVersion: 1 };
  writeFileSync(
    join(dir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  if (opts.index !== undefined) writeFileSync(join(dir, "index.js"), opts.index);
  if (opts.config !== undefined)
    writeFileSync(join(dir, "config.json"), JSON.stringify(opts.config));
}

function makeRegistry(pluginsDir: string, hookTimeoutMs = 5_000) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const registry = new PluginRegistry({ pluginsDir, store, events, hookTimeoutMs });
  return { registry, store, events };
}

// ── store: plugin_state accessors ───────────────────────────────────────────
test("plugin_state: scoped round-trip + isolation + delete + keys", () => {
  const store = new SessionStore(":memory:");
  expect(store.getPluginState("p1", "k")).toBeNull();
  store.setPluginState("p1", "k", JSON.stringify({ n: 1 }));
  store.setPluginState("p1", "other", '"v"');
  store.setPluginState("p2", "k", '"p2val"'); // different plugin, same key — isolated
  expect(JSON.parse(store.getPluginState("p1", "k")!)).toEqual({ n: 1 });
  expect(store.getPluginState("p2", "k")).toBe('"p2val"');
  expect(store.listPluginStateKeys("p1").sort()).toEqual(["k", "other"]);
  store.deletePluginState("p1", "k");
  expect(store.getPluginState("p1", "k")).toBeNull();
  expect(store.listPluginStateKeys("p1")).toEqual(["other"]);
});

// ── loader: no-op invariant ──────────────────────────────────────────────────
test("loadAll: missing dir is a clean no-op", async () => {
  const { registry } = makeRegistry(join(tmpdir(), "does-not-exist-xyz"));
  await registry.loadAll();
  expect(registry.loadedCount()).toBe(0);
  expect(registry.list()).toEqual([]);
});

test("loadAll: empty dir loads nothing", async () => {
  const root = tmpDir();
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  expect(registry.loadedCount()).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

// ── loader: guardrails ───────────────────────────────────────────────────────
test("loadAll: invalid manifest is skipped, does not block others", async () => {
  const root = tmpDir();
  writePlugin(root, "a-bad", { manifest: "{ not json", index: "export function register(){}" });
  writePlugin(root, "b-good", { index: "export function register(){}" });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  const ids = registry.list().map((p) => p.id);
  expect(ids).toContain("b-good");
  expect(ids).not.toContain("a-bad");
  rmSync(root, { recursive: true, force: true });
});

test("loadAll: apiVersion mismatch is recorded as errored, registers no hooks", async () => {
  const root = tmpDir();
  writePlugin(root, "old", {
    manifest: { id: "old", name: "Old", version: "1.0.0", apiVersion: 99 },
    index: "export function register(ctx){ ctx.onSpawn(() => ({ env: { X: '1' } })); }",
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  const info = registry.list().find((p) => p.id === "old")!;
  expect(info.health).toBe("errored");
  expect(info.lastError).toContain("apiVersion");
  // its hook must NOT have registered
  expect(await registry.runSpawnHooks(DESC)).toEqual({});
  rmSync(root, { recursive: true, force: true });
});

test("loadAll: a throwing register is isolated; other plugins still load", async () => {
  const root = tmpDir();
  writePlugin(root, "a-throws", {
    index: "export function register(){ throw new Error('boom'); }",
  });
  writePlugin(root, "b-ok", { index: "export function register(){}" });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  const a = registry.list().find((p) => p.id === "a-throws")!;
  const b = registry.list().find((p) => p.id === "b-ok")!;
  expect(a.health).toBe("errored");
  expect(a.lastError).toContain("boom");
  expect(b.health).toBe("ok");
  rmSync(root, { recursive: true, force: true });
});

test("loadAll: enabled:false is skipped", async () => {
  const root = tmpDir();
  writePlugin(root, "off", {
    manifest: { id: "off", name: "Off", version: "1.0.0", apiVersion: 1, enabled: false },
    index: "export function register(){}",
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  expect(registry.loadedCount()).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

test("list: carries only browser-safe repository urls", async () => {
  const root = tmpDir();
  writePlugin(root, "repo-ok", {
    manifest: {
      id: "repo-ok",
      name: "Repo OK",
      version: "1.0.0",
      apiVersion: 1,
      repository: "https://github.com/owner/repo-ok",
    },
    index: "export function register(){}",
  });
  writePlugin(root, "repo-bad", {
    manifest: {
      id: "repo-bad",
      name: "Repo Bad",
      version: "1.0.0",
      apiVersion: 1,
      repository: "git@github.com:owner/repo-bad.git",
    },
    index: "export function register(){}",
  });

  const { registry } = makeRegistry(root);
  await registry.loadAll();

  expect(registry.list().find((p) => p.id === "repo-ok")!.repository).toBe(
    "https://github.com/owner/repo-ok",
  );
  expect(registry.list().find((p) => p.id === "repo-bad")!.repository).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

// ── loader: symlinked plugin dirs (#1176) ────────────────────────────────────
test("loadAll: a symlinked plugin dir loads identically to a copied one", async () => {
  // The plugin's real folder lives outside the plugins dir; only a symlink to it
  // is placed inside — the natural "run a plugin from its checkout" install.
  const src = tmpDir();
  writePlugin(src, "linked", { index: "export function register(){}" });
  const pluginsDir = tmpDir();
  symlinkSync(join(src, "linked"), join(pluginsDir, "linked"));

  const { registry } = makeRegistry(pluginsDir);
  await registry.loadAll();

  const info = registry.list().find((p) => p.id === "linked");
  expect(info).toBeDefined();
  expect(info!.health).toBe("ok");
  rmSync(pluginsDir, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

test("loadAll: a dangling symlink is ignored without throwing", async () => {
  const pluginsDir = tmpDir();
  symlinkSync(join(pluginsDir, "no-such-target"), join(pluginsDir, "dangling"));
  const { registry } = makeRegistry(pluginsDir);
  await registry.loadAll(); // must not throw
  expect(registry.loadedCount()).toBe(0);
  rmSync(pluginsDir, { recursive: true, force: true });
});

// ── loader: example fixture (also the public template) ───────────────────────
test("loads the example-plugin fixture with ok health + a route", async () => {
  const fixtures = resolve(import.meta.dir, "fixtures");
  const { registry } = makeRegistry(fixtures);
  await registry.loadAll();
  const info = registry.list().find((p) => p.id === "example-plugin");
  expect(info).toBeDefined();
  expect(info!.health).toBe("ok");
  const res = await registry.handleRoute(
    "GET",
    "example-plugin",
    "status",
    new Request("http://x/"),
  );
  expect(res?.status).toBe(200);
  expect(
    await registry.handleRoute("GET", "example-plugin", "nope", new Request("http://x/")),
  ).toBeNull();
});

// ── onSpawn merge ────────────────────────────────────────────────────────────
test("runSpawnHooks: merges env + extraArgs across plugins", async () => {
  const root = tmpDir();
  writePlugin(root, "a-env", {
    index:
      "export function register(ctx){ ctx.onSpawn(() => ({ env: { FOO: 'bar' }, extraArgs: ['--a'] })); }",
  });
  writePlugin(root, "b-args", {
    index:
      "export function register(ctx){ ctx.onSpawn(() => ({ env: { BAZ: 'qux' }, extraArgs: ['--b'] })); }",
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  const patch = await registry.runSpawnHooks(DESC);
  expect(patch.env).toEqual({ FOO: "bar", BAZ: "qux" });
  expect(patch.extraArgs).toEqual(["--a", "--b"]);
  rmSync(root, { recursive: true, force: true });
});

test("runSpawnHooks: credentialDir is last-write-wins (load order)", async () => {
  const root = tmpDir();
  writePlugin(root, "a-cred", {
    index: "export function register(ctx){ ctx.onSpawn(() => ({ credentialDir: '/a' })); }",
  });
  writePlugin(root, "b-cred", {
    index: "export function register(ctx){ ctx.onSpawn(() => ({ credentialDir: '/b' })); }",
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  const patch = await registry.runSpawnHooks(DESC);
  expect(patch.credentialDir).toBe("/b");
  rmSync(root, { recursive: true, force: true });
});

test("runSpawnHooks: a throwing hook fails open (spawn proceeds) + marks errored", async () => {
  const root = tmpDir();
  writePlugin(root, "a-throw", {
    index: "export function register(ctx){ ctx.onSpawn(() => { throw new Error('hookboom'); }); }",
  });
  writePlugin(root, "b-ok", {
    index: "export function register(ctx){ ctx.onSpawn(() => ({ env: { OK: '1' } })); }",
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  const patch = await registry.runSpawnHooks(DESC);
  expect(patch.env).toEqual({ OK: "1" }); // b's patch survived
  expect(registry.list().find((p) => p.id === "a-throw")!.health).toBe("errored");
  rmSync(root, { recursive: true, force: true });
});

test("runSpawnHooks: a health flip on hook failure emits plugin:status (live panel)", async () => {
  const root = tmpDir();
  writePlugin(root, "a-throw", {
    index: "export function register(ctx){ ctx.onSpawn(() => { throw new Error('boom'); }); }",
  });
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const seen: Array<{ id: string; health: string; status: unknown }> = [];
  events.subscribe((event, data) => {
    if (event === "plugin:status")
      seen.push(data as { id: string; health: string; status: unknown });
  });
  const registry = new PluginRegistry({ pluginsDir: root, store, events });
  await registry.loadAll();
  seen.length = 0; // drop the load-time publishStatus, if any
  await registry.runSpawnHooks(DESC);
  expect(seen).toContainEqual({ id: "a-throw", health: "errored", status: null });
  rmSync(root, { recursive: true, force: true });
});

test("runSpawnHooks: a hook that never resolves times out (fail-open) + marks timed-out", async () => {
  const root = tmpDir();
  writePlugin(root, "slow", {
    index: "export function register(ctx){ ctx.onSpawn(() => new Promise(() => {})); }",
  });
  const { registry } = makeRegistry(root, 30); // 30ms timeout
  await registry.loadAll();
  const patch = await registry.runSpawnHooks(DESC);
  expect(patch).toEqual({});
  expect(registry.list().find((p) => p.id === "slow")!.health).toBe("timed-out");
  rmSync(root, { recursive: true, force: true });
});

test("runSpawnHooks: abortSpawn rejects with PluginSpawnAborted (hard-block)", async () => {
  const root = tmpDir();
  writePlugin(root, "abort", {
    index: "export function register(ctx){ ctx.onSpawn(() => ctx.abortSpawn('no creds')); }",
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  let caught: unknown;
  try {
    await registry.runSpawnHooks(DESC);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(PluginSpawnAborted);
  expect((caught as PluginSpawnAborted).reason).toBe("no creds");
  rmSync(root, { recursive: true, force: true });
});

// ── ctx.state + ctx.config + events + publishStatus ──────────────────────────
test("ctx: state persists, config is read, publishStatus emits plugin:status", async () => {
  const root = tmpDir();
  writePlugin(root, "stateful", {
    config: { greeting: "hi" },
    index: `export function register(ctx){
      ctx.state.set('count', (ctx.state.get('count') ?? 0) + 1);
      ctx.publishStatus({ greeting: ctx.config.greeting, count: ctx.state.get('count') });
    }`,
  });
  const seen: Array<{ event: string; data: unknown }> = [];
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  events.subscribe((event, data) => seen.push({ event, data }));

  // First load increments to 1.
  await new PluginRegistry({ pluginsDir: root, store, events }).loadAll();
  expect(seen.filter((e) => e.event === "plugin:status")).toHaveLength(1);
  // plugin:status wraps the published blob with the plugin id + core-derived health.
  expect(seen[0]!.data as { id: string; health: string; status: unknown }).toMatchObject({
    id: "stateful",
    health: "ok",
    status: { count: 1, greeting: "hi" },
  });

  // Second registry over the SAME store sees persisted state → increments to 2.
  await new PluginRegistry({ pluginsDir: root, store, events: new EventHub() }).loadAll();
  expect(store.getPluginState("stateful", "count")).toBe("2");
  rmSync(root, { recursive: true, force: true });
});

test("ctx.events.subscribe receives core events (read-only observation)", async () => {
  const root = tmpDir();
  writePlugin(root, "observer", {
    index: `export function register(ctx){
      ctx.events.subscribe((event) => { if (event === 'session:status') ctx.state.set('saw', true); });
    }`,
  });
  const { registry, store, events } = makeRegistry(root);
  await registry.loadAll();
  events.emit("session:status", { id: "x", status: "running" });
  expect(store.getPluginState("observer", "saw")).toBe("true");
  rmSync(root, { recursive: true, force: true });
});

test("teardown invokes plugin teardown fns + unsubscribes", async () => {
  const fixtures = resolve(import.meta.dir, "fixtures");
  const { registry } = makeRegistry(fixtures);
  await registry.loadAll();
  expect(() => registry.teardown()).not.toThrow();
});
