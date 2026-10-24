import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PushService, type SendFn } from "../src/push";
import type { FetchLike } from "../src/remote-instances/client";
import { attachMirrorPush } from "../src/remote-instances/push-relay";
import type { RemoteInstanceRow, RemoteInstanceSummary } from "../src/remote-instances/service";
import { type OpenSocket, RemoteSessionMirror, hostNames } from "../src/remote-instances/sessions";
import type { OpenTerminalSocket } from "../src/remote-instances/terminal";
import { SessionStore } from "../src/store";

const B = "0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d";
const C = "1c7f3d2f-8d2e-4f64-8e2b-4d2f3f5c6b7e";
const TOKEN = "shp_remote-token-for-b-0123456789";

function machine(over: Partial<RemoteInstanceSummary> = {}): RemoteInstanceSummary {
  return {
    instanceId: B,
    name: "MacBook",
    label: null,
    reportedName: "MacBook",
    url: "http://b.test:7777",
    tokenHint: "6789",
    createdAt: 1,
    status: "connected",
    reason: null,
    checkedAt: 1,
    lastSeenAt: 1,
    info: { version: "2.2.0", federationApi: 1, platform: "macos", arch: "arm64" },
    projects: [],
    capabilities: null,
    released: true,
    ...over,
  };
}

function row(over: Partial<RemoteInstanceRow> = {}): RemoteInstanceRow {
  return {
    instanceId: B,
    url: "http://b.test:7777",
    token: TOKEN,
    label: null,
    reportedName: "MacBook",
    createdAt: 1,
    ...over,
  };
}

// Session IDs as every Shepherd mints them (randomUUID) — the mirror holds nothing else (#2765).
const S1 = "5f0e8a52-1c2d-4e3f-8a4b-000000000001";
const S2 = "5f0e8a52-1c2d-4e3f-8a4b-000000000002";
const S3 = "5f0e8a52-1c2d-4e3f-8a4b-000000000003";
const LATE = "5f0e8a52-1c2d-4e3f-8a4b-00000000000f";

const s1 = { id: S1, desig: "TASK-07", name: "login", status: "running" };
const s2 = { id: S2, desig: "TASK-08", name: "docs", status: "idle" };

interface FakeSocket {
  url: string;
  headers: Record<string, string>;
  on: Parameters<OpenSocket>[2];
  closed: boolean;
  close(): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A mirror wired to fakes: `machines` is what the probe service reports, `snapshot` what
 *  `GET /api/sessions?host=local` answers (a function to defer or fail it), `git` what
 *  `GET /api/git` answers. */
function setup(
  opts: {
    snapshot?: () => unknown | Promise<Response>;
    git?: () => unknown | Promise<Response>;
    self?: () => { instanceId: string; name: string };
  } = {},
) {
  let now = 1_000;
  const state = {
    machines: [machine()],
    rows: new Map([[B, row()]]),
    snapshot: opts.snapshot ?? (() => [s1, s2]),
    git: opts.git ?? (() => ({})),
    /** What each machine's last probe said its checkout paths belong to. */
    repoSlugs: new Map<string, Map<string, string>>(),
  };
  const sockets: FakeSocket[] = [];
  const terminals: { url: string; headers: Record<string, string>; closed: boolean }[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const checks: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const body = await (url.endsWith("/api/git") ? state.git() : state.snapshot());
    return body instanceof Response ? body : Response.json(body);
  };
  const openSocket: OpenSocket = (url, headers, on) => {
    const socket: FakeSocket = {
      url,
      headers,
      on,
      closed: false,
      close() {
        socket.closed = true;
      },
    };
    sockets.push(socket);
    return socket;
  };
  const mirror = new RemoteSessionMirror({
    store: { getRemoteInstance: (id) => state.rows.get(id) ?? null },
    instances: {
      list: () => state.machines,
      check: async (id) => {
        checks.push(id);
        return null;
      },
      repoSlugs: (id) => state.repoSlugs.get(id) ?? new Map(),
    },
    self: opts.self,
    fetch,
    openSocket,
    openTerminalSocket: ((url, headers) => {
      const terminal = { url, headers, closed: false };
      terminals.push(terminal);
      return { send: () => {}, close: () => (terminal.closed = true) };
    }) satisfies OpenTerminalSocket,
    now: () => now,
    recheckDelaysMs: [1, 1],
  });
  const events: [string, unknown][] = [];
  mirror.subscribe((event, data) => events.push([event, data]));
  mirrors.push(mirror);
  return {
    mirror,
    state,
    sockets,
    terminals,
    requests,
    checks,
    events,
    tick: (ms: number) => (now += ms),
    /** sync, open the socket and wait for the snapshot. */
    async live() {
      mirror.sync(B);
      sockets.at(-1)!.on.open();
      await flush();
      return sockets.at(-1)!;
    },
  };
}

function send(socket: FakeSocket, event: string, data: unknown) {
  socket.on.message(JSON.stringify({ event, data }));
}

const mirrors: RemoteSessionMirror[] = [];
afterEach(() => {
  for (const m of mirrors.splice(0)) m.stop();
});

describe("session mirror", () => {
  test("nothing is opened until a machine is synced", () => {
    const { sockets, requests, mirror } = setup();
    expect(sockets).toEqual([]);
    expect(requests).toEqual([]);
    expect(mirror.list()).toEqual([]);
  });

  test("a connected machine's own sessions appear with host and connection", async () => {
    const t = setup();
    const socket = await t.live();
    expect(socket.url).toBe("ws://b.test:7777/events?host=local");
    expect(socket.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(t.requests.map((r) => r.url)).toEqual([
      "http://b.test:7777/api/sessions?host=local",
      "http://b.test:7777/api/git",
    ]);
    for (const r of t.requests) {
      expect(new Headers(r.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    const host = { instanceId: B, name: "MacBook", platform: "macos" };
    const connection = { state: "connected" as const, since: 1_000 };
    expect(t.mirror.list()).toEqual([
      { ...s1, host, connection },
      { ...s2, host, connection },
    ]);
    expect(t.events).toEqual([["remote:sessions", { instanceId: B, sessions: t.mirror.list() }]]);
  });

  test("the mirror names itself on the socket and the snapshot, the name percent-encoded", async () => {
    const t = setup({ self: () => ({ instanceId: C, name: "Müllers Mac 🍎" }) });
    const socket = await t.live();
    const identity = {
      "x-shepherd-instance-id": C,
      "x-shepherd-instance-name": "M%C3%BCllers%20Mac%20%F0%9F%8D%8E",
    };
    expect(socket.headers).toEqual({ ...identity, authorization: `Bearer ${TOKEN}` });
    const sent = new Headers(t.requests[0]!.init.headers);
    expect(Object.fromEntries(sent)).toEqual({
      ...identity,
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
    });
    expect(decodeURIComponent(sent.get("x-shepherd-instance-name")!)).toBe("Müllers Mac 🍎");
  });

  test("an https machine is reached over wss", () => {
    const t = setup();
    t.state.rows.set(B, row({ url: "https://b.test" }));
    t.mirror.sync(B);
    expect(t.sockets[0]!.url).toBe("wss://b.test/events?host=local");
  });

  test("session frames relay annotated and keep the held copy current", async () => {
    const t = setup();
    const socket = await t.live();
    t.events.length = 0;
    const s3 = { id: S3, desig: "TASK-09", name: "new", status: "running" };
    send(socket, "session:new", s3);
    send(socket, "session:status", { id: S1, status: "idle" });
    send(socket, "session:renamed", { id: S2, name: "docs v2", branch: "b" });
    send(socket, "session:archived", { id: S3 });
    send(socket, "session:git", { id: S1, git: { state: "open" } });
    expect(t.mirror.list().map(({ id, status, name }) => ({ id, status, name }))).toEqual([
      { id: S1, status: "idle", name: "login" },
      { id: S2, status: "idle", name: "docs v2" },
    ]);
    const host = { instanceId: B, name: "MacBook", platform: "macos" };
    const connection = { state: "connected" as const, since: 1_000 };
    expect(t.events).toEqual([
      ["session:new", { ...s3, host, connection }],
      ["session:status", { id: S1, status: "idle", host, connection }],
      ["session:renamed", { id: S2, name: "docs v2", branch: "b", host, connection }],
      ["session:archived", { id: S3, host, connection }],
      ["session:git", { id: S1, git: { state: "open" }, host, connection }],
    ]);
  });

  test("a session names its project when the machine's repo index knows its checkout", async () => {
    const t = setup({
      snapshot: () => [
        { ...s1, repoPath: "/Users/k/shepherd" },
        { ...s2, repoPath: "/Users/k/scratch" },
      ],
    });
    t.state.repoSlugs.set(B, new Map([["/Users/k/shepherd", "erwins-enkel/shepherd"]]));
    const socket = await t.live();
    const [known, unknown] = t.mirror.list();
    expect(known).toMatchObject({ id: S1, remoteSlug: "erwins-enkel/shepherd" });
    expect(unknown).not.toHaveProperty("remoteSlug");
    expect(t.mirror.session(S1)?.remoteSlug).toBe("erwins-enkel/shepherd");
    t.events.length = 0;
    const s3 = { id: S3, desig: "TASK-09", name: "new", status: "running" };
    send(socket, "session:new", { ...s3, repoPath: "/Users/k/shepherd" });
    expect(t.events[0]).toEqual([
      "session:new",
      expect.objectContaining({ id: S3, remoteSlug: "erwins-enkel/shepherd" }),
    ]);
  });

  test("machine-wide, malformed and already-mirrored input is ignored", async () => {
    const t = setup({
      snapshot: () => [s1, { id: "x", host: { instanceId: C, name: "C", platform: "linux" } }],
    });
    const socket = await t.live();
    expect(t.mirror.list().map((s) => s.id)).toEqual([S1]);
    t.events.length = 0;
    send(socket, "usage:limits", { id: S1 });
    send(socket, "held:changed", { count: 3 });
    send(socket, "session:new", { id: "y", host: { instanceId: C } });
    send(socket, "session:status", { status: "idle" });
    socket.on.message("{not json");
    socket.on.message(new Uint8Array([1, 2]));
    expect(t.events).toEqual([]);
    expect(t.mirror.list().map((s) => s.id)).toEqual([S1]);
  });

  test("an ID that is not a UUID is never held — it could read as a route here (#2765)", async () => {
    const t = setup({
      snapshot: () => [s1, { ...s2, id: "clear-merged" }, { ...s2, id: "done" }],
    });
    const socket = await t.live();
    send(socket, "session:new", { ...s2, id: "archived" });
    expect(t.mirror.list().map((s) => s.id)).toEqual([S1]);
    for (const id of ["clear-merged", "done", "archived"]) {
      expect(t.mirror.has(id)).toBe(false);
      expect(t.mirror.route(id)).toBeNull();
    }
  });

  test("frames that arrive during the snapshot are replayed on top of it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({
      snapshot: async () => {
        await gate;
        return Response.json([s1, s2]);
      },
    });
    t.mirror.sync(B);
    const socket = t.sockets[0]!;
    socket.on.open();
    send(socket, "session:status", { id: S1, status: "idle" });
    send(socket, "session:archived", { id: S2 });
    release();
    await flush();
    expect(t.mirror.list().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: S1, status: "idle" },
    ]);
  });

  test("the machine's PR state rides on its sessions (#3055)", async () => {
    const green = { state: "open", checks: "success", deployConfigured: false };
    const t = setup({
      git: () => ({ [S1]: green, [S2]: "not a record", "not-a-uuid": green }),
    });
    await t.live();
    expect(t.mirror.list().map(({ id, git }) => ({ id, git }))).toEqual([
      { id: S1, git: green },
      { id: S2, git: undefined },
    ]);
    expect(t.events).toEqual([["remote:sessions", { instanceId: B, sessions: t.mirror.list() }]]);
  });

  test("a session:git frame updates the held PR state; archiving forgets it", async () => {
    const t = setup();
    const socket = await t.live();
    t.events.length = 0;
    const host = { instanceId: B, name: "MacBook", platform: "macos" };
    const connection = { state: "connected" as const, since: 1_000 };
    const pending = { state: "open", checks: "pending" };
    send(socket, "session:git", { id: S2, git: pending });
    send(socket, "session:status", { id: S2, status: "idle" });
    send(socket, "session:git", { id: S2, git: "not a record" });
    expect(t.mirror.list().find((s) => s.id === S2)?.git).toEqual(pending);
    expect(t.events.slice(0, 2)).toEqual([
      ["session:git", { id: S2, git: pending, host, connection }],
      ["session:status", { git: pending, id: S2, status: "idle", host, connection }],
    ]);
    send(socket, "session:archived", { id: S2 });
    send(socket, "session:new", s2);
    expect(t.mirror.list().find((s) => s.id === S2)?.git).toBeUndefined();
  });

  test("a PR state frame during the snapshot is replayed on top of it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({
      git: async () => {
        await gate;
        return Response.json({ [S1]: { state: "open", checks: "pending" } });
      },
    });
    t.mirror.sync(B);
    const socket = t.sockets[0]!;
    socket.on.open();
    send(socket, "session:git", { id: S1, git: { state: "open", checks: "success" } });
    release();
    await flush();
    expect(t.mirror.list().find((s) => s.id === S1)?.git).toEqual({
      state: "open",
      checks: "success",
    });
  });

  test("a PR state the machine cannot answer leaves its sessions mirrored without one", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = setup({ git: () => new Response("nope", { status: 500 }) });
      const socket = await t.live();
      expect(socket.closed).toBe(false);
      expect(t.mirror.list().map(({ id, connection, git }) => ({ id, connection, git }))).toEqual([
        { id: S1, connection: { state: "connected", since: 1_000 }, git: undefined },
        { id: S2, connection: { state: "connected", since: 1_000 }, git: undefined },
      ]);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  test("a lost socket keeps the sessions as disconnected and re-probes", async () => {
    const t = setup();
    const socket = await t.live();
    send(socket, "session:status", { id: S1, status: "idle" });
    t.tick(5_000);
    t.events.length = 0;
    socket.on.close();
    const disconnected = { state: "disconnected" as const, since: 6_000 };
    expect(
      t.mirror.list().map(({ id, status, connection }) => ({ id, status, connection })),
    ).toEqual([
      { id: S1, status: "idle", connection: disconnected },
      { id: S2, status: "idle", connection: disconnected },
    ]);
    expect(t.events).toEqual([["remote:sessions", { instanceId: B, sessions: t.mirror.list() }]]);
    await Bun.sleep(5);
    expect(t.checks).toEqual([B]);
    // A late close from the same socket is not a second loss.
    socket.on.close();
    expect(t.events).toHaveLength(1);
  });

  test("a reconnect reconciles with a fresh snapshot", async () => {
    const t = setup();
    const first = await t.live();
    first.on.close();
    t.state.snapshot = () => [{ ...s1, status: "done" }];
    t.tick(1_000);
    const second = await t.live();
    expect(second).not.toBe(first);
    expect(t.mirror.list()).toEqual([
      {
        ...s1,
        status: "done",
        host: { instanceId: B, name: "MacBook", platform: "macos" },
        connection: { state: "connected" as const, since: 2_000 },
      },
    ]);
  });

  test("a probe that is not connected closes the socket and never reopens it by itself", async () => {
    const t = setup();
    const socket = await t.live();
    for (const status of ["unreachable", "identity_mismatch"] as const) {
      t.state.machines = [machine({ status })];
      t.mirror.sync(B);
    }
    expect(socket.closed).toBe(true);
    expect(t.sockets).toHaveLength(1);
    expect(t.mirror.list().every((s) => s.connection.state === "disconnected")).toBe(true);
    // A frame from the closed socket no longer counts.
    send(socket, "session:new", { id: LATE });
    expect(t.mirror.list().map((s) => s.id)).toEqual([S1, S2]);
  });

  test("a probe while live re-snapshots, so drift heals each round", async () => {
    const t = setup();
    await t.live();
    t.state.snapshot = () => [s2];
    t.mirror.sync(B);
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.mirror.list().map((s) => s.id)).toEqual([S2]);
  });

  test("a failed snapshot counts as a lost connection", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = setup({ snapshot: () => new Response("nope", { status: 500 }) });
      const socket = await t.live();
      expect(socket.closed).toBe(true);
      expect(t.mirror.list()).toEqual([]);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  test("removing the machine drops its sessions", async () => {
    const t = setup();
    const socket = await t.live();
    t.events.length = 0;
    t.state.machines = [];
    t.mirror.sync(B);
    expect(socket.closed).toBe(true);
    expect(t.mirror.list()).toEqual([]);
    expect(t.events).toEqual([["remote:sessions", { instanceId: B, sessions: [] }]]);
  });

  test("a rename re-publishes under the new name", async () => {
    const t = setup();
    await t.live();
    t.state.machines = [machine({ name: "Studio", label: "Studio" })];
    t.mirror.sync(B);
    await flush();
    expect(t.mirror.list().every((s) => s.host.name === "Studio")).toBe(true);
  });

  test("the token never lands in a URL or a relayed frame", async () => {
    const t = setup();
    const socket = await t.live();
    send(socket, "session:status", { id: S1, status: "idle" });
    expect(socket.url).not.toContain(TOKEN);
    expect(t.requests.every((r) => !r.url.includes(TOKEN))).toBe(true);
    expect(JSON.stringify(t.events)).not.toContain(TOKEN);
    expect(JSON.stringify(t.mirror.list())).not.toContain(TOKEN);
  });
});

describe("terminals of mirrored sessions (#2764)", () => {
  const attach = { cols: 90, rows: 30, clientKind: "browser", clientPlatform: "linux" };
  function sink() {
    const closes: (number | undefined)[] = [];
    return { closes, send: () => {}, close: (code?: number) => void closes.push(code) };
  }

  test("a live machine's session bridges to its /pty/:id with the token in the header only", async () => {
    const t = setup();
    await t.live();
    expect(t.mirror.has(S1)).toBe(true);
    expect(t.mirror.has("nope")).toBe(false);
    const caller = sink();
    t.mirror.openTerminal(S1, caller, attach);
    expect(t.terminals).toHaveLength(1);
    expect(t.terminals[0]!.url).toBe(
      `ws://b.test:7777/pty/${S1}?cols=90&rows=30&clientKind=browser&clientPlatform=linux`,
    );
    expect(t.terminals[0]!.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(caller.closes).toEqual([]);
  });

  test("an unknown session or a disconnected machine closes as unreachable without a socket", async () => {
    const t = setup();
    const socket = await t.live();
    const unknown = sink();
    t.mirror.openTerminal("nope", unknown, attach);
    expect(unknown.closes).toEqual([4002]);
    socket.on.close();
    expect(t.mirror.has(S1)).toBe(true); // still shown, as disconnected
    const offline = sink();
    t.mirror.openTerminal(S1, offline, attach);
    expect(offline.closes).toEqual([4002]);
    expect(t.terminals).toEqual([]);
  });

  test("a lost link or a removed machine ends its open terminals", async () => {
    const t = setup();
    const socket = await t.live();
    const first = sink();
    t.mirror.openTerminal(S1, first, attach);
    socket.on.close();
    expect(first.closes).toEqual([4002]);
    expect(t.terminals[0]!.closed).toBe(true);

    await t.live();
    const second = sink();
    t.mirror.openTerminal(S2, second, attach);
    t.state.machines = [];
    t.mirror.sync(B);
    expect(second.closes).toEqual([4002]);
    expect(t.terminals[1]!.closed).toBe(true);
  });

  test("the machine's terminal owners are relayed and forgotten when it drops", async () => {
    const t = setup();
    const socket = await t.live();
    t.events.length = 0;
    send(socket, "terminal:owners", {
      owners: {
        s1: { kind: "mac-app", platform: "macos" },
        s2: { kind: 7, platform: "linux" },
        s3: "browser",
      },
    });
    expect(t.mirror.terminalOwners()).toEqual({ s1: { kind: "mac-app", platform: "macos" } });
    expect(t.events).toEqual([
      ["terminal:owners", { owners: { s1: { kind: "mac-app", platform: "macos" } } }],
    ]);
    send(socket, "terminal:owners", { owners: {} });
    expect(t.mirror.terminalOwners()).toEqual({});
    send(socket, "terminal:owners", { owners: { s2: { kind: "browser", platform: "linux" } } });
    t.events.length = 0;
    socket.on.close();
    expect(t.mirror.terminalOwners()).toEqual({});
    expect(t.events).toContainEqual(["terminal:owners", { owners: {} }]);
  });
});

describe("routes of mirrored sessions (#2765)", () => {
  const host = { instanceId: B, name: "MacBook", platform: "macos" };
  const target = { url: "http://b.test:7777", token: TOKEN };

  test("a mirrored session routes to its live machine; an unknown one has no route", async () => {
    const t = setup();
    expect(t.mirror.machines()).toEqual([]); // never synced: nothing to reach
    await t.live();
    expect(t.mirror.route(S1)).toEqual({
      host,
      target,
      connection: t.mirror.session(S1)!.connection,
    });
    expect(t.mirror.route("nope")).toBeNull();
    expect(t.mirror.machines()).toEqual([
      { host, target, connection: t.mirror.session(S1)!.connection },
    ]);
  });

  test("a disconnected machine keeps its route but without a target", async () => {
    const t = setup();
    const socket = await t.live();
    socket.on.close();
    expect(t.mirror.route(S2)).toEqual({
      host,
      target: null,
      connection: t.mirror.session(S2)!.connection,
    });
    expect(t.mirror.machines()).toEqual([
      { host, target: null, connection: t.mirror.session(S2)!.connection },
    ]);
  });

  test("a session two machines both report routes nowhere", async () => {
    const t = setup();
    t.state.machines = [machine(), machine({ instanceId: C, name: "Studio" })];
    t.state.rows.set(C, row({ instanceId: C, url: "http://c.test:7777" }));
    await t.live();
    t.mirror.sync(C);
    t.sockets.at(-1)!.on.open();
    await flush();
    expect(t.mirror.has(S1)).toBe(true);
    expect(t.mirror.route(S1)).toBeNull();
  });

  test("a removed machine routes nothing", async () => {
    const t = setup();
    await t.live();
    t.state.machines = [];
    t.mirror.sync(B);
    expect(t.mirror.route(S1)).toBeNull();
    expect(t.mirror.machines()).toEqual([]);
  });
});

describe("notifications of mirrored sessions (#3058)", () => {
  /** The coordinator's push service, relaying `t.mirror`, with three devices: one registered here
   *  only, one registered with the MacBook too, and an older client that sent no relay fields. */
  function relayed(t: ReturnType<typeof setup>) {
    const store = new SessionStore(":memory:");
    const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
    const deliver: SendFn = async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return {};
    };
    const push = new PushService(store, deliver, () => ({ publicKey: "P", privateKey: "Q" }));
    const keys = { p256dh: "p", auth: "a" };
    store.putPushSub(
      { endpoint: "here-only", keys, relay: { coveredInstances: [], relayRemote: true } },
      "",
    );
    store.putPushSub(
      { endpoint: "both", keys, relay: { coveredInstances: [B], relayRemote: true } },
      "",
    );
    store.putPushSub({ endpoint: "older-client", keys }, "");
    attachMirrorPush(t.mirror, push);
    return sent;
  }

  const menu = { shape: "menu", options: [], tail: [] };

  test("a blocked session reaches the device registered here only, exactly once", async () => {
    const t = setup();
    const sent = relayed(t);
    const socket = await t.live();
    send(socket, "session:block", { id: S1, block: menu });
    await flush();
    expect(sent).toEqual([
      {
        endpoint: "here-only",
        payload: {
          title: "MacBook · login — needs you",
          body: "Waiting on a menu choice.",
          sessionId: S1,
          kind: "blocked",
          tag: S1,
          instanceId: B,
        },
      },
    ]);
  });

  test("finished, review and login frames relay like their local counterparts; others do not", async () => {
    const t = setup();
    const sent = relayed(t);
    const socket = await t.live();
    send(socket, "session:status", { id: S2, status: "done" });
    send(socket, "session:status", { id: S1, status: "idle" });
    send(socket, "session:review", { id: S1, review: { decision: "changes_requested" } });
    send(socket, "session:review", { id: S2, review: { decision: "commented", dismissed: true } });
    send(socket, "session:review", { id: S2, review: { decision: "approved" } });
    send(socket, "session:login-request", {
      id: S2,
      request: { id: "r1", url: "https://github.com/login", reason: "push the branch" },
    });
    send(socket, "session:block", { id: S1, block: null });
    send(socket, "session:git", { id: S1, git: { checks: "failure" } });
    send(socket, "session:block", { id: LATE, block: menu });
    await flush();
    expect(sent.map(({ endpoint, payload }) => [endpoint, payload.kind, payload.title])).toEqual([
      ["here-only", "done", "MacBook · docs — waiting"],
      ["here-only", "review", "MacBook · login — review"],
      ["here-only", "login_request", "MacBook · docs — log in for it"],
    ]);
    expect(sent[2]!.payload.body).toBe(
      "Log in at github.com in the Shared Browser: push the branch",
    );
  });

  test("a reconnect snapshot announces nothing; a frame during it is announced once", async () => {
    const t = setup();
    const sent = relayed(t);
    (await t.live()).on.close();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.state.snapshot = async () => {
      await gate;
      return Response.json([
        { ...s1, status: "done" },
        { ...s2, status: "done" },
      ]);
    };
    t.mirror.sync(B);
    const socket = t.sockets.at(-1)!;
    socket.on.open();
    send(socket, "session:block", { id: S2, block: menu });
    release();
    await flush();
    await flush();
    expect(t.mirror.list().map(({ status }) => status)).toEqual(["done", "done"]);
    expect(sent.map(({ payload }) => [payload.kind, payload.sessionId])).toEqual([["blocked", S2]]);
  });
});

describe("hostNames", () => {
  test("names stay as they are unless two machines share one", () => {
    expect(
      hostNames([
        { instanceId: B, name: "MacBook" },
        { instanceId: C, name: "shepherd" },
        { instanceId: "2d8e4e3a-0000-4000-8000-000000000000", name: "shepherd" },
      ]),
    ).toEqual(
      new Map([
        [B, "MacBook"],
        [C, "shepherd (1c7f)"],
        ["2d8e4e3a-0000-4000-8000-000000000000", "shepherd (2d8e)"],
      ]),
    );
  });
});

test("native session state and queue frames keep the owning machine", async () => {
  const t = setup();
  const socket = await t.live();
  send(socket, "session:status", { id: S1, status: "running", runtimeModel: "owner-model" });
  send(socket, "session:ready", { id: S1, ready: true });
  send(socket, "session:autopilot", { id: S1, enabled: true, paused: true, complete: false });
  send(socket, "session:automerge", { id: S1, enabled: true });
  send(socket, "session:plangate", {
    id: S1,
    planPhase: "executing",
    gate: { summary: "not a session field" },
  });
  send(socket, "session:manual-steps", { id: S1, manualSteps: [{ id: "m", text: "check" }] });
  expect(t.mirror.session(S1)).toMatchObject({
    runtimeModel: "owner-model",
    readyToMerge: true,
    autopilotEnabled: true,
    autopilotPaused: true,
    autoMergeEnabled: true,
    planPhase: "executing",
    manualSteps: [{ id: "m", text: "check" }],
  });
  expect(t.mirror.session(S1)).not.toHaveProperty("gate");
  t.events.length = 0;
  send(socket, "queue:update", { sessionId: S1, steps: [], approved: true });
  send(socket, "queue:update", { sessionId: S3, steps: [], approved: false });
  expect(t.events).toHaveLength(1);
  expect(t.events[0]).toEqual([
    "queue:update",
    {
      id: S1,
      sessionId: S1,
      steps: [],
      approved: true,
      host: t.mirror.session(S1)!.host,
      connection: t.mirror.session(S1)!.connection,
    },
  ]);
  const created = t.mirror.acceptSession(B, { ...s1, id: S3 });
  expect(created?.host.instanceId).toBe(B);
  expect(t.mirror.route(S3)?.host.instanceId).toBe(B);
});
