import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

let tmp: string;
let savedRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "shepherd-settings-test-"));
  mkdirSync(join(tmp, "child"));
  savedRoot = config.repoRoot; // PUT mutates the shared config; restore after
});

afterEach(() => {
  config.repoRoot = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

const put = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("GET /api/settings returns the current repo root", async () => {
  config.repoRoot = tmp;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.repoRoot).toBe(tmp);
  expect(typeof body.repoRootDisplay).toBe("string");
});

test("PUT /api/settings updates config, persists, and is reflected by GET", async () => {
  const { app, store } = harness();
  const res = await put(app, { repoRoot: tmp });
  expect(res.status).toBe(200);
  expect((await res.json()).repoRoot).toBe(tmp);
  // runtime config updated
  expect(config.repoRoot).toBe(tmp);
  // persisted
  expect(store.getSetting("repoRoot")).toBe(tmp);
  // reflected by a subsequent GET
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.repoRoot).toBe(tmp);
});

test("PUT /api/settings rejects a non-existent directory", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  const res = await put(app, { repoRoot: join(tmp, "does-not-exist") });
  expect(res.status).toBe(400);
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("GET /api/fs/dirs lists sub-directories of the given path", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request(`http://x/api/fs/dirs?path=${encodeURIComponent(tmp)}`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["child"]);
});
