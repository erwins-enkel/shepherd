import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeAgentIngressApp, makeApp, serve, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { AccessTokenService } from "../src/access-tokens";
import { RemoteInstanceService } from "../src/remote-instances/service";
import { RemoteSessionMirror } from "../src/remote-instances/sessions";
import { sessionScratchpadDir } from "../src/tmp-sweep";
import type { GitState } from "../src/forge/types";
import type { Session, SessionPreviewState } from "../src/types";

// Actions on a session that runs on a connected machine, sent to the coordinator (#2765): two or
// three real Shepherd servers in one process, each with its own store, auth gate and tokens. Only
// the service methods that would drive herdr are replaced — by spies on EACH node, so a test can
// tell that an action reached the machine and that nothing ran on the coordinator in its place.

interface Node {
  deps: AppDeps & {
    service: SessionService;
    accessTokens: AccessTokenService;
    remoteInstances: RemoteInstanceService;
    remoteSessions: RemoteSessionMirror;
  };
  server: ReturnType<typeof serve>;
  base: string;
  token: string;
  tokenId: string;
  /** Sessions this node's PR cache reports as merged. */
  merged: Set<string>;
  /** Every event this node emitted on its own hub. */
  events: [string, unknown][];
  spies: {
    reply: ReturnType<typeof spyOn>;
    interrupt: ReturnType<typeof spyOn>;
    archive: ReturnType<typeof spyOn>;
    archiveMany: ReturnType<typeof spyOn>;
  };
}

const SID = "claude-remote-actions-1";
const nodes: Node[] = [];
let restore: Partial<typeof config>;
const prevSweepDir = process.env.SHEPHERD_TMP_SWEEP_DIR;
let root: string;
let repo: string;
/** Every request any node sent to another one (the test's own requests are to `a` only). */
let outbound: string[];
let fetchSpy: { mockRestore(): void };

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
    previewHost: config.previewHost,
    previewAutoServe: config.previewAutoServe,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-remote-actions-"));
  repo = join(root, "app");
  mkdirSync(repo);
  // A real repository as the machine's worktree: one commit on main, one on the session's branch.
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "shepherd/on-b");
  writeFileSync(join(repo, "feature.txt"), "built on b\n");
  git("add", ".");
  git("commit", "-q", "-m", "feature");
  process.env.SHEPHERD_TMP_SWEEP_DIR = join(root, "scratch");
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "remote-actions-test-secret",
    token: null,
    host: "127.0.0.1",
  });
  outbound = [];
  const realFetch = globalThis.fetch;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (nodes.slice(1).some((n) => url.startsWith(n.base))) outbound.push(url);
    return realFetch(input, init);
  }) as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const node of nodes.splice(0)) {
    node.deps.remoteSessions.stop();
    node.server.stop(true);
  }
  Object.assign(config, restore);
  if (prevSweepDir === undefined) delete process.env.SHEPHERD_TMP_SWEEP_DIR;
  else process.env.SHEPHERD_TMP_SWEEP_DIR = prevSweepDir;
  rmSync(root, { recursive: true, force: true });
});

function startNode(): Node {
  const store = new SessionStore(":memory:");
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
  const accessTokens = new AccessTokenService(store);
  const merged = new Set<string>();
  const merge: GitState = { state: "merged", checks: "success", deployConfigured: false } as never;
  const deps = {
    store,
    events,
    service,
    accessTokens,
    remoteInstances,
    remoteSessions,
    prCache: {
      snapshot: () => Object.fromEntries([...merged].map((id) => [id, merge])),
      get: () => undefined,
      set: () => {},
      drop: () => {},
    },
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
  const server = serve(deps, 0);
  const emitted: [string, unknown][] = [];
  events.subscribe((event, data) => emitted.push([event, data]));
  spyOn(service, "leftovers").mockReturnValue([]);
  spyOn(service, "leftoverProbesUnavailable").mockReturnValue(false);
  const minted = accessTokens.mint("machine", null, "full", null);
  const node: Node = {
    deps,
    server,
    base: `http://127.0.0.1:${server.port}`,
    token: minted.token,
    tokenId: minted.entry.id,
    merged,
    events: emitted,
    spies: {
      reply: spyOn(service, "operatorReply").mockResolvedValue(true),
      interrupt: spyOn(service, "interrupt").mockResolvedValue(true),
      archive: spyOn(service, "archive").mockImplementation(async (id: string) => {
        store.archive(id);
        return 0;
      }),
      archiveMany: spyOn(service, "archiveMany").mockImplementation(async (ids: string[]) => {
        for (const id of ids) store.archive(id);
        return { cleared: ids, leftovers: 0 };
      }),
    },
  };
  nodes.push(node);
  return node;
}

function startSession(node: Node, name: string): Session {
  const session = node.deps.store.create({
    name,
    prompt: `do ${name}`,
    repoPath: repo,
    baseBranch: "main",
    branch: "shepherd/on-b",
    worktreePath: repo,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `term-${name}`,
    claudeSessionId: SID,
  });
  node.deps.events.emit("session:new", session);
  return session;
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

async function sessions(node: Node): Promise<(Session & Record<string, any>)[]> {
  const res = await fetch(`${node.base}/api/sessions`, {
    headers: { authorization: `Bearer ${node.token}` },
  });
  return (await res.json()) as (Session & Record<string, any>)[];
}

/** `to` connected as a machine of `from`, with `session` mirrored and live on `from`. */
async function connectWith(from: Node, to: Node, session: Session): Promise<void> {
  const result = await from.deps.remoteInstances.connect({
    url: to.base,
    token: to.token,
    label: null,
  });
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
  await until(
    () => sessions(from),
    (l) => l.some((s) => s.id === session.id && s.connection?.state === "connected"),
  );
}

/** A request to `node` as the operator's client would send it. */
function call(
  node: Node,
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token ?? node.token}`,
    ...opts.headers,
  };
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  return fetch(`${node.base}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
}

/** Two nodes: `a` the coordinator, `b` the machine running `remote`. */
async function pair() {
  const a = startNode();
  const b = startNode();
  const remote = startSession(b, "on-b");
  await connectWith(a, b, remote);
  outbound.length = 0; // the connection's own probe and snapshot are not under test
  a.events.length = 0;
  return { a, b, remote };
}

function untouched(a: Node) {
  for (const spy of Object.values(a.spies)) expect(spy).not.toHaveBeenCalled();
  expect(a.events).toEqual([]);
}

describe("actions on a mirrored session reach its machine", () => {
  test("reply, interrupt and archive act on the session there; nothing runs here", async () => {
    const { a, b, remote } = await pair();

    const reply = await call(a, "POST", `/api/sessions/${remote.id}/reply`, {
      json: { text: "carry on" },
    });
    expect(reply.status).toBe(200);
    expect(b.spies.reply).toHaveBeenCalledWith(remote.id, "carry on");

    const stop = await call(a, "POST", `/api/sessions/${remote.id}/interrupt`);
    expect(stop.status).toBe(200);
    expect(b.spies.interrupt).toHaveBeenCalledWith(remote.id);

    const left = await call(a, "GET", `/api/sessions/${remote.id}/leftovers`);
    expect(await left.json()).toEqual({ leftovers: [], probesUnavailable: false });

    const archive = await call(a, "DELETE", `/api/sessions/${remote.id}`, {
      json: { reap: ["dev-server"] },
    });
    expect(archive.status).toBe(200);
    expect(b.spies.archive).toHaveBeenCalledWith(remote.id, ["dev-server"]);
    // The machine's own `session:archived` reaches the coordinator through the mirror.
    await until(
      () => sessions(a),
      (l) => !l.some((s) => s.id === remote.id),
    );
    untouched(a);
  });

  test("the diff and a worktree download come from the machine", async () => {
    const { a, remote } = await pair();

    const diff = await call(a, "GET", `/api/sessions/${remote.id}/diff`);
    expect(diff.status).toBe(200);
    const body = (await diff.json()) as { head: string; files: { path: string }[] };
    expect(body.head).toBe("shepherd/on-b");
    expect(body.files.map((f) => f.path)).toEqual(["feature.txt"]);

    const file = await call(
      a,
      "GET",
      `/api/sessions/${remote.id}/worktree/download?path=feature.txt`,
    );
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("built on b\n");
    expect(file.headers.get("content-disposition")).toContain("feature.txt");
    untouched(a);
  });

  test("a scratchpad upload lands in the machine's scratchpad", async () => {
    const { a, remote } = await pair();
    const form = new FormData();
    form.append("file", new File(["notes from a"], "notes.txt", { type: "text/plain" }));

    const res = await call(a, "POST", `/api/sessions/${remote.id}/scratchpad/upload`, {
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "notes.txt" });
    const landed = join(sessionScratchpadDir(repo, SID), "notes.txt");
    expect(existsSync(landed)).toBe(true);
    expect(readFileSync(landed, "utf8")).toBe("notes from a");
    untouched(a);
  });
});

describe("what is not forwarded", () => {
  test.each([
    ["POST", "relaunch"],
    ["POST", "resume"],
    ["POST", "git/merge"],
    ["PUT", "queue"],
    ["POST", "hooks"],
    ["GET", "steer-log"],
    ["GET", ""],
  ])(
    "%s %s on a mirrored session is refused with an explanation and runs nowhere",
    async (method, leaf) => {
      const { a, b, remote } = await pair();
      const res = await call(a, method, `/api/sessions/${remote.id}${leaf ? `/${leaf}` : ""}`, {
        json: method === "GET" ? undefined : {},
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "remote_unsupported",
        machine: expect.any(String),
      });
      expect(outbound).toEqual([]);
      untouched(a);
      for (const spy of Object.values(b.spies)) expect(spy).not.toHaveBeenCalled();
    },
  );

  test("a machine that dropped off answers unreachable, and nothing runs here", async () => {
    const { a, b, remote } = await pair();
    b.server.stop(true);
    await until(
      () => sessions(a),
      (l) => l.some((s) => s.id === remote.id && s.connection?.state === "disconnected"),
    );
    a.events.length = 0;
    const res = await call(a, "POST", `/api/sessions/${remote.id}/interrupt`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "machine_unreachable", reason: "disconnected" });
    untouched(a);
  });
});

describe("the preview of a mirrored session (#2767)", () => {
  /** `b` previews `remote` on slot 4100 once started: its launcher finds a dev server on 5173, and
   *  binding emits the `session:preview` frame its mirror on `a` relays. */
  function previewOnMachine(b: Node) {
    const bound: Record<string, SessionPreviewState> = {};
    const ensure = (id: string, devPort: number) => {
      expect(devPort).toBe(5173);
      bound[id] = { previewPort: 4100 };
      b.deps.events.emit("session:preview", { id, previewPort: 4100 });
      return 4100;
    };
    const machine = {
      ensure: mock(ensure),
      findDevPort: mock(async () => 5173),
      stop: spyOn(b.deps.service, "stopPreview").mockReturnValue({ result: "stopped", killed: 1 }),
    };
    spyOn(b.deps.service, "refreshForStop").mockResolvedValue();
    Object.assign(b.deps, {
      preview: { snapshot: () => bound, ensure: machine.ensure },
      previewServe: {
        snapshot: () => Object.fromEntries(Object.keys(bound).map((id) => [id, "ok"])),
      },
      previewLauncher: {
        findDevPort: machine.findDevPort,
        scriptExists: async () => false,
        scriptPath: async () => null,
        ensureScript: async () => null,
        startScript: async () => {},
      },
    });
    return machine;
  }

  test("starts and stops on the machine and opens at the machine's own host and slot", async () => {
    Object.assign(config, { previewHost: "machine.example.ts.net", previewAutoServe: true });
    const { a, b, remote } = await pair();
    const machine = previewOnMachine(b);
    // The coordinator previews a session of its own on the SAME slot number.
    const localEnsure = mock(() => 4100);
    Object.assign(a.deps, {
      preview: { snapshot: () => ({ "local-1": { previewPort: 4100 } }), ensure: localEnsure },
    });

    const relayed: [string, unknown][] = [];
    a.deps.remoteSessions.subscribe((event, data) => relayed.push([event, data]));

    const start = await call(a, "POST", `/api/sessions/${remote.id}/preview/start`, { json: {} });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ ok: true, mode: "local", alreadyRunning: true });
    expect(machine.findDevPort).toHaveBeenCalledWith(repo, remote.id);
    expect(machine.ensure).toHaveBeenCalledWith(remote.id, 5173);
    // The machine's frame reaches dashboards through the mirror, marked as the machine's.
    const frame = await until(
      () => relayed.find(([event]) => event === "session:preview"),
      (f) => f !== undefined,
    );
    expect(frame![1]).toMatchObject({ id: remote.id, host: { instanceId: expect.any(String) } });

    const reach = await call(a, "GET", `/api/sessions/${remote.id}/preview`);
    expect(reach.status).toBe(200);
    expect(await reach.json()).toEqual({
      bound: true,
      url: "https://machine.example.ts.net:4100/",
      unavailable: null,
    });

    const stop = await call(a, "POST", `/api/sessions/${remote.id}/preview/stop`);
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ killed: 1 });
    expect(machine.stop).toHaveBeenCalledWith(remote.id, "SIGKILL");

    // Nothing of the machine's preview became the coordinator's: no slot bound, no port in its
    // snapshot, no `session:preview` on its own hub (where tailscale serve would pick it up).
    expect(localEnsure).not.toHaveBeenCalled();
    const snapshot = await call(a, "GET", "/api/preview");
    expect(await snapshot.json()).toEqual({ "local-1": { previewPort: 4100 } });
    untouched(a);
  });

  test("a machine that cannot publish previews is explained, never given a URL", async () => {
    Object.assign(config, { previewHost: "machine.example.ts.net", previewAutoServe: true });
    const { a, b, remote } = await pair();
    Object.assign(b.deps, {
      preview: { snapshot: () => ({}) },
      previewServe: { snapshot: () => ({}), permissionDenied: () => true },
    });
    const denied = await call(a, "GET", `/api/sessions/${remote.id}/preview`);
    expect(await denied.json()).toEqual({ bound: false, url: null, unavailable: "serve_denied" });

    config.previewHost = null;
    const unserved = await call(a, "GET", `/api/sessions/${remote.id}/preview`);
    expect(await unserved.json()).toEqual({ bound: false, url: null, unavailable: "not_served" });
    untouched(a);
  });
});

describe("the coordinator's gates hold for forwarded routes", () => {
  test.each([
    ["read", null, 403],
    ["submit", null, 403],
    ["full", "restricted", 404],
  ] as const)(
    "a %s token (%s) is refused before anything is forwarded",
    async (scope, restricted, status) => {
      const { a, b, remote } = await pair();
      const token = a.deps.accessTokens.mint(
        "caller",
        null,
        scope,
        restricted ? [repo] : null,
      ).token;
      for (const [method, leaf] of [
        ["POST", "reply"],
        ["POST", "interrupt"],
        ["GET", "diff"],
      ] as const) {
        const res = await call(a, method, `/api/sessions/${remote.id}/${leaf}`, {
          token,
          json: method === "POST" ? { text: "x" } : undefined,
        });
        expect(res.status).toBe(status);
      }
      expect(outbound).toEqual([]);
      for (const spy of Object.values(b.spies)) expect(spy).not.toHaveBeenCalled();
      untouched(a);
    },
  );

  test("the agent ingress never reaches a mirrored session", async () => {
    const { a, remote } = await pair();
    const ingress = makeAgentIngressApp(a.deps);
    const res = await ingress.fetch(
      new Request(`http://127.0.0.1/api/sessions/${remote.id}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "hijacked" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(outbound).toEqual([]);
  });

  test("a browser request from a foreign origin is refused before anything is forwarded", async () => {
    const { a, b, remote } = await pair();
    const res = await call(a, "POST", `/api/sessions/${remote.id}/reply`, {
      json: { text: "x" },
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(outbound).toEqual([]);
    expect(b.spies.reply).not.toHaveBeenCalled();
    untouched(a);
  });

  test("a machine that no longer accepts this server's token never signs the caller out", async () => {
    const { a, b, remote } = await pair();
    b.deps.accessTokens.revoke(b.tokenId);
    const res = await call(a, "POST", `/api/sessions/${remote.id}/interrupt`);
    // 502 either way — refused by the machine, or its link already dropped — and never a 401.
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: expect.stringMatching(/^machine_(unauthorized|unreachable)$/),
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(b.spies.interrupt).not.toHaveBeenCalled();
    untouched(a);
  });
});

describe("a session id more than one machine reports", () => {
  const DUP = "0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
  test("is refused, never sent to either machine or run here", async () => {
    const store = new SessionStore(":memory:");
    const accessTokens = new AccessTokenService(store);
    const service = { archive: async () => 0, operatorReply: async () => true };
    const archive = spyOn(service, "archive");
    const deps = {
      store,
      events: new EventHub(),
      service,
      accessTokens,
      remoteSessions: { has: () => true, route: () => null },
      usageLimits: {},
    } as unknown as AppDeps;
    const { token } = accessTokens.mint("caller", null, "full", null);
    for (const method of ["DELETE", "POST"]) {
      const res = await makeApp(deps).fetch(
        new Request(`http://localhost/api/sessions/${DUP}${method === "POST" ? "/reply" : ""}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "x" }),
        }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "remote_ambiguous" });
    }
    expect(archive).not.toHaveBeenCalled();
    expect(outbound).toEqual([]);
  });
});

describe("clear-merged across machines", () => {
  test("one outcome per machine, and a partial result when a machine is down", async () => {
    const a = startNode();
    const b = startNode();
    const c = startNode();
    const local = startSession(a, "on-a");
    const onB = startSession(b, "on-b");
    const onC = startSession(c, "on-c");
    for (const [node, s] of [
      [a, local],
      [b, onB],
      [c, onC],
    ] as const)
      node.merged.add(s.id);
    await connectWith(a, b, onB);
    await connectWith(a, c, onC);
    c.server.stop(true);
    await until(
      () => sessions(a),
      (l) => l.some((s) => s.id === onC.id && s.connection?.state === "disconnected"),
    );

    const preview = (await (await call(a, "GET", "/api/sessions/clear-merged")).json()) as {
      ids: string[];
      machines: { name: string; ok: boolean; reason?: string; ids: string[] }[];
    };
    expect(preview.ids).toEqual([local.id, onB.id]);
    expect(preview.machines.map(({ ok, reason, ids }) => ({ ok, reason, ids }))).toEqual([
      { ok: true, reason: undefined, ids: [onB.id] },
      { ok: false, reason: "disconnected", ids: [] },
    ]);

    const res = await call(a, "POST", "/api/sessions/clear-merged", {
      json: { ids: [local.id, onB.id, onC.id] },
    });
    const result = (await res.json()) as {
      cleared: string[];
      partial: boolean;
      machines: { ok: boolean; reason?: string; requested: string[]; cleared: string[] }[];
    };
    expect(res.status).toBe(200);
    expect(result.cleared).toEqual([local.id, onB.id]);
    expect(result.partial).toBe(true);
    expect(
      result.machines.map(({ ok, reason, requested, cleared }) => ({
        ok,
        reason,
        requested,
        cleared,
      })),
    ).toEqual([
      { ok: true, reason: undefined, requested: [onB.id], cleared: [onB.id] },
      { ok: false, reason: "disconnected", requested: [onC.id], cleared: [] },
    ]);
    expect(a.spies.archiveMany).toHaveBeenCalledWith([local.id], "merged");
    expect(b.spies.archiveMany).toHaveBeenCalledWith([onB.id], "merged");
  });

  test("a machine asked with host=local clears only its own sessions", async () => {
    const { a, b, remote } = await pair();
    b.merged.add(remote.id);
    const res = await call(a, "POST", "/api/sessions/clear-merged?host=local", {
      json: { ids: [remote.id] },
    });
    expect(await res.json()).toEqual({ cleared: [], leftovers: 0, partial: false, machines: [] });
    expect(outbound).toEqual([]);
    expect(b.spies.archiveMany).not.toHaveBeenCalled();
  });
});

describe("the literal routes under /api/sessions stay this server's", () => {
  test("clear-merged, done and archived answer here even if a mirror claims those ids", async () => {
    const store = new SessionStore(":memory:");
    const accessTokens = new AccessTokenService(store);
    const service = {
      leftovers: () => [],
      leftoverProbesUnavailable: () => false,
      archiveMany: async () => ({ cleared: [], leftovers: 0 }),
    };
    // A mirror that would claim ANY id — as one fed by a machine reporting `clear-merged`.
    const route = { host: { instanceId: "m", name: "Rogue", platform: "linux" }, target: null };
    const deps = {
      store,
      events: new EventHub(),
      service,
      accessTokens,
      remoteSessions: {
        has: () => true,
        route: () => route,
        machines: () => [],
        list: () => [],
      },
      usageLimits: {},
    } as unknown as AppDeps;
    const { token } = accessTokens.mint("caller", null, "full", null);
    const call = (method: string, path: string) =>
      makeApp(deps).fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ ids: [] }) } : {}),
        }),
      );
    for (const [method, path] of [
      ["GET", "/api/sessions/clear-merged"],
      ["POST", "/api/sessions/clear-merged"],
      ["GET", "/api/sessions/done"],
      ["GET", "/api/sessions/archived"],
    ] as const) {
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, 200]);
      expect(await res.json()).not.toMatchObject({ code: "remote_unsupported" });
    }
    expect(outbound).toEqual([]);
  });
});
