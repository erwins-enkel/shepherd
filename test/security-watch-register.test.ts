// security-watch: loads from the real bundled dir and is inert by default.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import type { GitForge } from "../src/forge/types";

const BUNDLED = resolve(import.meta.dir, "../src/plugins/bundled");
const ID = "security-watch";

async function load() {
  const empty = mkdtempSync(join(tmpdir(), "shep-secwatch-reg-"));
  const secretsDir = mkdtempSync(join(tmpdir(), "shep-secwatch-sec-"));
  const calls: string[] = [];
  const forge = {
    listCodeScanningAlerts: async () => {
      calls.push("list");
      return { status: "ok", alerts: [], truncated: false };
    },
    listDependabotAlerts: async () => {
      calls.push("list");
      return { status: "ok", alerts: [], truncated: false };
    },
    repoVisibility: async () => {
      calls.push("visibility");
      return "public";
    },
  } as unknown as GitForge;
  const reg = new PluginRegistry({
    pluginsDir: empty,
    bundledPluginsDir: BUNDLED,
    store: new SessionStore(":memory:"),
    events: new EventHub(),
    repos: () => [{ path: empty, name: "web", autoLabel: "a", lightweight: false }],
    secretsPath: join(secretsDir, "secrets.json"),
    forge: { repoRoot: tmpdir(), resolveForge: () => forge },
  });
  await reg.loadAll();
  const post = (path: string, body: unknown) =>
    reg.handleRoute(
      "POST",
      ID,
      path,
      new Request("http://x/", { method: "POST", body: JSON.stringify(body) }),
    );
  const info = () => reg.list().find((x) => x.id === ID);
  const cleanup = () => {
    reg.teardown();
    rmSync(empty, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  };
  return { post, info, cleanup, calls, repo: empty };
}

test("loads as a bundled plugin, healthy, with a panel", async () => {
  const { info, cleanup } = await load();
  try {
    expect(info()).toMatchObject({ id: ID, bundled: true });
    expect(info()?.health).not.toBe("errored");
    expect(JSON.stringify(info()?.ui)).toContain("Security Watch");
  } finally {
    cleanup();
  }
});

test("disabled: poll now makes no forge calls", async () => {
  const { post, calls, cleanup, repo } = await load();
  try {
    await post("repo/add", { addRepo: repo });
    await post("poll-now", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  } finally {
    cleanup();
  }
});

test("routes persist settings; adding a repo shows the disclosure notice", async () => {
  const { post, info, cleanup, repo } = await load();
  try {
    expect((await post("settings", { enabled: false, locale: "de" }))?.status).toBe(200);
    expect(JSON.stringify(info()?.ui)).toContain("Einstellungen");
    expect((await post("repo/add", { addRepo: "/nope" }))?.status).toBe(400);
    expect((await post("repo/add", { addRepo: repo }))?.status).toBe(200);
    expect(JSON.stringify(info()?.ui)).toContain("Ich akzeptiere");
    expect((await post("triage/file-anyway", {}))?.status).toBe(400);
    expect((await post("triage/file-anyway", { id: "map:nope" }))?.status).toBe(404);
    expect((await post("triage/file-again", { id: "map:nope" }))?.status).toBe(404);
  } finally {
    cleanup();
  }
});
