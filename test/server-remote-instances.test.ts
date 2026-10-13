import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { CapabilityService } from "../src/remote-instances/capability-probe";
import { FEDERATION_API_VERSION } from "../src/remote-instances/identity";

// Connected machines (#2759) through the real routes: two Shepherds in one process, each with its
// own store, reach each other through `makeApp` — so the target's real auth seam, `/api/me`,
// `/api/instance` and `/api/repos` answer the probe.

const SECRET = "test-cookie-signing-secret";

const operator = () => ({
  "content-type": "application/json",
  Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}`,
});

interface Instance {
  deps: AppDeps;
  app: ReturnType<typeof makeApp>;
  events: unknown[];
}

const instances = new Map<string, Instance>();

/** Routes `http://<host>/…` to the in-process app registered under that host. */
const routedFetch: FetchLike = async (url, init) => {
  const target = instances.get(new URL(url).host);
  if (!target) throw new TypeError("Unable to connect");
  return target.app.fetch(new Request(url, init));
};

function makeInstance(host: string, slug?: string): Instance {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {} as never,
    herdr: { list: () => [] } as never,
    events,
  });
  const deps: AppDeps = {
    store,
    service,
    events,
    remoteInstances: new RemoteInstanceService({ store, fetch: routedFetch }),
    resolveForge: (() => (slug ? { slug, isFork: false } : null)) as AppDeps["resolveForge"],
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
  const seen: unknown[] = [];
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
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function mint(i: Instance, repoPaths: string[] | null = null, scope = "full") {
  const res = await call(i, "POST", "/api/access-tokens", {
    name: "machine",
    expiresInDays: null,
    scope,
    repoPaths,
  });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: (res.body.entry as { id: string }).id };
}

const connect = (i: Instance, url: string, token: string, label?: string) =>
  call(i, "POST", "/api/remote-instances", label ? { url, token, label } : { url, token });

let prev: { secret: string | null; hash: string | null; token: string | null; root: string };
let repoRoot: string;

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
  repoRoot = mkdtempSync(join(tmpdir(), "shepherd-machines-"));
  mkdirSync(join(repoRoot, "app"));
  config.repoRoot = repoRoot;
});

afterEach(() => {
  config.cookieSecret = prev.secret;
  config.passwordHash = prev.hash;
  config.token = prev.token;
  config.repoRoot = prev.root;
  instances.clear();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("GET/PATCH /api/instance", () => {
  test("serves a stable identity and lets the operator rename it", async () => {
    const a = makeInstance("a.test");
    const first = await call(a, "GET", "/api/instance");
    expect(first.status).toBe(200);
    expect((await call(a, "GET", "/api/instance")).body.instanceId).toBe(first.body.instanceId);
    const renamed = await call(a, "PATCH", "/api/instance", { name: "Linux box" });
    expect(renamed.body).toMatchObject({ instanceId: first.body.instanceId, name: "Linux box" });
    expect((await call(a, "PATCH", "/api/instance", { name: 5 })).status).toBe(400);
    const reset = await call(a, "PATCH", "/api/instance", { name: null });
    expect(reset.body.name).toBe(first.body.name);
  });

  test("a bearer token may read the identity but not rename it", async () => {
    const a = makeInstance("a.test");
    const { token } = await mint(a);
    const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await call(a, "GET", "/api/instance", undefined, bearer)).status).toBe(200);
    const rename = await call(a, "PATCH", "/api/instance", { name: "x" }, bearer);
    expect(rename.status).toBe(403);
    expect(rename.body.error).toBe("operator_session_required");
  });
});

describe("connected machines", () => {
  test("two instances connect to each other and see name, version, platform and projects", async () => {
    const a = makeInstance("a.test", "acme/linux-app");
    const b = makeInstance("b.test", "acme/mac-app");
    const tokenB = (await mint(b)).token;
    const tokenA = (await mint(a)).token;
    const bId = (await call(b, "GET", "/api/instance")).body.instanceId;
    const aId = (await call(a, "GET", "/api/instance")).body.instanceId;

    const aToB = await connect(a, "http://b.test", tokenB);
    expect(aToB.status).toBe(201);
    expect(aToB.body.instance).toMatchObject({
      instanceId: bId,
      status: "connected",
      url: "http://b.test",
      info: { federationApi: FEDERATION_API_VERSION },
      projects: ["acme/mac-app"],
    });
    const bToA = await connect(b, "http://a.test", tokenA, "Linux");
    expect(bToA.status).toBe(201);
    expect(bToA.body.instance).toMatchObject({
      instanceId: aId,
      name: "Linux",
      status: "connected",
      projects: ["acme/linux-app"],
    });

    const listed = await call(a, "GET", "/api/remote-instances");
    expect((listed.body.instances as { instanceId: string }[]).map((i) => i.instanceId)).toEqual([
      bId as string,
    ]);
  });

  test("a machine's verified capabilities reach the coordinator through the real routes", async () => {
    const a = makeInstance("a.test");
    const b = makeInstance("b.test", "acme/mac-app");
    // b probes a fixed Linux host: only claude, installed and logged in (#2770).
    b.deps.capabilities = new CapabilityService({
      platform: "linux",
      env: {},
      home: "/nonexistent",
      codexBin: "codex",
      readdir: () => null,
      detectSandbox: () => ({ backend: false, egress: false }),
      exec: async (cmd, args) => ({
        code: cmd === "claude" ? 0 : null,
        stdout: args[0] === "auth" ? JSON.stringify({ loggedIn: true }) : "",
        timedOut: false,
        notFound: cmd !== "claude",
      }),
    });
    await call(b, "POST", "/api/instance/capabilities");
    const res = await connect(a, "http://b.test", (await mint(b)).token);
    expect(res.status).toBe(201);
    const caps = (res.body.instance as { capabilities: { stale: boolean; checks: unknown[] } })
      .capabilities;
    expect(caps.stale).toBe(false);
    expect(caps.checks).toContainEqual({ id: "agent:claude", ok: true, reason: null });
    expect(caps.checks).toContainEqual({ id: "agent:codex", ok: false, reason: "not_installed" });
    expect(res.body.instance).toMatchObject({ released: true });
  });

  test("connecting an instance to itself is refused", async () => {
    const a = makeInstance("a.test");
    const res = await connect(a, "http://a.test", (await mint(a)).token);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("self_connection");
    expect((await call(a, "GET", "/api/remote-instances")).body.instances).toEqual([]);
  });

  test("connecting the same machine twice is refused", async () => {
    const a = makeInstance("a.test");
    const b = makeInstance("b.test");
    const { token } = await mint(b);
    expect((await connect(a, "http://b.test", token)).status).toBe(201);
    const again = await connect(a, "http://b.test/", token);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_connected");
  });

  test("unreachable, rejected and too-narrow tokens are refused with distinct codes", async () => {
    const a = makeInstance("a.test");
    const b = makeInstance("b.test");
    const unreachable = await connect(a, "http://gone.test", "shp_whatever");
    expect([unreachable.status, unreachable.body]).toEqual([
      502,
      { error: "remote_unreachable", reason: "network" },
    ]);
    const rejected = await connect(a, "http://b.test", "shp_not-a-real-token");
    expect([rejected.status, rejected.body]).toEqual([
      422,
      { error: "remote_unauthorized", reason: "token_rejected" },
    ]);
    const readOnly = await connect(a, "http://b.test", (await mint(b, null, "read")).token);
    expect([readOnly.status, readOnly.body]).toEqual([
      422,
      { error: "remote_unauthorized", reason: "token_scope" },
    ]);
    expect((await call(a, "GET", "/api/remote-instances")).body.instances).toEqual([]);
  });

  test("a repository-restricted token never yields a silently partial project list", async () => {
    const a = makeInstance("a.test");
    const b = makeInstance("b.test", "acme/app");
    const restricted = await connect(a, "http://b.test", (await mint(b, [])).token);
    expect([restricted.status, restricted.body]).toEqual([
      422,
      { error: "remote_unauthorized", reason: "token_restricted" },
    ]);
    expect((await call(a, "GET", "/api/remote-instances")).body.instances).toEqual([]);

    // Restricting a token after the machine was connected flips it to unauthorized.
    const { token, id } = await mint(b);
    const connected = await connect(a, "http://b.test", token);
    const bId = (connected.body.instance as { instanceId: string }).instanceId;
    const patch = await call(b, "PATCH", `/api/access-tokens/${id}`, { repoPaths: [] });
    expect(patch.status).toBe(200);
    const checked = await call(a, "POST", `/api/remote-instances/${bId}/check`);
    expect(checked.body.instance).toMatchObject({
      status: "unauthorized",
      reason: "token_restricted",
    });
  });

  test("rename, check, remove and their 404s", async () => {
    const a = makeInstance("a.test");
    const b = makeInstance("b.test");
    const added = await connect(a, "http://b.test", (await mint(b)).token);
    const id = (added.body.instance as { instanceId: string }).instanceId;

    const renamed = await call(a, "PATCH", `/api/remote-instances/${id}`, { label: "Mac" });
    expect(renamed.body.instance).toMatchObject({ name: "Mac", label: "Mac" });
    expect((await call(a, "PATCH", `/api/remote-instances/${id}`, { label: 1 })).status).toBe(400);
    expect((await call(a, "PATCH", "/api/remote-instances/nope", { label: "x" })).status).toBe(404);

    instances.delete("b.test");
    const offline = await call(a, "POST", `/api/remote-instances/${id}/check`);
    expect(offline.body.instance).toMatchObject({ status: "unreachable", reason: "network" });
    expect((await call(a, "POST", "/api/remote-instances/nope/check")).status).toBe(404);

    expect((await call(a, "DELETE", `/api/remote-instances/${id}`)).body).toEqual({ ok: true });
    expect((await call(a, "DELETE", `/api/remote-instances/${id}`)).status).toBe(404);
    expect((await call(a, "GET", "/api/remote-instances")).body.instances).toEqual([]);
  });

  test("a machine's self-update is listed, started and followed through the coordinator", async () => {
    const a = makeInstance("a.test");
    const b = makeInstance("b.test");
    const applied: unknown[] = [];
    b.deps.updates = {
      current: () => ({
        behind: 2,
        current: "aaaaaaa",
        latest: "bbbbbbb",
        commits: [
          { sha: "bbbbbbb", subject: "fix: two" },
          { sha: "ccccccc", subject: "fix: one" },
        ],
        checkedAt: 5,
      }),
      apply: (opts?: unknown) => {
        applied.push(opts ?? null);
        return { started: true };
      },
      applyState: () => ({ phase: "running", exitCode: null, log: "bun install" }),
      dirtyStatus: async () => ({
        dirty: true,
        dirtyFiles: [" M a.ts"],
        dirtyCount: 1,
        sig: "s1",
        pathspecAll: Buffer.from("a.ts\0"),
        pathspecWorktree: Buffer.from("a.ts\0"),
      }),
    } as AppDeps["updates"];
    const added = await connect(a, "http://b.test", (await mint(b)).token);
    const id = (added.body.instance as { instanceId: string }).instanceId;

    const listed = await call(a, "GET", "/api/remote-instances/updates");
    expect(listed.body.machines).toEqual([
      {
        instanceId: id,
        name: expect.any(String),
        platform: expect.any(String),
        status: "connected",
        update: {
          behind: 2,
          current: "aaaaaaa",
          latest: "bbbbbbb",
          commits: [
            { sha: "bbbbbbb", subject: "fix: two" },
            { sha: "ccccccc", subject: "fix: one" },
          ],
          checkedAt: 5,
        },
      },
    ]);

    const started = await call(a, "POST", `/api/remote-instances/${id}/update`, {});
    expect([started.status, started.body]).toEqual([202, { ok: true }]);
    expect(applied).toEqual([null]);
    const log = await call(a, "GET", `/api/remote-instances/${id}/update/log`);
    expect(log.body).toEqual({ phase: "running", exitCode: null, log: "bun install" });
    const dirty = await call(a, "GET", `/api/remote-instances/${id}/update/dirty`);
    expect(dirty.body).toEqual({ dirty: true, dirtyFiles: [" M a.ts"], dirtyCount: 1, sig: "s1" });

    // The machine's own refusal passes through as its answer: here a discard confirmed against a
    // tree that has changed since.
    const stale = await call(a, "POST", `/api/remote-instances/${id}/update`, {
      discard: true,
      sig: "old",
    });
    expect([stale.status, stale.body.error]).toEqual([409, "stale"]);
    expect(applied).toHaveLength(1);

    const badBody = { discard: "yes" };
    expect((await call(a, "POST", `/api/remote-instances/${id}/update`, badBody)).status).toBe(400);
    expect((await call(a, "POST", "/api/remote-instances/nope/update", {})).status).toBe(404);
    expect((await call(a, "GET", "/api/remote-instances/nope/update/log")).status).toBe(404);

    // An answer the machine's update route never gives is not passed on as one.
    const real = b.app;
    b.app = {
      ...real,
      fetch: (req: Request) =>
        req.method === "POST" && new URL(req.url).pathname === "/api/update"
          ? Promise.resolve(Response.json({ error: "boom" }, { status: 500 }))
          : real.fetch(req),
    } as typeof real;
    const odd = await call(a, "POST", `/api/remote-instances/${id}/update`, {});
    expect([odd.status, odd.body]).toEqual([
      502,
      { error: "remote_unreachable", reason: "bad_response" },
    ]);

    instances.delete("b.test");
    const offline = await call(a, "POST", `/api/remote-instances/${id}/update`, {});
    expect([offline.status, offline.body]).toEqual([
      502,
      { error: "remote_unreachable", reason: "network" },
    ]);
  });

  test("a bearer token cannot reach the machine routes", async () => {
    const a = makeInstance("a.test");
    const bearer = {
      authorization: `Bearer ${(await mint(a)).token}`,
      "content-type": "application/json",
    };
    for (const [method, path] of [
      ["GET", "/api/remote-instances"],
      ["POST", "/api/remote-instances"],
      ["PATCH", "/api/remote-instances/x"],
      ["DELETE", "/api/remote-instances/x"],
      ["POST", "/api/remote-instances/x/check"],
      ["GET", "/api/remote-instances/updates"],
      ["POST", "/api/remote-instances/x/update"],
      ["GET", "/api/remote-instances/x/update/log"],
      ["GET", "/api/remote-instances/x/update/dirty"],
    ] as const) {
      const res = await call(a, method, path, method === "GET" ? undefined : {}, bearer);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  test("the stored token appears in no response, event or log line", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    try {
      const a = makeInstance("a.test");
      const b = makeInstance("b.test", "acme/app");
      const { token } = await mint(b);
      const bodies: string[] = [];
      const record = async (p: Promise<{ text: string }>) => bodies.push((await p).text);

      await record(connect(a, "http://b.test", token));
      await record(call(a, "GET", "/api/instance"));
      const bId = (await call(b, "GET", "/api/instance")).body.instanceId as string;
      await record(call(a, "GET", "/api/remote-instances"));
      await record(call(a, "PATCH", `/api/remote-instances/${bId}`, { label: "Mac" }));
      await record(call(a, "POST", `/api/remote-instances/${bId}/check`));
      instances.delete("b.test");
      await record(call(a, "POST", `/api/remote-instances/${bId}/check`));
      await record(call(a, "GET", "/api/remote-instances"));
      await record(call(a, "DELETE", `/api/remote-instances/${bId}`));

      expect(bodies.filter((body) => body.includes(token))).toEqual([]);
      expect(a.events.filter((e) => JSON.stringify(e).includes(token))).toEqual([]);
      const logged = spies.flatMap((s) => s.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.filter((line) => line.includes(token))).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
