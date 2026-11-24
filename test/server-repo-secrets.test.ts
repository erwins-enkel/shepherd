/** Operator routes for per-repo agent secrets (#4122): `/api/repo-secrets?repo=`. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSecretStore } from "../src/agent-secrets";
import { config } from "../src/config";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import { AccessTokenService } from "../src/access-tokens";

const VALUE = "ghp_superSecretValue123";
const savedRoot = config.repoRoot;
let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-secrets-")));
  mkdirSync(join(tmp, "root", "app"), { recursive: true });
  config.repoRoot = join(tmp, "root");
  repo = join(tmp, "root", "app");
});
afterEach(() => {
  config.repoRoot = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function setup(opts: { store?: boolean; skipAuth?: boolean } = {}) {
  const store = new SessionStore(":memory:");
  const agentSecrets =
    opts.store === false ? undefined : new AgentSecretStore(join(tmp, "agent-secrets.json"));
  const deps = { store, events: new EventHub(), service: {}, agentSecrets } as unknown as AppDeps;
  const app = makeApp(deps, { skipAuth: opts.skipAuth });
  const url = (repoPath: string, extra = "") =>
    `http://x/api/repo-secrets?repo=${encodeURIComponent(repoPath)}${extra}`;
  const get = (repoPath = repo) => app.fetch(new Request(url(repoPath)));
  const put = (body: unknown, repoPath = repo) =>
    app.fetch(
      new Request(url(repoPath), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const del = (name: string, repoPath = repo) =>
    app.fetch(
      new Request(url(repoPath, `&name=${encodeURIComponent(name)}`), { method: "DELETE" }),
    );
  return { app, store, agentSecrets, get, put, del };
}

test("GET lists names + timestamps + lastInjectedAt and never the value", async () => {
  const { store, get, put } = setup();
  expect(await (await get()).json()).toEqual({ secrets: [] });
  const saved = (await (await put({ name: "PKG_TOKEN", value: VALUE })).json()) as {
    name: string;
    updatedAt: number;
  };
  expect(saved).toEqual({ name: "PKG_TOKEN", updatedAt: expect.any(Number) });
  await put({ name: "OTHER", value: "another-value" });
  store.recordAgentSecretInjection("s1", repo, ["PKG_TOKEN"], 1234);

  const res = await get();
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(VALUE);
  expect(JSON.parse(text)).toEqual({
    secrets: [
      { name: "OTHER", updatedAt: expect.any(Number), lastInjectedAt: null },
      { name: "PKG_TOKEN", updatedAt: saved.updatedAt, lastInjectedAt: 1234 },
    ],
  });
});

test("PUT replaces a value; DELETE removes it and reports whether it existed", async () => {
  const { agentSecrets, get, put, del } = setup();
  await put({ name: "PKG_TOKEN", value: VALUE });
  expect((await put({ name: "PKG_TOKEN", value: "rotated\n" })).status).toBe(200);
  expect(agentSecrets!.entries(repo)).toEqual({ PKG_TOKEN: "rotated" });

  const res = await del("PKG_TOKEN");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deleted: true });
  expect(await (await del("PKG_TOKEN")).json()).toEqual({ deleted: false });
  expect(await (await get()).json()).toEqual({ secrets: [] });
});

test("invalid names, reserved names, bad values, bad bodies and bad repos are 400s", async () => {
  const { put, del, get, agentSecrets } = setup();
  const errorOf = async (res: Response) => [res.status, ((await res.json()) as any).error];
  expect(await errorOf(await put({ name: "1BAD", value: "x" }))).toEqual([400, "invalid-name"]);
  expect(await errorOf(await put({ name: "GH_TOKEN", value: "x" }))).toEqual([
    400,
    "reserved-name",
  ]);
  expect(await errorOf(await put({ name: "CLAUDE_X", value: "x" }))).toEqual([
    400,
    "reserved-name",
  ]);
  expect(await errorOf(await put({ name: "OK", value: "\n" }))).toEqual([400, "invalid-value"]);
  expect((await put({ name: "OK", value: 42 })).status).toBe(400);
  expect((await put(["OK", "x"])).status).toBe(400);
  expect(await errorOf(await del("bad-name"))).toEqual([400, "invalid-name"]);
  expect(await errorOf(await get(join(tmp, "elsewhere")))).toEqual([400, "invalid repo"]);
  expect(await errorOf(await put({ name: "OK", value: "x" }, "/etc"))).toEqual([
    400,
    "invalid repo",
  ]);
  expect(agentSecrets!.list(repo)).toEqual([]);
});

test("PUT needs a JSON content type and a bounded body", async () => {
  const { app } = setup();
  const url = `http://x/api/repo-secrets?repo=${encodeURIComponent(repo)}`;
  const plain = await app.fetch(
    new Request(url, { method: "PUT", body: JSON.stringify({ name: "OK", value: "x" }) }),
  );
  expect(plain.status).toBe(415);
  const huge = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "OK", value: "\u0001".repeat(20000) }),
    }),
  );
  expect(huge.status).toBe(413);
});

test("the agent ingress and repo-scoped tokens are refused (403)", async () => {
  const ingress = setup({ skipAuth: true });
  for (const res of [
    await ingress.get(),
    await ingress.put({ name: "OK", value: "x" }),
    await ingress.del("OK"),
  ]) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "insufficient_scope" });
  }
  expect(ingress.agentSecrets!.list(repo)).toEqual([]);

  // A full-scope token restricted to this very repo is still not the operator; an unrestricted
  // full token is.
  const saved = { secret: config.cookieSecret, token: config.token };
  config.cookieSecret = "repo-secrets-test";
  config.token = null;
  try {
    const store = new SessionStore(":memory:");
    const tokens = new AccessTokenService(store);
    const app = makeApp({
      store,
      events: new EventHub(),
      service: {},
      accessTokens: tokens,
      agentSecrets: new AgentSecretStore(join(tmp, "agent-secrets.json")),
    } as unknown as AppDeps);
    const call = (token: string, method = "GET", body?: unknown) =>
      app.fetch(
        new Request(`http://localhost/api/repo-secrets?repo=${encodeURIComponent(repo)}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const scoped = tokens.mint("scoped", null, "full", [repo]).token;
    for (const res of [await call(scoped), await call(scoped, "PUT", { name: "OK", value: "x" })])
      expect(res.status).toBe(403);
    const full = tokens.mint("full", null, "full", null).token;
    expect((await call(full)).status).toBe(200);
  } finally {
    config.cookieSecret = saved.secret;
    config.token = saved.token;
  }
});

test("no store → 503", async () => {
  const { get, put } = setup({ store: false });
  expect((await get()).status).toBe(503);
  expect(await (await put({ name: "OK", value: "x" })).json()).toEqual({
    error: "agent secrets unavailable",
  });
});

test("a symlinked repo root round-trips: what the route stores is what a task spawn gets", async () => {
  // Sessions carry resolve()d (not realpath'd) repoPaths; the route keys by safeRepoDir's realpath.
  const link = join(tmp, "link-root");
  symlinkSync(join(tmp, "root"), link);
  config.repoRoot = link;
  const sessionRepoPath = join(link, "app");
  expect(sessionRepoPath).not.toBe(repo);
  const { put, get, store, agentSecrets } = setup();
  expect((await put({ name: "PKG_TOKEN", value: VALUE }, sessionRepoPath)).status).toBe(200);

  const spawnDir = join(tmp, "spawn");
  mkdirSync(spawnDir);
  const svc = new SessionService({
    store,
    events: new EventHub(),
    namer: async () => "s",
    worktree: {} as never,
    herdr: {} as never,
    agentSpawnDir: spawnDir,
    agentSecrets,
  });
  const prep = await (svc as any).prepareAgentSecrets({
    sessionId: "s1",
    repoPath: sessionRepoPath,
  });
  expect(prep.names).toEqual(["PKG_TOKEN"]);
  expect(readFileSync(join(prep.dir, "PKG_TOKEN"), "utf8")).toBe(VALUE);
  // The audit row lands under the same key the route reads lastInjectedAt from.
  (svc as any).recordAgentSecretInjection("s1", prep.repoKey, prep.names);
  const listed = (await (await get(sessionRepoPath)).json()) as any;
  expect(listed.secrets).toEqual([
    { name: "PKG_TOKEN", updatedAt: expect.any(Number), lastInjectedAt: expect.any(Number) },
  ]);
});
