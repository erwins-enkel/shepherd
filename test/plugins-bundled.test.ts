// Bundled plugins (`bundledPluginsDir`, #2464) and `ctx.repos`.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import type { PluginContext, PluginRepo } from "../src/plugins/types";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shep-plugins-bundled-"));
}

/** Plugin whose register parks ctx on globalThis under `slot`, with `config.json` present. */
function writePlugin(root: string, folder: string, id: string, slot: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ id, name: slot, version: "1.0.0", apiVersion: 1 }),
  );
  writeFileSync(
    join(dir, "index.js"),
    `export function register(ctx) { globalThis.${slot} = ctx; }`,
  );
  writeFileSync(join(dir, "config.json"), JSON.stringify({ fromFile: true }));
  return dir;
}

function ctxAt(slot: string): PluginContext {
  return (globalThis as unknown as Record<string, PluginContext>)[slot]!;
}

function registry(pluginsDir: string, bundledPluginsDir?: string, repos?: () => PluginRepo[]) {
  return new PluginRegistry({
    pluginsDir,
    bundledPluginsDir,
    repos,
    store: new SessionStore(":memory:"),
    events: new EventHub(),
  });
}

test("bundled dir loads; its config.json is ignored and setConfig refuses to write", async () => {
  const ops = tmpDir();
  const bundled = tmpDir();
  try {
    const dir = writePlugin(bundled, "b1", "bundled-one", "__bundledOne");
    const reg = registry(ops, bundled);
    await reg.loadAll();
    expect(reg.list().map((p) => p.id)).toEqual(["bundled-one"]);
    expect(reg.list()[0]!.bundled).toBe(true);
    const ctx = ctxAt("__bundledOne");
    expect(ctx.config).toEqual({});
    await expect(ctx.setConfig({ a: 1 })).rejects.toThrow(/bundled/);
    expect(existsSync(join(dir, ".config.json.tmp"))).toBe(false);
  } finally {
    rmSync(ops, { recursive: true, force: true });
    rmSync(bundled, { recursive: true, force: true });
  }
});

test("an operator plugin with the same id wins over the bundled one", async () => {
  const ops = tmpDir();
  const bundled = tmpDir();
  try {
    writePlugin(ops, "mine", "dup", "__dupOps");
    writePlugin(bundled, "dup", "dup", "__dupBundled");
    const reg = registry(ops, bundled);
    await reg.loadAll();
    expect(reg.list().map((p) => p.name)).toEqual(["__dupOps"]);
    expect(reg.list()[0]!.bundled).toBeUndefined();
  } finally {
    rmSync(ops, { recursive: true, force: true });
    rmSync(bundled, { recursive: true, force: true });
  }
});

test("activateOne never treats a bundled record as the operator folder's own", async () => {
  const ops = tmpDir();
  const bundled = tmpDir();
  try {
    writePlugin(bundled, "same", "same", "__sameBundled");
    const reg = registry(ops, bundled);
    await reg.loadAll();
    writePlugin(ops, "same", "same", "__sameOps");
    expect(await reg.activateOne("same")).toEqual({ ok: false, error: "id_collision" });
  } finally {
    rmSync(ops, { recursive: true, force: true });
    rmSync(bundled, { recursive: true, force: true });
  }
});

test("ctx.repos.list reads the injected source live; absent → []", async () => {
  const ops = tmpDir();
  try {
    writePlugin(ops, "r", "repos-probe", "__reposProbe");
    let repos: PluginRepo[] = [];
    const reg = registry(ops, undefined, () => repos);
    await reg.loadAll();
    const ctx = ctxAt("__reposProbe");
    expect(ctx.repos.list()).toEqual([]);
    repos = [{ path: "/r/a", name: "a", autoLabel: "shepherd:auto", lightweight: false }];
    expect(ctx.repos.list()).toEqual(repos);

    const ops2 = tmpDir();
    try {
      writePlugin(ops2, "r", "repos-none", "__reposNone");
      await registry(ops2).loadAll();
      expect(ctxAt("__reposNone").repos.list()).toEqual([]);
    } finally {
      rmSync(ops2, { recursive: true, force: true });
    }
  } finally {
    rmSync(ops, { recursive: true, force: true });
  }
});
