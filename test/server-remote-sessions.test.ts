import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { SESSION_COOKIE, signCookie } from "../src/operator-auth";
import { AccessTokenService } from "../src/access-tokens";
import { RemoteInstanceService } from "../src/remote-instances/service";
import { RemoteSessionMirror } from "../src/remote-instances/sessions";
import type { Session } from "../src/types";

// Session mirroring (#2762) end to end: real Shepherd servers in one process, each with its own
// store, auth gate and access tokens, connected through the real probe and the real `/events`
// WebSocket — so the target's own auth and origin checks are what the mirror passes.

interface Node {
  deps: AppDeps & { remoteInstances: RemoteInstanceService; remoteSessions: RemoteSessionMirror };
  server: ReturnType<typeof serve>;
  base: string;
  token: string;
  /** Every frame emitted on this node's own EventHub — what its local listeners see. */
  hub: [string, unknown][];
}

const nodes: Node[] = [];
const sockets: WebSocket[] = [];
let restore: Partial<typeof config>;
let root: string;
let repo: string;

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-mirror-"));
  repo = join(root, "app");
  mkdirSync(repo);
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "mirror-test-secret",
    token: null,
    host: "127.0.0.1",
  });
});

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const node of nodes.splice(0)) {
    node.deps.remoteSessions.stop();
    node.server.stop(true);
  }
  Object.assign(config, restore);
  rmSync(root, { recursive: true, force: true });
});

function startNode(port = 0, store = new SessionStore(":memory:")): Node {
  const events = new EventHub();
  const service = new SessionService({
    store,
    events,
    namer: async () => "x",
    worktree: {} as never,
    herdr: { list: () => [] } as never,
  });
  const remoteInstances = new RemoteInstanceService({ store });
  const remoteSessions = new RemoteSessionMirror({
    store,
    instances: remoteInstances,
    recheckDelaysMs: [20],
  });
  remoteInstances.onChange((id) => remoteSessions.sync(id));
  const deps = {
    store,
    events,
    service,
    accessTokens: new AccessTokenService(store),
    remoteInstances,
    remoteSessions,
    resolveForge: (() => null) as AppDeps["resolveForge"],
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
  const server = serve(deps, port);
  const hub: [string, unknown][] = [];
  events.subscribe((event, data) => hub.push([event, data]));
  const node: Node = {
    deps,
    server,
    base: `http://127.0.0.1:${server.port}`,
    token: deps.accessTokens.mint("machine", null, "full", null).token,
    hub,
  };
  nodes.push(node);
  return node;
}

async function get(node: Node, path: string, token = node.token): Promise<Session[]> {
  const res = await fetch(`${node.base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Session[];
}

async function connect(from: Node, to: Node): Promise<string> {
  const result = await from.deps.remoteInstances.connect({
    url: to.base,
    token: to.token,
    label: null,
  });
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
  return result.instance.instanceId;
}

function startSession(node: Node, name: string): Session {
  const session = node.deps.store.create({
    name,
    prompt: `do ${name}`,
    repoPath: repo,
    baseBranch: "main",
    branch: `shepherd/${name}`,
    worktreePath: repo,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `term-${name}`,
  });
  node.deps.events.emit("session:new", session);
  return session;
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 2_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

/** A dashboard on `node`: an authenticated `/events` socket collecting every frame. */
async function dashboard(node: Node): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${node.server.port}/events`, {
    headers: { Authorization: `Bearer ${node.token}` },
  } as never);
  sockets.push(ws);
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return frames;
}

const ids = (list: Session[]) => list.map((s) => s.id).sort();

describe("mirrored sessions", () => {
  test("without connected machines GET /api/sessions is unchanged", async () => {
    const a = startNode();
    startSession(a, "local");
    const plain = makeApp({ ...a.deps, remoteSessions: undefined });
    const req = () =>
      new Request("http://local/api/sessions", {
        headers: { authorization: `Bearer ${a.token}` },
      });
    const withMirror = await (await makeApp(a.deps).fetch(req())).json();
    const without = await (await plain.fetch(req())).json();
    expect(withMirror).toEqual(without);
    expect(withMirror).toHaveLength(1);
    expect(withMirror[0]).not.toHaveProperty("host");
    expect(withMirror[0]).not.toHaveProperty("connection");
  });

  test("a machine's session names its project, as the machine's repo index has it", async () => {
    const a = startNode();
    const b = startNode();
    b.deps.resolveForge = ((path: string) =>
      path === repo ? { slug: "acme/app" } : null) as never;
    const remote = startSession(b, "on-b");
    await connect(a, b);
    const list = await until(
      () => get(a, "/api/sessions"),
      (l) => l.some((s) => s.id === remote.id),
    );
    expect(list.find((s) => s.id === remote.id)).toMatchObject({ remoteSlug: "acme/app" });
  });

  test("a session started on the machine appears live with its host and never enters the local store", async () => {
    const a = startNode();
    const b = startNode();
    const own = startSession(a, "own");
    const frames = await dashboard(a);
    const bId = await connect(a, b);
    // The first sync is the moment B's sessions become visible; from then on frames are live.
    await until(
      () => frames,
      (f) => f.some((x) => x.event === "remote:sessions" && x.data.instanceId === bId),
    );

    const remote = startSession(b, "on-b");
    const list = await until(
      () => get(a, "/api/sessions"),
      (l) => l.some((s) => s.id === remote.id),
    );
    expect(list.map((s) => s.id)).toEqual([own.id, remote.id]);
    const ref = list[1] as Session & Record<string, unknown>;
    expect(ref.host).toEqual({
      instanceId: bId,
      name: expect.any(String),
      platform: expect.any(String),
    });
    expect(ref.connection).toEqual({ state: "connected", since: expect.any(Number) });
    expect(ref.desig).toBe(remote.desig);
    await until(
      () => frames,
      (f) => f.some((x) => x.event === "session:new" && x.data.id === remote.id),
    );
    expect(
      frames.find((x) => x.data.id === remote.id && x.event === "session:new")!.data.host,
    ).toEqual(ref.host);

    // Live status: a change on B reaches A's list and A's dashboard.
    b.deps.store.update(remote.id, { status: "idle" });
    b.deps.events.emit("session:status", { id: remote.id, status: "idle" });
    await until(
      () => get(a, "/api/sessions"),
      (l) => l.find((s) => s.id === remote.id)?.status === "idle",
    );
    await until(
      () => frames,
      (f) => f.some((x) => x.event === "session:status" && x.data.id === remote.id),
    );

    // Never local: not in the store, not on the hub every local loop listens to, no local action.
    expect(a.deps.store.list().map((s) => s.id)).toEqual([own.id]);
    expect(a.deps.store.list({ activeOnly: true }).map((s) => s.id)).toEqual([own.id]);
    expect(a.deps.store.get(remote.id)).toBeNull();
    expect(JSON.stringify(a.hub)).not.toContain(remote.id);
    const post = (path: string, body: unknown) =>
      fetch(`${a.base}/api/sessions/${remote.id}/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("interrupt", {})).status).toBe(404);
    expect((await post("reply", { text: "hi" })).status).toBe(404);
    expect(JSON.stringify(a.hub)).not.toContain(remote.id);

    // A token restricted to repositories and an explicit `host=local` see local sessions only.
    const restricted = a.deps.accessTokens!.mint("repo", null, "read", [repo]).token;
    expect(ids(await get(a, "/api/sessions", restricted))).toEqual([own.id]);
    expect(ids(await get(a, "/api/sessions?host=local"))).toEqual([own.id]);
  });

  test("the machine's PR state reaches the reference and nothing local (#3055)", async () => {
    const a = startNode();
    const b = startNode();
    const frames = await dashboard(a);
    const remote = startSession(b, "on-b");
    const green = { state: "open", checks: "success", deployConfigured: false, number: 7 };
    b.deps.prCache = {
      snapshot: () => ({ [remote.id]: green }),
      get: (id: string) => (id === remote.id ? green : undefined),
    } as never;
    await connect(a, b);

    const git = (l: Session[]) => (l.find((s) => s.id === remote.id) as Record<string, any>)?.git;
    await until(
      () => get(a, "/api/sessions"),
      (l) => git(l)?.checks === "success",
    );
    const pending = { ...green, checks: "pending" };
    b.deps.events.emit("session:git", { id: remote.id, git: pending });
    await until(
      () => get(a, "/api/sessions"),
      (l) => git(l)?.checks === "pending",
    );
    await until(
      () => frames,
      (f) => f.some((x) => x.event === "session:git" && x.data.id === remote.id),
    );

    // Never local: A's PR map, store and hub — what its poller, autopilot, merge train, drain and
    // reaper read — have never heard of it.
    const map = await fetch(`${a.base}/api/git`, {
      headers: { authorization: `Bearer ${a.token}` },
    }).then((r) => r.json());
    expect(Object.keys(map)).not.toContain(remote.id);
    expect(a.deps.store.get(remote.id)).toBeNull();
    expect(JSON.stringify(a.hub)).not.toContain(remote.id);
  });

  test("machines connected to each other show every session exactly once", async () => {
    const a = startNode();
    const b = startNode();
    const onA = startSession(a, "on-a");
    const onB = startSession(b, "on-b");
    await connect(a, b);
    await connect(b, a);
    const both = (l: Session[]) => l.length >= 2;
    await until(() => get(a, "/api/sessions"), both);
    await until(() => get(b, "/api/sessions"), both);
    // Give a would-be loop time to bring references back around.
    startSession(a, "later-a");
    await Bun.sleep(150);
    const listA = await get(a, "/api/sessions");
    const listB = await get(b, "/api/sessions");
    for (const list of [listA, listB]) {
      expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
      expect(list).toHaveLength(3);
    }
    const hostOf = (l: Session[], id: string) =>
      (l.find((s) => s.id === id) as Record<string, unknown> | undefined)?.host;
    expect(hostOf(listA, onA.id)).toBeUndefined();
    expect(hostOf(listA, onB.id)).toMatchObject({
      instanceId: b.deps.store.getSetting("instanceId"),
    });
    expect(hostOf(listB, onB.id)).toBeUndefined();
    expect(hostOf(listB, onA.id)).toMatchObject({
      instanceId: a.deps.store.getSetting("instanceId"),
    });
    // What a peer asks for carries no mirrored references at all.
    for (const node of [a, b]) {
      const local = (await get(node, "/api/sessions?host=local")) as unknown as Record<
        string,
        unknown
      >[];
      expect(local.some((s) => "host" in s)).toBe(false);
    }
  });

  test("a dropped machine stays visible as disconnected and comes back current", async () => {
    const a = startNode();
    const store = new SessionStore(":memory:");
    const b = startNode(0, store);
    const port = b.server.port;
    const bId = await connect(a, b);
    const remote = startSession(b, "on-b");
    await until(
      () => get(a, "/api/sessions"),
      (l) => l.some((s) => s.id === remote.id),
    );

    b.server.stop(true);
    const dropped = await until(
      () => get(a, "/api/sessions"),
      (l) =>
        (l.find((s) => s.id === remote.id) as Record<string, any> | undefined)?.connection
          ?.state === "disconnected",
    );
    expect(dropped.find((s) => s.id === remote.id)!.status).toBe(remote.status);

    // Same machine (same store and identity) back on the same address, with news.
    nodes.splice(nodes.indexOf(b), 1);
    b.deps.remoteSessions.stop();
    store.update(remote.id, { status: "idle" });
    startNode(port, store);
    await a.deps.remoteInstances.check(bId);
    // The link reads connected once the socket opens; the fresh snapshot (sessions and their PR
    // state, #3055) lands just after it — so wait for the news, not only the link.
    const back = await until(
      () => get(a, "/api/sessions"),
      (l) => {
        const ref = l.find((s) => s.id === remote.id) as Record<string, any> | undefined;
        return ref?.connection?.state === "connected" && ref.status === "idle";
      },
    );
    expect(back.find((s) => s.id === remote.id)!.status).toBe("idle");
  });

  test("an older mirror without identity headers is listed under its token's name (#3056)", async () => {
    const a = startNode();
    const b = startNode();
    // `startNode` builds its mirror without `self`: it sends no ID or name, as a release before
    // #3056 does.
    await dashboard(b);
    const bId = await connect(a, b);
    const incoming = async () => {
      const res = await fetch(`${b.base}/api/remote-instances`, {
        headers: { cookie: `${SESSION_COOKIE}=${signCookie("mirror-test-secret")}` },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { incoming: Record<string, unknown>[] }).incoming;
    };
    // Only A's mirror socket is listed; B's own dashboard is no mirror.
    const listed = await until(incoming, (l) => l.length > 0);
    expect(listed).toEqual([
      {
        instanceId: null,
        name: null,
        tokenName: "machine",
        since: expect.any(Number),
        direction: "unknown",
      },
    ]);
    // Removing B on A closes the socket, and with it the entry.
    a.deps.remoteInstances.remove(bId);
    await until(incoming, (l) => l.length === 0);
  });
});
