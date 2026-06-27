import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import { validatePluginUIView } from "../src/plugins/ui-validate";
import type { PluginUINode, PluginUIView } from "../src/plugins/types";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shep-plugins-ui-"));
}

function writePlugin(root: string, id: string, opts: { index?: string } = {}): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1 }),
  );
  if (opts.index !== undefined) writeFileSync(join(dir, "index.js"), opts.index);
}

function makeRegistry(pluginsDir: string) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const registry = new PluginRegistry({ pluginsDir, store, events });
  return { registry, store, events };
}

// ── validator unit tests ─────────────────────────────────────────────────────

test("validatePluginUIView: valid minimal view round-trips and normalizes", () => {
  const view: PluginUIView = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "Label", props: { text: "hello" } },
  };
  expect(validatePluginUIView(view)).toEqual(view);
});

test("validatePluginUIView: non-object / null / array returns null", () => {
  expect(validatePluginUIView(null)).toBeNull();
  expect(validatePluginUIView("string")).toBeNull();
  expect(validatePluginUIView(42)).toBeNull();
  expect(validatePluginUIView([])).toBeNull();
});

test("validatePluginUIView: missing root returns null", () => {
  expect(validatePluginUIView({ schemaVersion: 1, slot: "settings-panel" })).toBeNull();
});

test("validatePluginUIView: wrong schemaVersion returns null", () => {
  expect(
    validatePluginUIView({ schemaVersion: 2, slot: "settings-panel", root: { type: "X" } }),
  ).toBeNull();
  expect(
    validatePluginUIView({ schemaVersion: "1", slot: "settings-panel", root: { type: "X" } }),
  ).toBeNull();
});

test("validatePluginUIView: unknown or missing slot returns null", () => {
  expect(
    validatePluginUIView({ schemaVersion: 1, slot: "unknown-slot", root: { type: "X" } }),
  ).toBeNull();
  expect(validatePluginUIView({ schemaVersion: 1, slot: null, root: { type: "X" } })).toBeNull();
});

test("validatePluginUIView: all valid slots are accepted", () => {
  for (const slot of ["settings-panel", "session-sidebar", "dashboard-card"] as const) {
    expect(validatePluginUIView({ schemaVersion: 1, slot, root: { type: "X" } })).not.toBeNull();
  }
});

test("validatePluginUIView: view exceeding 64 KB returns null", () => {
  const big = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "Label", props: { text: "x".repeat(70_000) } },
  };
  expect(validatePluginUIView(big)).toBeNull();
});

test("validatePluginUIView: props array > 500 entries returns null", () => {
  const big = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "Table", props: { rows: Array(501).fill({ v: 1 }) } },
  };
  expect(validatePluginUIView(big)).toBeNull();
});

test("validatePluginUIView: children array > 500 entries returns null", () => {
  const big = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "List", children: Array(501).fill({ type: "Item" }) },
  };
  expect(validatePluginUIView(big)).toBeNull();
});

test("validatePluginUIView: depth > 16 returns null", () => {
  // Build a tree 17 levels deep (root = depth 1, leaf = depth 17).
  let node: PluginUINode = { type: "Leaf" };
  for (let i = 0; i < 16; i++) {
    node = { type: "Container", children: [node] };
  }
  expect(validatePluginUIView({ schemaVersion: 1, slot: "settings-panel", root: node })).toBeNull();
});

test("validatePluginUIView: depth 16 is accepted", () => {
  // Build a tree 16 levels deep (root = depth 1, leaf = depth 16).
  let node: PluginUINode = { type: "Leaf" };
  for (let i = 0; i < 15; i++) {
    node = { type: "Container", children: [node] };
  }
  expect(
    validatePluginUIView({ schemaVersion: 1, slot: "settings-panel", root: node }),
  ).not.toBeNull();
});

test("validatePluginUIView: node count > 256 returns null", () => {
  // Root + 256 children = 257 nodes total → rejected.
  const children = Array(256).fill({ type: "Item" });
  expect(
    validatePluginUIView({
      schemaVersion: 1,
      slot: "settings-panel",
      root: { type: "List", children },
    }),
  ).toBeNull();
});

test("validatePluginUIView: node count 256 is accepted", () => {
  // Root + 255 children = 256 nodes total → accepted.
  const children = Array(255).fill({ type: "Item" });
  expect(
    validatePluginUIView({
      schemaVersion: 1,
      slot: "settings-panel",
      root: { type: "List", children },
    }),
  ).not.toBeNull();
});

test("validatePluginUIView: cyclic object returns null (does not throw)", () => {
  const o: Record<string, unknown> = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "Panel", props: {} },
  };
  (o["root"] as Record<string, unknown>)["props"] = { self: o };
  expect(() => validatePluginUIView(o)).not.toThrow();
  expect(validatePluginUIView(o)).toBeNull();
});

test("validatePluginUIView: function prop is accepted but stripped from result", () => {
  const view = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "Button", props: { label: "click", onClick: () => {} } },
  };
  const result = validatePluginUIView(view);
  expect(result).not.toBeNull();
  expect(result!.root.props?.["onClick"]).toBeUndefined();
  expect(result!.root.props?.["label"]).toBe("click");
});

// ── loader integration tests ─────────────────────────────────────────────────

test("publishUI: valid view sets list().ui and emits plugin:ui event", async () => {
  const root = tmpDir();
  const view = {
    schemaVersion: 1,
    slot: "settings-panel",
    root: { type: "Label", props: { text: "hi" } },
  };
  writePlugin(root, "ui-pub", {
    index: `export function register(ctx) { ctx.publishUI(${JSON.stringify(view)}); }`,
  });
  const { registry, events } = makeRegistry(root);
  const uiEvents: Array<{ id: string; ui: unknown }> = [];
  events.subscribe((event, data) => {
    if (event === "plugin:ui") uiEvents.push(data as { id: string; ui: unknown });
  });
  await registry.loadAll();
  const info = registry.list().find((p) => p.id === "ui-pub")!;
  expect(info.ui).toEqual(view);
  expect(uiEvents).toContainEqual({ id: "ui-pub", ui: view });
  rmSync(root, { recursive: true, force: true });
});

test("publishUI(null): clears list().ui to null and emits", async () => {
  const root = tmpDir();
  const view = { schemaVersion: 1, slot: "settings-panel", root: { type: "Label" } };
  writePlugin(root, "ui-null", {
    index: `export function register(ctx) {
      ctx.publishUI(${JSON.stringify(view)});
      ctx.publishUI(null);
    }`,
  });
  const { registry, events } = makeRegistry(root);
  const uiEvents: Array<{ id: string; ui: unknown }> = [];
  events.subscribe((event, data) => {
    if (event === "plugin:ui") uiEvents.push(data as { id: string; ui: unknown });
  });
  await registry.loadAll();
  expect(registry.list().find((p) => p.id === "ui-null")!.ui).toBeNull();
  expect(uiEvents.at(-1)).toEqual({ id: "ui-null", ui: null });
  rmSync(root, { recursive: true, force: true });
});

test("publishUI: invalid view is dropped; prior view retained", async () => {
  const root = tmpDir();
  const good = { schemaVersion: 1, slot: "settings-panel", root: { type: "Label" } };
  writePlugin(root, "ui-drop", {
    index: `export function register(ctx) {
      ctx.publishUI(${JSON.stringify(good)});
      ctx.publishUI({ schemaVersion: 99 }); // invalid — dropped, prior kept
    }`,
  });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  expect(registry.list().find((p) => p.id === "ui-drop")!.ui).toEqual(good);
  rmSync(root, { recursive: true, force: true });
});

test("publishUI: plugin that never calls publishUI has ui === null (back-compat)", async () => {
  const root = tmpDir();
  writePlugin(root, "ui-none", { index: "export function register(ctx) {}" });
  const { registry } = makeRegistry(root);
  await registry.loadAll();
  expect(registry.list().find((p) => p.id === "ui-none")!.ui).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
