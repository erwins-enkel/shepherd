import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import type { SpawnDescriptor } from "../src/plugins/types";

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
  return mkdtempSync(join(tmpdir(), "shep-activate-"));
}

/** Write a self-contained inline plugin (plain ESM .js). `folder` is the directory name;
 *  `manifest.id` may differ from it (needed for id-collision tests). */
function writePlugin(
  root: string,
  folder: string,
  opts: { manifest?: unknown; index?: string } = {},
): void {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const manifest = opts.manifest ?? { id: folder, name: folder, version: "1.0.0", apiVersion: 1 };
  writeFileSync(
    join(dir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  if (opts.index !== undefined) writeFileSync(join(dir, "index.js"), opts.index);
}

function makeRegistry(pluginsDir: string) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const registry = new PluginRegistry({ pluginsDir, store, events, hookTimeoutMs: 5_000 });
  return { registry, store, events };
}

// ── happy path: loads in-process, hooks go live immediately ──────────────────
test("activateOne: loads a new folder in-process and its onSpawn hook is live", async () => {
  const root = tmpDir();
  writePlugin(root, "live", {
    index: `export function register(ctx){ ctx.onSpawn(() => ({ env: { FOO: "bar" } })); }`,
  });
  const { registry } = makeRegistry(root);

  const res = await registry.activateOne("live");
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.plugin.health).toBe("ok");
  expect(registry.list().map((p) => p.id)).toContain("live");

  // Additive wiring: the hook the plugin just registered actually runs.
  const patch = await registry.runSpawnHooks(DESC);
  expect(patch.env).toEqual({ FOO: "bar" });

  rmSync(root, { recursive: true, force: true });
});

// ── errored register: {ok:true} carrying errored health, honest on re-activate ─
test("activateOne: a failing register() returns ok:true with errored health + lastError", async () => {
  const root = tmpDir();
  writePlugin(root, "boom", { index: `export function register(){ throw new Error("kaputt"); }` });
  const { registry } = makeRegistry(root);

  const res = await registry.activateOne("boom");
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.plugin.health).toBe("errored");
    expect(res.plugin.lastError).toContain("kaputt");
  }

  // Re-activating the SAME errored folder returns the same errored record — no re-register
  // (loadOne's has(id) guard would no-op); picking up a fix needs a restart.
  const again = await registry.activateOne("boom");
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.plugin.health).toBe("errored");

  rmSync(root, { recursive: true, force: true });
});

// ── silent-skip paths never masquerade as success ────────────────────────────
test("activateOne: invalid manifest → {ok:false, invalid_manifest}", async () => {
  const root = tmpDir();
  writePlugin(root, "bad", { manifest: "{ not json", index: "export function register(){}" });
  const { registry } = makeRegistry(root);
  const res = await registry.activateOne("bad");
  expect(res).toEqual({ ok: false, error: "invalid_manifest" });
  rmSync(root, { recursive: true, force: true });
});

test("activateOne: enabled:false → {ok:false, disabled}", async () => {
  const root = tmpDir();
  writePlugin(root, "off", {
    manifest: { id: "off", name: "off", version: "1.0.0", apiVersion: 1, enabled: false },
    index: "export function register(){}",
  });
  const { registry } = makeRegistry(root);
  const res = await registry.activateOne("off");
  expect(res).toEqual({ ok: false, error: "disabled" });
  expect(registry.list()).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("activateOne: rejects an unsafe folder name", async () => {
  const { registry } = makeRegistry(tmpDir());
  expect(await registry.activateOne("..")).toEqual({ ok: false, error: "invalid_folder" });
  expect(await registry.activateOne("a/b")).toEqual({ ok: false, error: "invalid_folder" });
});

// ── id ownership: idempotent for the same folder, collision for a different one ─
test("activateOne: same folder is idempotent; a different folder with the same id collides", async () => {
  const root = tmpDir();
  const idx = "export function register(){}";
  writePlugin(root, "folderA", {
    manifest: { id: "dup", name: "A", version: "1", apiVersion: 1 },
    index: idx,
  });
  writePlugin(root, "folderB", {
    manifest: { id: "dup", name: "B", version: "1", apiVersion: 1 },
    index: idx,
  });
  const { registry } = makeRegistry(root);

  expect((await registry.activateOne("folderA")).ok).toBe(true);
  // Same folder again → idempotent success, not a collision.
  expect((await registry.activateOne("folderA")).ok).toBe(true);
  // A DIFFERENT folder claiming the already-owned id → collision.
  expect(await registry.activateOne("folderB")).toEqual({ ok: false, error: "id_collision" });

  rmSync(root, { recursive: true, force: true });
});

// ── folder field is set on the apiVersion-mismatch record too ─────────────────
test("activateOne: an errored (apiVersion-mismatch) record still owns its id for collision checks", async () => {
  const root = tmpDir();
  // folderA loads with a mismatched apiVersion → recorded as errored (no register), folder set.
  writePlugin(root, "folderA", {
    manifest: { id: "dup", name: "A", version: "1", apiVersion: 999 },
    index: "export function register(){}",
  });
  writePlugin(root, "folderB", {
    manifest: { id: "dup", name: "B", version: "1", apiVersion: 1 },
    index: "export function register(){}",
  });
  const { registry } = makeRegistry(root);

  const a = await registry.activateOne("folderA");
  expect(a.ok).toBe(true);
  if (a.ok) expect(a.plugin.health).toBe("errored");
  // folderB shares the id owned by the errored folderA record → collision (proves folder was set).
  expect(await registry.activateOne("folderB")).toEqual({ ok: false, error: "id_collision" });

  rmSync(root, { recursive: true, force: true });
});
