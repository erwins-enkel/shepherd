// ci-watch plugin (#2540): loads from the real bundled dir and is inert by default.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";

const BUNDLED = resolve(import.meta.dir, "../src/plugins/bundled");

test("ci-watch loads as a bundled plugin", async () => {
  const empty = mkdtempSync(join(tmpdir(), "shep-ciwatch-reg-"));
  const secretsDir = mkdtempSync(join(tmpdir(), "shep-ciwatch-sec-"));
  try {
    const reg = new PluginRegistry({
      pluginsDir: empty,
      bundledPluginsDir: BUNDLED,
      store: new SessionStore(":memory:"),
      events: new EventHub(),
      repos: () => [],
      secretsPath: join(secretsDir, "secrets.json"),
    });
    await reg.loadAll();
    const p = reg.list().find((x) => x.id === "ci-watch");
    expect(p).toMatchObject({ id: "ci-watch", bundled: true });
    expect(p?.health).not.toBe("errored");
    expect(p?.lastError).toBeFalsy();
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  }
});
