// ctx.secrets (issue #2461): 0600 file under the data dir, per-plugin isolation, never present
// in config.json or any core-served plugin payload (list, plugin:* events, GET /api/plugins).
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import { makeApp, type AppDeps } from "../src/server";
import type { PluginContext } from "../src/plugins/types";

/** Test plugins stash their ctx here under their manifest id (static source, no code built from data). */
const g = ((
  globalThis as unknown as { __shepTestCtx?: Record<string, PluginContext> }
).__shepTestCtx ??= {});
const TOKEN = "sntrys_supersecret_token_123";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shep-secrets-"));
  const pluginsDir = join(root, "plugins");
  mkdirSync(pluginsDir);
  return { root, pluginsDir, secretsPath: join(root, "plugin-secrets.json") };
}

function writePlugin(pluginsDir: string, id: string): string {
  mkdirSync(join(pluginsDir, id));
  writeFileSync(
    join(pluginsDir, id, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1 }),
  );
  writeFileSync(
    join(pluginsDir, id, "index.js"),
    `export function register(ctx) { (globalThis.__shepTestCtx ??= {})[ctx.manifest.id] = ctx; }`,
  );
  return id;
}

async function load(pluginsDir: string, secretsPath: string | undefined, events = new EventHub()) {
  const registry = new PluginRegistry({
    pluginsDir,
    store: new SessionStore(":memory:"),
    events,
    secretsPath,
  });
  await registry.loadAll();
  return registry;
}

test("get/set/unset round-trip, isolated per plugin, persisted across reload", async () => {
  const { pluginsDir, secretsPath } = setup();
  const ka = writePlugin(pluginsDir, "a");
  const kb = writePlugin(pluginsDir, "b");
  await load(pluginsDir, secretsPath);
  const a = g[ka]!;
  const b = g[kb]!;
  expect(a.secrets.get("token")).toBeNull();
  await a.secrets.set("token", TOKEN);
  expect(a.secrets.get("token")).toBe(TOKEN);
  expect(b.secrets.get("token")).toBeNull();

  const ka2 = writePlugin(pluginsDir, "c"); // a new plugin sees none of a's secrets
  await load(pluginsDir, secretsPath);
  expect(g[ka]!.secrets.get("token")).toBe(TOKEN);
  expect(g[ka2]!.secrets.get("token")).toBeNull();

  await g[ka]!.secrets.set("token", null);
  expect(g[ka]!.secrets.get("token")).toBeNull();
  expect(JSON.parse(readFileSync(secretsPath, "utf8"))).toEqual({});
});

test("secrets file is written with mode 0600, and a looser pre-existing file is tightened", async () => {
  const { pluginsDir, secretsPath } = setup();
  writeFileSync(secretsPath, "{}");
  chmodSync(secretsPath, 0o644);
  const k = writePlugin(pluginsDir, "p");
  await load(pluginsDir, secretsPath);
  await g[k]!.secrets.set("token", TOKEN);
  expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  expect(existsSync(`${secretsPath}.tmp`)).toBe(false);
});

test("an unparseable secrets file is never clobbered: set rejects, file untouched", async () => {
  const { pluginsDir, secretsPath } = setup();
  writeFileSync(secretsPath, "{not json");
  const k = writePlugin(pluginsDir, "p");
  await load(pluginsDir, secretsPath);
  expect(g[k]!.secrets.get("token")).toBeNull();
  await expect(g[k]!.secrets.set("token", TOKEN)).rejects.toThrow();
  expect(readFileSync(secretsPath, "utf8")).toBe("{not json");
});

test("no secrets path wired → get null, set rejects", async () => {
  const { pluginsDir } = setup();
  const k = writePlugin(pluginsDir, "p");
  await load(pluginsDir, undefined);
  expect(g[k]!.secrets.get("token")).toBeNull();
  await expect(g[k]!.secrets.set("token", TOKEN)).rejects.toThrow(/unavailable/);
});

test("set validates key and value", async () => {
  const { pluginsDir, secretsPath } = setup();
  const k = writePlugin(pluginsDir, "p");
  await load(pluginsDir, secretsPath);
  await expect(g[k]!.secrets.set("", TOKEN)).rejects.toThrow();
  await expect(g[k]!.secrets.set("t", 42 as unknown as string)).rejects.toThrow();
});

test("a secret never reaches config.json, list(), plugin:* events or GET /api/plugins", async () => {
  const { pluginsDir, secretsPath } = setup();
  const k = writePlugin(pluginsDir, "p");
  const events = new EventHub();
  const emitted: unknown[] = [];
  events.subscribe((e, d) => {
    if (e.startsWith("plugin:")) emitted.push(d);
  });
  const registry = await load(pluginsDir, secretsPath, events);
  const ctx = g[k]!;
  await ctx.secrets.set("token", TOKEN);
  await ctx.setConfig({ dsn: "https://sentry.example" });

  // A careless plugin echoes the secret everywhere it can publish.
  ctx.publishStatus({ note: `using ${TOKEN}`, [TOKEN]: 1 });
  ctx.publishUI({
    schemaVersion: 1,
    slot: "settings-panel",
    root: {
      type: "stack",
      children: [
        { type: "text", props: { text: TOKEN } },
        { type: "text-input", props: { name: "token", secret: true, value: TOKEN } },
      ],
    },
  });
  ctx.publishGearItem({
    label: "Open",
    action: { kind: "url", href: `https://x.example/?t=${TOKEN}` },
  });

  expect(readFileSync(join(pluginsDir, "p", "config.json"), "utf8")).not.toContain(TOKEN);
  expect(JSON.stringify(registry.list())).not.toContain(TOKEN);
  expect(JSON.stringify(emitted)).not.toContain(TOKEN);
  expect(JSON.stringify(registry.list())).toContain("[redacted]");

  const app = makeApp({ pluginRegistry: registry } as unknown as AppDeps);
  const res = await app.fetch(new Request("http://x/api/plugins"));
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain(TOKEN);
});

test("prototype-named keys and plugin ids are ordinary entries, not prototype lookups", async () => {
  const { pluginsDir, secretsPath } = setup();
  const k = writePlugin(pluginsDir, "constructor");
  await load(pluginsDir, secretsPath);
  const ctx = g[k]!;
  expect(ctx.secrets.get("token")).toBeNull();
  await ctx.secrets.set("token", TOKEN);
  expect(ctx.secrets.get("constructor")).toBeNull();
  expect(ctx.secrets.get("toString")).toBeNull();
  await ctx.secrets.set("__proto__", "proto-value");
  expect(ctx.secrets.get("__proto__")).toBe("proto-value");

  const k2 = writePlugin(pluginsDir, "other");
  await load(pluginsDir, secretsPath); // round-trips through the file
  expect(g[k]!.secrets.get("__proto__")).toBe("proto-value");
  expect(g[k]!.secrets.get("token")).toBe(TOKEN);
  expect(g[k2]!.secrets.get("constructor")).toBeNull();
});

test("a secret nested inside a longer one is redacted without leaking the longer one's tail", async () => {
  const { pluginsDir, secretsPath } = setup();
  const k = writePlugin(pluginsDir, "p");
  const registry = await load(pluginsDir, secretsPath);
  const ctx = g[k]!;
  await ctx.secrets.set("short", "abcd1234"); // inserted first — the failure order
  await ctx.secrets.set("long", "abcd1234-SECRET-TAIL");
  ctx.publishStatus({ note: "abcd1234-SECRET-TAIL and abcd1234" });
  const out = JSON.stringify(registry.list());
  expect(out).not.toContain("SECRET-TAIL");
  expect(out).not.toContain("abcd1234");
  expect(out).toContain("[redacted] and [redacted]");
});
