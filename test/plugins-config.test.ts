// Integration tests for `ctx.setConfig` (issue #1961) — the official plugin config write
// path that replaces the `ctx.state`-overlay-shadowing-`ctx.config` pattern.
//
// These assert on the ACTUAL file on disk rather than a mocked fs, because the whole point of
// the seam is that `config.json` stays the single source of truth: a test against a fake would
// pass while the real file drifted.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import type { PluginContext } from "../src/plugins/types";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shep-plugins-config-"));
}

/** A plugin that parks its `ctx` on globalThis so the test can drive `setConfig` directly —
 *  standing in for the route handler a real plugin would call it from. */
function writePlugin(root: string, id: string, config?: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1 }),
  );
  writeFileSync(
    join(dir, "index.js"),
    `export function register(ctx) { globalThis.__cfgCtx = ctx; }`,
  );
  if (config !== undefined) writeFileSync(join(dir, "config.json"), config);
  return dir;
}

async function loadOne(pluginsDir: string): Promise<PluginContext> {
  const registry = new PluginRegistry({
    pluginsDir,
    store: new SessionStore(":memory:"),
    events: new EventHub(),
  });
  await registry.loadAll();
  return (globalThis as unknown as { __cfgCtx: PluginContext }).__cfgCtx;
}

function readConfig(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

test("setConfig: merges into config.json, leaving untouched keys intact", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(
      root,
      "cfg-merge",
      JSON.stringify({ relayUrl: "wss://old", buzzBin: "/usr/bin/buzz", verbosity: "quiet" }),
    );
    const ctx = await loadOne(root);

    await ctx.setConfig({ relayUrl: "wss://new" });

    expect(readConfig(dir)).toEqual({
      relayUrl: "wss://new",
      buzzBin: "/usr/bin/buzz",
      verbosity: "quiet",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: ctx.config reflects the merge at the SAME object reference", async () => {
  const root = tmpDir();
  try {
    writePlugin(root, "cfg-live", JSON.stringify({ a: 1 }));
    const ctx = await loadOne(root);
    // A plugin that captured ctx.config during register() must keep a live view.
    const captured = ctx.config;

    await ctx.setConfig({ b: 2 });

    expect(ctx.config).toBe(captured);
    expect(captured).toEqual({ a: 1, b: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: creates config.json when the plugin has none", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-absent");
    const ctx = await loadOne(root);
    expect(existsSync(join(dir, "config.json"))).toBe(false);

    await ctx.setConfig({ relayUrl: "wss://first" });

    expect(readConfig(dir)).toEqual({ relayUrl: "wss://first" });
    expect(ctx.config).toEqual({ relayUrl: "wss://first" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: an operator's hand-edit made AFTER boot survives a later patch", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-reread", JSON.stringify({ relayUrl: "wss://boot" }));
    const ctx = await loadOne(root);

    // Operator edits the file while the server runs — the loader's in-memory copy is now stale.
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ relayUrl: "wss://boot", buzzBin: "/opt/buzz" }),
    );

    await ctx.setConfig({ verbosity: "loud" });

    // The hand-added key is merged, not clobbered by the boot-time snapshot.
    expect(readConfig(dir)).toEqual({
      relayUrl: "wss://boot",
      buzzBin: "/opt/buzz",
      verbosity: "loud",
    });
    expect(ctx.config).toEqual({
      relayUrl: "wss://boot",
      buzzBin: "/opt/buzz",
      verbosity: "loud",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: refuses to write when config.json is unparseable, leaving it byte-identical", async () => {
  const root = tmpDir();
  try {
    const broken = '{ "relayUrl": "wss://x",\n  // half-edited\n';
    const dir = writePlugin(root, "cfg-broken", broken);
    const ctx = await loadOne(root);

    await expect(ctx.setConfig({ relayUrl: "wss://new" })).rejects.toThrow(/not valid JSON/);

    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(broken);
    // And no temp-file debris is left behind.
    expect(existsSync(join(dir, ".config.json.tmp"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: refuses when config.json holds a non-object", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-array", JSON.stringify(["not", "an", "object"]));
    const ctx = await loadOne(root);

    await expect(ctx.setConfig({ a: 1 })).rejects.toThrow(/not a JSON object/);
    expect(readConfig(dir)).toEqual(["not", "an", "object"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: rejects a non-object or non-serializable patch", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-badpatch", JSON.stringify({ a: 1 }));
    const ctx = await loadOne(root);

    await expect(ctx.setConfig(null as never)).rejects.toThrow(/plain object/);
    await expect(ctx.setConfig(["a"] as never)).rejects.toThrow(/plain object/);
    await expect(ctx.setConfig("nope" as never)).rejects.toThrow(/plain object/);

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await expect(ctx.setConfig(cyclic)).rejects.toThrow(/not JSON-serializable/);

    // Nothing was written by any of the rejected calls.
    expect(readConfig(dir)).toEqual({ a: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: a rejected write does not poison later writes", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-recover", JSON.stringify({ a: 1 }));
    const ctx = await loadOne(root);

    await expect(ctx.setConfig(null as never)).rejects.toThrow();
    await ctx.setConfig({ b: 2 });

    expect(readConfig(dir)).toEqual({ a: 1, b: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: concurrent patches are serialized — both survive", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-concurrent", JSON.stringify({ base: true }));
    const ctx = await loadOne(root);

    // Fired without awaiting in between: an unserialized read-modify-write would lose one.
    await Promise.all([
      ctx.setConfig({ relayUrl: "wss://a" }),
      ctx.setConfig({ buzzBin: "/opt/buzz" }),
      ctx.setConfig({ verbosity: "loud" }),
    ]);

    expect(readConfig(dir)).toEqual({
      base: true,
      relayUrl: "wss://a",
      buzzBin: "/opt/buzz",
      verbosity: "loud",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: rejects a merged config above the size cap, leaving the file intact", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-huge", JSON.stringify({ a: 1 }));
    const ctx = await loadOne(root);

    await expect(ctx.setConfig({ blob: "x".repeat(70_000) })).rejects.toThrow(/exceeds/);
    expect(readConfig(dir)).toEqual({ a: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig: the written file is hand-editable (pretty-printed, trailing newline)", async () => {
  const root = tmpDir();
  try {
    const dir = writePlugin(root, "cfg-pretty");
    const ctx = await loadOne(root);

    await ctx.setConfig({ relayUrl: "wss://x", verbosity: "quiet" });

    const raw = readFileSync(join(dir, "config.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "relayUrl"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
