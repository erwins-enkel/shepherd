import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { FetchLike } from "../src/remote-instances/client";
import type { RemoteInstanceRow, RemoteInstanceSummary } from "../src/remote-instances/service";
import { type OpenSocket, RemoteSessionMirror, hostNames } from "../src/remote-instances/sessions";
import type { OpenTerminalSocket } from "../src/remote-instances/terminal";

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

const s1 = { id: "s1", desig: "TASK-07", name: "login", status: "running" };
const s2 = { id: "s2", desig: "TASK-08", name: "docs", status: "idle" };

interface FakeSocket {
  url: string;
  headers: Record<string, string>;
  on: Parameters<OpenSocket>[2];
  closed: boolean;
  close(): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A mirror wired to fakes: `machines` is what the probe service reports, `snapshot` what
 *  `GET /api/sessions?host=local` answers (a function to defer or fail it). */
function setup(opts: { snapshot?: () => unknown | Promise<Response> } = {}) {
  let now = 1_000;
  const state = {
    machines: [machine()],
    rows: new Map([[B, row()]]),
    snapshot: opts.snapshot ?? (() => [s1, s2]),
  };
  const sockets: FakeSocket[] = [];
  const terminals: { url: string; headers: Record<string, string>; closed: boolean }[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const checks: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const body = await state.snapshot();
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
    },
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
    expect(t.requests.map((r) => r.url)).toEqual(["http://b.test:7777/api/sessions?host=local"]);
    expect(new Headers(t.requests[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const host = { instanceId: B, name: "MacBook", platform: "macos" };
    const connection = { state: "connected" as const, since: 1_000 };
    expect(t.mirror.list()).toEqual([
      { ...s1, host, connection },
      { ...s2, host, connection },
    ]);
    expect(t.events).toEqual([["remote:sessions", { instanceId: B, sessions: t.mirror.list() }]]);
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
    const s3 = { id: "s3", desig: "TASK-09", name: "new", status: "running" };
    send(socket, "session:new", s3);
    send(socket, "session:status", { id: "s1", status: "idle" });
    send(socket, "session:renamed", { id: "s2", name: "docs v2", branch: "b" });
    send(socket, "session:archived", { id: "s3" });
    send(socket, "session:git", { id: "s1", git: { state: "open" } });
    expect(t.mirror.list().map(({ id, status, name }) => ({ id, status, name }))).toEqual([
      { id: "s1", status: "idle", name: "login" },
      { id: "s2", status: "idle", name: "docs v2" },
    ]);
    const host = { instanceId: B, name: "MacBook", platform: "macos" };
    const connection = { state: "connected" as const, since: 1_000 };
    expect(t.events).toEqual([
      ["session:new", { ...s3, host, connection }],
      ["session:status", { id: "s1", status: "idle", host, connection }],
      ["session:renamed", { id: "s2", name: "docs v2", branch: "b", host, connection }],
      ["session:archived", { id: "s3", host, connection }],
      ["session:git", { id: "s1", git: { state: "open" }, host, connection }],
    ]);
  });

  test("machine-wide, malformed and already-mirrored input is ignored", async () => {
    const t = setup({
      snapshot: () => [s1, { id: "x", host: { instanceId: C, name: "C", platform: "linux" } }],
    });
    const socket = await t.live();
    expect(t.mirror.list().map((s) => s.id)).toEqual(["s1"]);
    t.events.length = 0;
    send(socket, "usage:limits", { id: "s1" });
    send(socket, "held:changed", { count: 3 });
    send(socket, "session:new", { id: "y", host: { instanceId: C } });
    send(socket, "session:status", { status: "idle" });
    socket.on.message("{not json");
    socket.on.message(new Uint8Array([1, 2]));
    expect(t.events).toEqual([]);
    expect(t.mirror.list().map((s) => s.id)).toEqual(["s1"]);
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
    send(socket, "session:status", { id: "s1", status: "idle" });
    send(socket, "session:archived", { id: "s2" });
    release();
    await flush();
    expect(t.mirror.list().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "s1", status: "idle" },
    ]);
  });

  test("a lost socket keeps the sessions as disconnected and re-probes", async () => {
    const t = setup();
    const socket = await t.live();
    send(socket, "session:status", { id: "s1", status: "idle" });
    t.tick(5_000);
    t.events.length = 0;
    socket.on.close();
    const disconnected = { state: "disconnected" as const, since: 6_000 };
    expect(
      t.mirror.list().map(({ id, status, connection }) => ({ id, status, connection })),
    ).toEqual([
      { id: "s1", status: "idle", connection: disconnected },
      { id: "s2", status: "idle", connection: disconnected },
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
    send(socket, "session:new", { id: "late" });
    expect(t.mirror.list().map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  test("a probe while live re-snapshots, so drift heals each round", async () => {
    const t = setup();
    await t.live();
    t.state.snapshot = () => [s2];
    t.mirror.sync(B);
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.mirror.list().map((s) => s.id)).toEqual(["s2"]);
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
    send(socket, "session:status", { id: "s1", status: "idle" });
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
    expect(t.mirror.has("s1")).toBe(true);
    expect(t.mirror.has("nope")).toBe(false);
    const caller = sink();
    t.mirror.openTerminal("s1", caller, attach);
    expect(t.terminals).toHaveLength(1);
    expect(t.terminals[0]!.url).toBe(
      "ws://b.test:7777/pty/s1?cols=90&rows=30&clientKind=browser&clientPlatform=linux",
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
    expect(t.mirror.has("s1")).toBe(true); // still shown, as disconnected
    const offline = sink();
    t.mirror.openTerminal("s1", offline, attach);
    expect(offline.closes).toEqual([4002]);
    expect(t.terminals).toEqual([]);
  });

  test("a lost link or a removed machine ends its open terminals", async () => {
    const t = setup();
    const socket = await t.live();
    const first = sink();
    t.mirror.openTerminal("s1", first, attach);
    socket.on.close();
    expect(first.closes).toEqual([4002]);
    expect(t.terminals[0]!.closed).toBe(true);

    await t.live();
    const second = sink();
    t.mirror.openTerminal("s2", second, attach);
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
