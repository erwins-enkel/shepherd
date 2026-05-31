import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

let tmp: string;
let savedRoot: string;
let savedCeiling: string;

beforeEach(() => {
  // realpath so comparisons hold where tmpdir() is a symlink (macOS)
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-settings-test-")));
  mkdirSync(join(tmp, "child"));
  savedRoot = config.repoRoot; // PUT mutates the shared config; restore after
  savedCeiling = config.rootCeiling;
  // the ceiling is the immutable boundary; point it at our temp dir for the test so
  // dirs inside tmp validate and the dir browser is confined to tmp.
  config.rootCeiling = tmp;
});

afterEach(() => {
  config.repoRoot = savedRoot;
  config.rootCeiling = savedCeiling;
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
  const child = join(tmp, "child");
  const res = await put(app, { repoRoot: child });
  expect(res.status).toBe(200);
  expect((await res.json()).repoRoot).toBe(child);
  // runtime config updated
  expect(config.repoRoot).toBe(child);
  // persisted
  expect(store.getSetting("repoRoot")).toBe(child);
  // reflected by a subsequent GET
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.repoRoot).toBe(child);
});

test("PUT /api/settings with a dir inside the ceiling → 200", async () => {
  const { app } = harness();
  const res = await put(app, { repoRoot: join(tmp, "child") });
  expect(res.status).toBe(200);
});

test("PUT /api/settings with a dir OUTSIDE the ceiling → 400", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  for (const outside of ["/etc", "/tmp", "/"]) {
    const res = await put(app, { repoRoot: outside });
    expect(res.status).toBe(400);
  }
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("PUT /api/settings rejects a non-existent directory", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  const res = await put(app, { repoRoot: join(tmp, "does-not-exist") });
  expect(res.status).toBe(400);
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("GET /api/fs/dirs lists sub-directories within the ceiling", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request(`http://x/api/fs/dirs?path=${encodeURIComponent(tmp)}`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["child"]);
  expect(body.parent).toBeNull(); // at the ceiling → no parent
});

test("GET /api/fs/dirs?path=/ stays clamped to the ceiling (never escapes to '/')", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/fs/dirs?path=/"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.parent).toBeNull();
});
