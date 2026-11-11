import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { RemoteInstanceService } from "../src/remote-instances/service";
import { instanceIdentity } from "../src/remote-instances/identity";
import { config } from "../src/config";
import { SESSION_COOKIE, signCookie } from "../src/operator-auth";
import { configRepo, git } from "./helpers/repo-config-git";

const saved = { root: config.repoRoot, token: config.token, secret: config.cookieSecret };
let repo: ReturnType<typeof configRepo>;
const hosts: { server: { stop(close: boolean): void }; deps: AppDeps }[] = [];
const slug = "acme/project";
const project = `/api/repo-config/project?remoteSlug=${slug}`;
const headers = {
  cookie: `${SESSION_COOKIE}=${signCookie("repo-test-secret")}`,
  "content-type": "application/json",
};
function host(path: string | null) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    events,
    namer: async () => "x",
    worktree: {} as never,
    herdr: { list: () => [] } as never,
  });
  const deps: AppDeps = {
    store,
    events,
    service,
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
    remoteInstances: new RemoteInstanceService({ store }),
    resolveForge: ((dir: string) =>
      dir === path ? { slug, isFork: false } : null) as AppDeps["resolveForge"],
  };
  const app = makeApp(deps);
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      requests++;
      if (requests > 100) throw new Error("forwarding loop");
      return app.fetch(req);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const request = async (
    method: string,
    route: string,
    body?: unknown,
    auth: Record<string, string> = headers,
  ) => {
    const res = await fetch(base + route, {
      method,
      headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const h = {
    store,
    deps,
    server,
    base,
    request,
    id: instanceIdentity(store).instanceId,
    count: () => requests,
  };
  hosts.push(h);
  return h;
}
async function token(
  h: ReturnType<typeof host>,
  scope = "full",
  repoPaths: string[] | null = null,
) {
  const res = await h.request("POST", "/api/access-tokens", {
    name: "peer",
    expiresInDays: null,
    scope,
    repoPaths,
  });
  expect(res.status).toBe(201);
  return res.body.token as string;
}
async function connect(a: ReturnType<typeof host>, b: ReturnType<typeof host>) {
  const res = await a.request("POST", "/api/remote-instances", {
    url: b.base,
    token: await token(b),
  });
  expect(res.status).toBe(201);
}
beforeEach(() => {
  repo = configRepo();
  config.repoRoot = repo.dir;
  config.cookieSecret = "repo-test-secret";
  config.token = null;
});
afterEach(() => {
  for (const h of hosts.splice(0)) {
    h.server.stop(true);
    h.deps.remoteInstances?.stop();
  }
  repo.close();
  config.repoRoot = saved.root;
  config.token = saved.token;
  config.cookieSecret = saved.secret;
});
test("a coordinator with no checkout reads and writes only the selected machine", async () => {
  const a = host(null),
    b = host(repo.b);
  await connect(a, b);
  const route = `/api/repo-config/machine?remoteSlug=${slug}&instanceId=${b.id}`;
  expect((await a.request("GET", route)).body.maxAuto).toBe(1);
  expect((await a.request("PUT", route, { maxAuto: 7 })).status).toBe(200);
  expect(b.store.getLocalRepoConfig(repo.b).maxAuto).toBe(7);
  expect(a.store.getLocalRepoConfig(repo.b).maxAuto).toBe(1);
  expect((await a.request("PUT", route, { criticAllPrs: true })).status).toBe(400);
  const read = await a.request("GET", project);
  expect(read.status).toBe(200);
  expect(read.body.referenceInstanceId).toBe(b.id);
  b.server.stop(true);
  const failed = await a.request("PUT", route, { maxAuto: 9 });
  expect(failed.status).toBe(502);
  expect(a.store.getLocalRepoConfig(repo.b).maxAuto).toBe(1);
});
test("one commit refreshes a mutually connected peer before TTL expires", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  await connect(a, b);
  await connect(b, a);
  expect((await b.request("GET", project)).body.repoConfigCommit).toBeNull();
  const base = git(repo.origin, "rev-parse", "main");
  const result = await a.request("PUT", `${project}&instanceId=${a.id}`, {
    rules: { criticAllPrs: true },
    leitrechner: b.id,
  });
  expect(result.status).toBe(200);
  expect(result.body.notifications).toEqual([
    { instanceId: b.id, name: expect.any(String), ok: true },
  ]);
  expect(git(repo.origin, "rev-list", "--count", `${base}..main`)).toBe("1");
  const updated = await b.request(
    "GET",
    `/api/repo-config/machine?remoteSlug=${slug}&instanceId=${b.id}`,
  );
  expect(updated.body.criticAllPrs).toBe(true);
  expect(updated.body.leitrechner).toBe(b.id);
  expect(a.count() + b.count()).toBeLessThan(60);
});
test("field differences, multiple drain owners and offline gaps remain visible", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  a.store.setRepoConfig(repo.a, {
    ...a.store.getLocalRepoConfig(repo.a),
    autoDrainEnabled: true,
    criticAllPrs: true,
  });
  b.store.setRepoConfig(repo.b, { ...b.store.getLocalRepoConfig(repo.b), autoDrainEnabled: true });
  await connect(a, b);
  const read = (await a.request("GET", project)).body;
  expect(read.differences.complete).toBe(true);
  expect(read.differences.fields).toContainEqual({
    instanceId: b.id,
    fields: { criticAllPrs: false },
  });
  expect(read.differences.multipleAutoDrain).toHaveLength(2);
  b.server.stop(true);
  const offline = (await a.request("GET", project)).body;
  expect(offline.differences.complete).toBe(false);
  expect(offline.differences.unavailableInstanceIds).toEqual([b.id]);
});
test("scopes and repository grants cannot escalate through the coordinator", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  await connect(a, b);
  const readToken = await token(a, "read");
  const readHeaders = { authorization: `Bearer ${readToken}`, "content-type": "application/json" };
  expect((await a.request("GET", project, undefined, readHeaders)).status).toBe(200);
  expect(
    (await a.request("PUT", `${project}&instanceId=${a.id}`, { rules: {} }, readHeaders)).status,
  ).toBe(403);
  const restricted = {
    authorization: `Bearer ${await token(a, "full", [repo.a])}`,
    "content-type": "application/json",
  };
  const before = b.count();
  expect((await a.request("GET", project, undefined, restricted)).status).toBe(403);
  expect(b.count()).toBe(before);
  expect(
    (await a.request("GET", project, undefined, { "content-type": "application/json" })).status,
  ).toBe(401);
});

test("a commit on a remote writer refreshes the coordinator's cached clone", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  await connect(a, b);
  await a.request("GET", project);
  const result = await a.request("PUT", `${project}&instanceId=${b.id}`, {
    rules: { criticAllPrs: true },
  });
  expect(result.status).toBe(200);
  const local = await a.request("GET", `/api/repo-config?repo=${encodeURIComponent(repo.a)}`);
  expect(local.body.criticAllPrs).toBe(true);
});
test("the legacy local PUT notifies peers and failed refresh does not hide a committed write", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  await connect(a, b);
  await b.request("GET", project);
  const result = await a.request("PUT", `/api/repo-config?repo=${encodeURIComponent(repo.a)}`, {
    criticAllPrs: true,
  });
  expect(result.body.notifications[0].ok).toBe(true);
  expect(
    (await b.request("GET", `/api/repo-config?repo=${encodeURIComponent(repo.b)}`)).body
      .criticAllPrs,
  ).toBe(true);
  b.server.stop(true);
  const second = await a.request("PUT", `${project}&instanceId=${a.id}`, {
    rules: { autoLabel: "ready" },
  });
  expect(second.status).toBe(200);
  expect(second.body.notifications[0].ok).toBe(false);
  expect(second.body.repoConfigCommit).toBe(git(repo.origin, "rev-parse", "main"));
});
test("unknown targets and invalid bodies fail without changing settings", async () => {
  const a = host(repo.a);
  expect((await a.request("GET", "/api/repo-config/project?remoteSlug=absent/repo")).status).toBe(
    404,
  );
  expect((await a.request("GET", "/api/repo-config/project")).status).toBe(400);
  expect(
    (
      await a.request("PUT", `${project}&instanceId=${a.id}`, {
        rules: { sandboxProfile: "trusted" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await a.request("PUT", `${project}&instanceId=${a.id}`, { leitrechner: "bad-id" })).status,
  ).toBe(400);
  expect(
    (
      await a.request("PUT", `${project}&instanceId=11111111-1111-4111-8111-111111111111`, {
        rules: { criticAllPrs: true },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await a.request(
        "GET",
        `/api/repo-config/machine?remoteSlug=${slug}&instanceId=${a.id}&host=local`,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await a.request(
        "GET",
        `/api/repo-config/machine?remoteSlug=${slug}&instanceId=11111111-1111-4111-8111-111111111111&host=local`,
      )
    ).status,
  ).toBe(400);
});

import { refreshRepoConfigsAtStartup } from "../src/repo-config-file";
test("a stopped peer catches up on startup without receiving a notification", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  await connect(a, b);
  await b.request("GET", `/api/repo-config?repo=${encodeURIComponent(repo.b)}`);
  b.server.stop(true);
  const result = await a.request("PUT", `${project}&instanceId=${a.id}`, {
    rules: { autoDrainEnabled: true },
    leitrechner: a.id,
  });
  expect(result.status).toBe(200);
  expect(result.body.notifications[0].ok).toBe(false);
  const failures: string[] = [];
  await refreshRepoConfigsAtStartup([repo.b], (path) => failures.push(path));
  const restarted = host(repo.b);
  const read = await restarted.request(
    "GET",
    `/api/repo-config?repo=${encodeURIComponent(repo.b)}`,
  );
  expect(failures).toEqual([]);
  expect(read.body).toMatchObject({
    autoDrainEnabled: true,
    leitrechner: a.id,
    repoConfigCommit: result.body.repoConfigCommit,
  });
});
test("a refresh fetch failure is reported separately from a successful rule commit", async () => {
  const a = host(repo.a),
    b = host(repo.b);
  await connect(a, b);
  git(repo.b, "remote", "set-url", "origin", `${repo.dir}/offline.git`);
  const result = await a.request("PUT", `${project}&instanceId=${a.id}`, {
    rules: { criticAllPrs: true },
  });
  expect(result.status).toBe(200);
  expect(result.body.notifications).toEqual([
    { instanceId: b.id, name: expect.any(String), ok: false, reason: "fetch_failed" },
  ]);
  expect(result.body.repoConfigCommit).toBe(git(repo.origin, "rev-parse", "main"));
});

test("remote machine edits revoke the target's browser and restart its connector sessions", async () => {
  const a = host(null),
    b = host(repo.b);
  await connect(a, b);
  b.store.setRepoConfig(repo.b, {
    ...b.store.getLocalRepoConfig(repo.b),
    sharedBrowserEnabled: true,
  });
  const stopped: string[] = [];
  let swept = false;
  b.deps.sharedBrowser = {
    stop: (dir: string) => stopped.push(dir),
  } as unknown as AppDeps["sharedBrowser"];
  b.deps.connectorRestart = {
    pending: () => ({ now: 1, later: 0 }),
    sweep: async () => {
      swept = true;
    },
  } as unknown as AppDeps["connectorRestart"];
  const result = await a.request(
    "PUT",
    `/api/repo-config/machine?remoteSlug=${slug}&instanceId=${b.id}`,
    { sharedBrowserEnabled: false, claudeAiConnectorsEnabled: true },
  );
  expect(result.status).toBe(200);
  expect(stopped).toEqual([repo.b]);
  expect(swept).toBe(true);
  expect(result.body.connectorRestart).toEqual({ now: 1, later: 0 });
});
