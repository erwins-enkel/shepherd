import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE } from "../src/operator-auth";
import type { FetchLike } from "../src/remote-instances/client";
import { RemoteInstanceService } from "../src/remote-instances/service";
import { type LocalRepo, SettingsSourceService } from "../src/settings-source";
import { loadSteers } from "../src/steers";
import { loadIcons } from "../src/project-icons";

// A settings source (#3967) through the real routes: two Shepherds in one process (the harness of
// server-remote-instances.test.ts). B connects A and uses it as its settings source, so B's steers
// and repo-emoji routes read and write A through A's real auth seam and routes.

const SECRET = "test-cookie-signing-secret";
const SLUG = "acme/linux-app";

const operator = () => ({
  "content-type": "application/json",
  Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}`,
});

interface Instance {
  deps: AppDeps;
  app: ReturnType<typeof makeApp>;
  events: { event: string; data: unknown }[];
}

const instances = new Map<string, Instance>();

/** Routes `http://<host>/…` to the in-process app registered under that host. */
const routedFetch: FetchLike = async (url, init) => {
  const target = instances.get(new URL(url).host);
  if (!target) throw new TypeError("Unable to connect");
  return target.app.fetch(new Request(url, init));
};

/** One Shepherd. Both share the global `config.repoRoot`, so B is given its own checkouts list
 *  (`localRepos`) instead: the same project in another directory under another name. */
function makeInstance(host: string, localRepos?: LocalRepo[]): Instance {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {} as never,
    herdr: { list: () => [] } as never,
    events,
  });
  const remoteInstances = new RemoteInstanceService({ store, fetch: routedFetch });
  const deps: AppDeps = {
    store,
    service,
    events,
    remoteInstances,
    resolveForge: (() => ({ slug: SLUG, isFork: false })) as unknown as AppDeps["resolveForge"],
    usageLimits: {
      limits: () => ({
        session5h: null,
        week: null,
        perModelWeek: [],
        credits: null,
        stale: true,
        calibratedAt: null,
        subscriptionOnly: false,
      }),
      projections: () => [],
    },
  };
  if (localRepos) {
    deps.settingsSource = new SettingsSourceService({
      store,
      instances: remoteInstances,
      emit: (event, data) => events.emit(event, data),
      localRepos: () => localRepos,
      localSteers: () => loadSteers(store, config.standardCommand),
      localIcons: () => loadIcons(store),
      fetch: routedFetch,
    });
  }
  const seen: Instance["events"] = [];
  events.subscribe((event, data) => seen.push({ event, data }));
  const instance = { deps, app: makeApp(deps), events: seen };
  instances.set(host, instance);
  return instance;
}

async function call(
  i: Instance,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = operator(),
) {
  const res = await i.app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as unknown };
}

async function mint(i: Instance) {
  const res = await call(i, "POST", "/api/access-tokens", {
    name: "machine",
    expiresInDays: null,
    scope: "full",
    repoPaths: null,
  });
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const LOCAL_PATH = "/elsewhere/other-name";
const B_REPOS: LocalRepo[] = [{ path: LOCAL_PATH, realPath: LOCAL_PATH, slug: SLUG }];
const A_STEERS = [
  { label: "ship it", text: "ship it", inSteerBar: true, onIssues: false },
  { label: "triage", text: "triage the issue", inSteerBar: false, onIssues: true },
];

let prev: { secret: string | null; hash: string | null; token: string | null; root: string };
let repoRoot: string;
let appPath: string;

beforeEach(async () => {
  prev = {
    secret: config.cookieSecret,
    hash: config.passwordHash,
    token: config.token,
    root: config.repoRoot,
  };
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword("pw");
  config.token = null;
  repoRoot = mkdtempSync(join(tmpdir(), "shepherd-settings-source-"));
  mkdirSync(join(repoRoot, "app"));
  config.repoRoot = repoRoot;
  appPath = join(repoRoot, "app");
});

afterEach(() => {
  config.cookieSecret = prev.secret;
  config.passwordHash = prev.hash;
  config.token = prev.token;
  config.repoRoot = prev.root;
  instances.clear();
  rmSync(repoRoot, { recursive: true, force: true });
});

/** A with its own steers and an emoji, B connected to A and (unless `use` is false) using it as
 *  its settings source. */
async function pair(use = true) {
  const a = makeInstance("a.test");
  const b = makeInstance("b.test", B_REPOS);
  await call(a, "PUT", "/api/steers", A_STEERS);
  // A's own read, which also runs its one-time steers migration.
  const aSteers = (await call(a, "GET", "/api/steers")).body;
  await call(a, "PUT", "/api/project-icons", { path: appPath, emoji: "🐧" });
  const aId = (await call(a, "GET", "/api/instance")).body as { instanceId: string };
  expect(
    (
      await call(b, "POST", "/api/remote-instances", {
        url: "http://a.test",
        token: await mint(a),
      })
    ).status,
  ).toBe(201);
  const bOwn = (await call(b, "GET", "/api/steers")).body;
  if (use) {
    const set = await call(b, "PUT", "/api/settings-source", { instanceId: aId.instanceId });
    expect(set.status).toBe(200);
    await flush();
  }
  return { a, b, aId: aId.instanceId, aSteers, bOwn };
}

describe("GET/PUT /api/settings-source", () => {
  test("no source by default; the operator picks a connected machine", async () => {
    const { b, aId } = await pair(false);
    expect((await call(b, "GET", "/api/settings-source")).body).toEqual({ source: null });
    const set = await call(b, "PUT", "/api/settings-source", { instanceId: aId });
    expect(set.body).toEqual({
      source: {
        instanceId: aId,
        name: expect.any(String),
        reachable: true,
        repos: [
          {
            name: "app",
            path: appPath,
            realPath: realpathSync(appPath),
            remoteSlug: SLUG,
          },
        ],
      },
    });
    expect((await call(b, "GET", "/api/settings-source")).body).toEqual(set.body);
    expect(b.events.find((e) => e.event === "settings-source:update")?.data).toEqual(
      (set.body as { source: unknown }).source,
    );
  });

  test("a bearer token cannot pick the source; bad bodies and unknown machines are refused", async () => {
    const { b, aId } = await pair(false);
    const bearer = { authorization: `Bearer ${await mint(b)}`, "content-type": "application/json" };
    const denied = await call(b, "PUT", "/api/settings-source", { instanceId: aId }, bearer);
    expect(denied).toEqual({ status: 403, body: { error: "operator_session_required" } });
    expect((await call(b, "GET", "/api/settings-source", undefined, bearer)).status).toBe(200);
    for (const body of [{}, { instanceId: "nope" }, { instanceId: aId, x: 1 }]) {
      expect(await call(b, "PUT", "/api/settings-source", body)).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
    }
    const unknown = await call(b, "PUT", "/api/settings-source", {
      instanceId: "22222222-2222-4222-8222-222222222222",
    });
    expect(unknown).toEqual({ status: 404, body: { error: "not found" } });
  });
});

describe("steers from the settings source", () => {
  test("B serves A's steers, not its own defaults, and writes go to A", async () => {
    const { a, b, aSteers } = await pair();
    expect((await call(b, "GET", "/api/steers")).body).toEqual(aSteers);

    const next = [{ label: "from B", text: "written on B", inSteerBar: true, onIssues: false }];
    const put = await call(b, "PUT", "/api/steers", next);
    expect(put.status).toBe(200);
    const onA = (await call(a, "GET", "/api/steers")).body;
    expect(put.body).toEqual(onA);
    expect(onA).toEqual([expect.objectContaining(next[0]!)]);
    expect(a.events.filter((e) => e.event === "steers:update").at(-1)?.data).toEqual(onA);
    expect(b.events.filter((e) => e.event === "steers:update").at(-1)?.data).toEqual(onA);
  });

  test("out of reach: the cache is served and writes are refused; back in reach, current", async () => {
    const { a, b, aId, aSteers } = await pair();
    instances.delete("a.test");
    await call(b, "POST", `/api/remote-instances/${aId}/check`);
    expect((await call(b, "GET", "/api/settings-source")).body).toMatchObject({
      source: { reachable: false },
    });
    expect((await call(b, "GET", "/api/steers")).body).toEqual(aSteers);
    expect((await call(b, "GET", "/api/project-icons")).body).toMatchObject({ [LOCAL_PATH]: "🐧" });
    const refused = await call(b, "PUT", "/api/steers", A_STEERS);
    expect(refused).toEqual({
      status: 503,
      body: { error: expect.any(String), code: "settings_source_unreachable" },
    });
    const icon = await call(b, "PUT", "/api/project-icons", { path: LOCAL_PATH, emoji: "🦀" });
    expect(icon.status).toBe(503);

    await call(a, "PUT", "/api/steers", [A_STEERS[1]]);
    instances.set("a.test", a);
    await call(b, "POST", `/api/remote-instances/${aId}/check`);
    await flush();
    const current = (await call(a, "GET", "/api/steers")).body;
    expect(b.events.filter((e) => e.event === "steers:update").at(-1)?.data).toEqual(current);
    expect((await call(b, "GET", "/api/steers")).body).toEqual(current);
  });

  test("clearing the source, or removing the machine, brings back B's own steers untouched", async () => {
    const { b, aId, bOwn } = await pair();
    expect((await call(b, "PUT", "/api/settings-source", { instanceId: null })).body).toEqual({
      source: null,
    });
    expect((await call(b, "GET", "/api/steers")).body).toEqual(bOwn);

    await call(b, "PUT", "/api/settings-source", { instanceId: aId });
    await flush();
    expect((await call(b, "DELETE", `/api/remote-instances/${aId}`)).status).toBe(200);
    expect((await call(b, "GET", "/api/settings-source")).body).toEqual({ source: null });
    expect((await call(b, "GET", "/api/steers")).body).toEqual(bOwn);
  });

  test("a relayed request is answered from the server's own settings, never its source", async () => {
    const { b, bOwn } = await pair();
    const relay = { ...operator(), "x-shepherd-settings-relay": "1" };
    expect((await call(b, "GET", "/api/steers", undefined, relay)).body).toEqual(bOwn);
    const before = b.events.length;
    const local = [{ label: "local", text: "local", inSteerBar: true, onIssues: false }];
    expect((await call(b, "PUT", "/api/steers", local, relay)).status).toBe(200);
    // B's clients show A's steers: B's own changed list is not announced to them.
    expect(b.events.slice(before).map((e) => e.event)).not.toContain("steers:update");
    expect((await call(b, "GET", "/api/steers", undefined, relay)).body).toEqual([
      expect.objectContaining(local[0]!),
    ]);
  });
});

describe("repo emojis from the settings source", () => {
  test("A's emoji shows under A's paths, the project and B's checkout of the same project", async () => {
    const { b } = await pair();
    expect((await call(b, "GET", "/api/project-icons")).body).toEqual({
      [appPath]: "🐧",
      [realpathSync(appPath)]: "🐧",
      [`project:${SLUG}`]: "🐧",
      [LOCAL_PATH]: "🐧",
    });
  });

  test("an emoji set on B's checkout lands on A under A's path; another project is refused", async () => {
    const { a, b } = await pair();
    const put = await call(b, "PUT", "/api/project-icons", { path: LOCAL_PATH, emoji: "🦀" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ [LOCAL_PATH]: "🦀", [appPath]: "🦀" });
    expect((await call(a, "GET", "/api/project-icons")).body).toEqual({ [appPath]: "🦀" });
    expect(b.events.filter((e) => e.event === "project-icons:update").at(-1)?.data).toMatchObject({
      [LOCAL_PATH]: "🦀",
    });

    const refused = await call(b, "PUT", "/api/project-icons", { path: "/nowhere", emoji: "🦀" });
    expect(refused).toEqual({
      status: 409,
      body: { error: expect.any(String), code: "settings_source_no_repo" },
    });
  });

  test("clearing the source brings back B's own emojis", async () => {
    const { b } = await pair(false);
    await call(b, "PUT", "/api/project-icons", { path: LOCAL_PATH, emoji: "🏠" });
    const aId = (
      (await call(b, "GET", "/api/remote-instances")).body as {
        instances: { instanceId: string }[];
      }
    ).instances[0]!.instanceId;
    await call(b, "PUT", "/api/settings-source", { instanceId: aId });
    await flush();
    expect((await call(b, "GET", "/api/project-icons")).body).toMatchObject({ [LOCAL_PATH]: "🐧" });
    await call(b, "PUT", "/api/settings-source", { instanceId: null });
    expect((await call(b, "GET", "/api/project-icons")).body).toEqual({ [LOCAL_PATH]: "🏠" });
  });
});
