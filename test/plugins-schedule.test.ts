// ctx.schedule (issue #2461): server-owned interval, paused during herdr maintenance,
// no overlapping runs, cleared on cancel / teardown / failed register, errors surfaced.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import type { PluginContext } from "../src/plugins/types";

const TICK = 10;
/** Test plugins stash their ctx here under their manifest id (static source, no code built from data). */
const g = ((
  globalThis as unknown as { __shepTestCtx?: Record<string, PluginContext> }
).__shepTestCtx ??= {});
const registries: PluginRegistry[] = [];

afterEach(() => {
  for (const r of registries.splice(0)) r.teardown();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Load one plugin that stashes its ctx on `g` so the test drives ctx.schedule. */
async function loadCtx(opts: { maintenance?: () => boolean; index?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "shep-sched-"));
  const id = `sched-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(root, id));
  writeFileSync(
    join(root, id, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1 }),
  );
  writeFileSync(
    join(root, id, "index.js"),
    opts.index ??
      `export function register(ctx) { (globalThis.__shepTestCtx ??= {})[ctx.manifest.id] = ctx; }`,
  );
  const events = new EventHub();
  const registry = new PluginRegistry({
    pluginsDir: root,
    store: new SessionStore(":memory:"),
    events,
    maintenanceActive: opts.maintenance,
    minScheduleIntervalMs: TICK,
  });
  registries.push(registry);
  await registry.loadAll();
  return { ctx: g[id]!, registry, events, id };
}

test("schedule runs fn repeatedly", async () => {
  const { ctx } = await loadCtx();
  let runs = 0;
  ctx.schedule(TICK, async () => {
    runs++;
  });
  await wait(TICK * 10);
  expect(runs).toBeGreaterThanOrEqual(2);
});

test("schedule skips ticks while maintenance is active, resumes after", async () => {
  let active = true;
  const { ctx } = await loadCtx({ maintenance: () => active });
  let runs = 0;
  ctx.schedule(TICK, async () => {
    runs++;
  });
  await wait(TICK * 6);
  expect(runs).toBe(0);
  active = false;
  await wait(TICK * 6);
  expect(runs).toBeGreaterThan(0);
});

test("cancel fn stops the schedule", async () => {
  const { ctx } = await loadCtx();
  let runs = 0;
  const cancel = ctx.schedule(TICK, async () => {
    runs++;
  });
  await wait(TICK * 4);
  cancel();
  const at = runs;
  await wait(TICK * 5);
  expect(runs).toBe(at);
});

test("teardown (plugin unload) stops the schedule", async () => {
  const { ctx, registry } = await loadCtx();
  let runs = 0;
  ctx.schedule(TICK, async () => {
    runs++;
  });
  await wait(TICK * 4);
  registry.teardown();
  const at = runs;
  await wait(TICK * 5);
  expect(runs).toBe(at);
});

test("a schedule created by a register() that then throws is cleared", async () => {
  const counter = `schedCount${Math.random().toString(36).slice(2)}`;
  const { registry } = await loadCtx({
    index: `export function register(ctx) {
      globalThis.${counter} = 0;
      ctx.schedule(${TICK}, async () => { globalThis.${counter}++; });
      throw new Error("boom");
    }`,
  });
  expect(registry.list()[0]!.health).toBe("errored");
  await wait(TICK * 5);
  expect((globalThis as Record<string, unknown>)[counter]).toBe(0);
});

test("a failing run marks the plugin errored, emits plugin:status, keeps ticking", async () => {
  const { ctx, registry, events, id } = await loadCtx();
  const statuses: unknown[] = [];
  events.subscribe((e, d) => {
    if (e === "plugin:status") statuses.push(d);
  });
  let runs = 0;
  ctx.schedule(TICK, async () => {
    runs++;
    throw new Error("sentry 503");
  });
  await wait(TICK * 8);
  const info = registry.list().find((p) => p.id === id)!;
  expect(info.health).toBe("errored");
  expect(info.lastError).toBe("sentry 503");
  expect(statuses.length).toBeGreaterThan(0);
  expect(runs).toBeGreaterThanOrEqual(2);
});

test("no overlap: a tick is skipped while the previous run is still in flight", async () => {
  const { ctx } = await loadCtx();
  let inFlight = 0;
  let maxInFlight = 0;
  ctx.schedule(TICK, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await wait(TICK * 4);
    inFlight--;
  });
  await wait(TICK * 12);
  expect(maxInFlight).toBe(1);
});

test("interval below the floor throws", async () => {
  const { ctx } = await loadCtx();
  expect(() => ctx.schedule(TICK - 1, async () => {})).toThrow();
  expect(() => ctx.schedule(Number.NaN, async () => {})).toThrow();
});
