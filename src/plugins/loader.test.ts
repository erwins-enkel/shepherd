// Integration-style tests for PluginRegistry — specifically publishGearItem.
// Uses a temp dir with a minimal plugin and an in-memory store / event bus.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginRegistry } from "./loader";
import type { PluginEventBus, PluginStateStore } from "./loader";
import type { PluginGearItem } from "./types";

// ── fakes ──────────────────────────────────────────────────────────────────────

function makeStore(): PluginStateStore {
  const data = new Map<string, string>();
  return {
    getPluginState: (id, k) => data.get(`${id}:${k}`) ?? null,
    setPluginState: (id, k, v) => {
      data.set(`${id}:${k}`, v);
    },
    deletePluginState: (id, k) => {
      data.delete(`${id}:${k}`);
    },
    listPluginStateKeys: (id) =>
      [...data.keys()].filter((k) => k.startsWith(`${id}:`)).map((k) => k.slice(id.length + 1)),
  };
}

interface Emitted {
  event: string;
  data: unknown;
}

function makeEventBus(): PluginEventBus & { emitted: Emitted[] } {
  const subs: Array<(event: string, data: unknown) => void> = [];
  const emitted: Emitted[] = [];
  return {
    emitted,
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i !== -1) subs.splice(i, 1);
      };
    },
    emit(event, data) {
      emitted.push({ event, data });
      for (const fn of subs) fn(event, data);
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function makePluginDir(base: string, id: string, entryCode: string): Promise<string> {
  const dir = join(base, id);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id,
    name: id,
    version: "0.1.0",
    apiVersion: 1,
  };
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "index.ts"), entryCode);
  return dir;
}

// ── fixtures ───────────────────────────────────────────────────────────────────

const VALID_GEAR_ITEM: PluginGearItem = {
  label: "Open settings",
  icon: "⚙️",
  action: { kind: "panel" },
};

const VALID_GEAR_ITEM_URL: PluginGearItem = {
  label: "Visit docs",
  action: { kind: "url", href: "https://example.com" },
};

// ── tests ──────────────────────────────────────────────────────────────────────

describe("publishGearItem", () => {
  let tmpDir: string;
  let bus: ReturnType<typeof makeEventBus>;
  let registry: PluginRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "shepherd-plugin-test-"));
    bus = makeEventBus();
  });

  afterEach(async () => {
    registry?.teardown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits plugin:gear event with valid item and item appears in list()", async () => {
    await makePluginDir(
      tmpDir,
      "p-gear-valid",
      `export function register(ctx) {
        ctx.publishGearItem(${JSON.stringify(VALID_GEAR_ITEM)});
      }`,
    );

    registry = new PluginRegistry({
      pluginsDir: tmpDir,
      store: makeStore(),
      events: bus,
      hookTimeoutMs: 500,
    });
    await registry.loadAll();

    const gearEvents = bus.emitted.filter((e) => e.event === "plugin:gear");
    expect(gearEvents).toHaveLength(1);
    expect((gearEvents[0]!.data as { id: string; gearItem: PluginGearItem }).gearItem).toEqual(
      VALID_GEAR_ITEM,
    );

    const info = registry.list().find((p) => p.id === "p-gear-valid");
    expect(info).toBeDefined();
    expect(info!.gearItem).toEqual(VALID_GEAR_ITEM);
  });

  it("publishGearItem(null) clears item and emits plugin:gear with null", async () => {
    await makePluginDir(
      tmpDir,
      "p-gear-clear",
      `export function register(ctx) {
        ctx.publishGearItem(${JSON.stringify(VALID_GEAR_ITEM)});
        ctx.publishGearItem(null);
      }`,
    );

    registry = new PluginRegistry({
      pluginsDir: tmpDir,
      store: makeStore(),
      events: bus,
      hookTimeoutMs: 500,
    });
    await registry.loadAll();

    const gearEvents = bus.emitted.filter((e) => e.event === "plugin:gear");
    expect(gearEvents).toHaveLength(2);
    // second event should have null
    expect((gearEvents[1]!.data as { id: string; gearItem: null }).gearItem).toBeNull();

    const info = registry.list().find((p) => p.id === "p-gear-clear");
    expect(info!.gearItem).toBeNull();
  });

  it("invalid item is dropped and prior item is kept", async () => {
    await makePluginDir(
      tmpDir,
      "p-gear-invalid",
      `export function register(ctx) {
        ctx.publishGearItem(${JSON.stringify(VALID_GEAR_ITEM)});
        // now publish an invalid item (bad label + bad action)
        ctx.publishGearItem({ label: "", action: { kind: "panel" } });
      }`,
    );

    registry = new PluginRegistry({
      pluginsDir: tmpDir,
      store: makeStore(),
      events: bus,
      hookTimeoutMs: 500,
    });
    await registry.loadAll();

    // Only one gear event (the valid one); the invalid publish is dropped, no event emitted.
    const gearEvents = bus.emitted.filter((e) => e.event === "plugin:gear");
    expect(gearEvents).toHaveLength(1);
    expect((gearEvents[0]!.data as { id: string; gearItem: PluginGearItem }).gearItem).toEqual(
      VALID_GEAR_ITEM,
    );

    const info = registry.list().find((p) => p.id === "p-gear-invalid");
    // Prior item kept
    expect(info!.gearItem).toEqual(VALID_GEAR_ITEM);
  });

  it("gearItem starts as null in list() before any publish", async () => {
    await makePluginDir(
      tmpDir,
      "p-gear-noop",
      `export function register(_ctx) { /* no publishGearItem call */ }`,
    );

    registry = new PluginRegistry({
      pluginsDir: tmpDir,
      store: makeStore(),
      events: bus,
      hookTimeoutMs: 500,
    });
    await registry.loadAll();

    const info = registry.list().find((p) => p.id === "p-gear-noop");
    expect(info!.gearItem).toBeNull();
  });

  it("supports url action gear item", async () => {
    await makePluginDir(
      tmpDir,
      "p-gear-url",
      `export function register(ctx) {
        ctx.publishGearItem(${JSON.stringify(VALID_GEAR_ITEM_URL)});
      }`,
    );

    registry = new PluginRegistry({
      pluginsDir: tmpDir,
      store: makeStore(),
      events: bus,
      hookTimeoutMs: 500,
    });
    await registry.loadAll();

    const info = registry.list().find((p) => p.id === "p-gear-url");
    expect(info!.gearItem).toEqual(VALID_GEAR_ITEM_URL);
  });

  it("later publish replaces earlier item", async () => {
    const second: PluginGearItem = { label: "Second", action: { kind: "panel" } };
    await makePluginDir(
      tmpDir,
      "p-gear-replace",
      `export function register(ctx) {
        ctx.publishGearItem(${JSON.stringify(VALID_GEAR_ITEM)});
        ctx.publishGearItem(${JSON.stringify(second)});
      }`,
    );

    registry = new PluginRegistry({
      pluginsDir: tmpDir,
      store: makeStore(),
      events: bus,
      hookTimeoutMs: 500,
    });
    await registry.loadAll();

    const info = registry.list().find((p) => p.id === "p-gear-replace");
    expect(info!.gearItem).toEqual(second);
  });
});
