import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { serve, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { AccessTokenService } from "../src/access-tokens";
import { PtyBridge } from "../src/pty-bridge";
import { RemoteInstanceService } from "../src/remote-instances/service";
import { RemoteSessionMirror } from "../src/remote-instances/sessions";
import type { Session } from "../src/types";

// The terminal of a session on a connected machine, opened through the coordinator (#2764): two
// real Shepherd servers in one process, each with its own store, auth gate and access tokens. Only
// the external terminal process on the machine is replaced (PtyBridge open/write); the coordinator,
// the bridge and the machine's own `/pty/:id` handler — auth, takeover, gone — are real.

interface Node {
  deps: AppDeps & {
    accessTokens: AccessTokenService;
    remoteInstances: RemoteInstanceService;
    remoteSessions: RemoteSessionMirror;
  };
  server: ReturnType<typeof serve>;
  base: string;
  ws: string;
  token: string;
}

const nodes: Node[] = [];
const sockets: WebSocket[] = [];
let restore: Partial<typeof config>;
let root: string;
let repo: string;
/** What the machine's terminal process received: the attach size, then every frame written. */
let opens: { cols: number; rows: number }[];
let writes: string[];
let spies: { mockRestore(): void }[];

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-remote-pty-"));
  repo = join(root, "app");
  mkdirSync(repo);
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "remote-pty-test-secret",
    token: null,
    host: "127.0.0.1",
  });
  opens = [];
  writes = [];
  spies = [
    spyOn(PtyBridge.prototype, "open").mockImplementation(function (
      this: PtyBridge,
      cols = 100,
      rows = 30,
    ) {
      opens.push({ cols, rows });
      // The attached terminal paints: bytes from the machine's PTY.
      (this as unknown as { ws: { send(d: Uint8Array): void } }).ws.send(
        new TextEncoder().encode("hi"),
      );
    }),
    spyOn(PtyBridge.prototype, "write").mockImplementation((data: string) => {
      writes.push(data);
    }),
  ];
});

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const node of nodes.splice(0)) {
    node.deps.remoteSessions.stop();
    node.server.stop(true);
  }
  for (const spy of spies) spy.mockRestore();
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
  const accessTokens = new AccessTokenService(store);
  const deps = {
    store,
    events,
    service,
    accessTokens,
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
  const node: Node = {
    deps,
    server,
    base: `http://127.0.0.1:${server.port}`,
    ws: `ws://127.0.0.1:${server.port}`,
    token: accessTokens.mint("machine", null, "full", null).token,
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
    branch: `shepherd/${name}`,
    worktreePath: repo,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `term-${name}`,
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
async function connectWith(from: Node, to: Node, session: Session): Promise<string> {
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
  return result.instance.instanceId;
}

interface Terminal {
  ws: WebSocket;
  output: string[];
  opened: boolean;
  closed: { code: number; reason: string } | null;
}

/** A terminal client: `/pty/:id` on `node` with `token`, like the UI's connectPty. */
function terminal(
  node: Node,
  id: string,
  opts: {
    token?: string;
    client?: [string, string];
    size?: [number, number];
    resume?: boolean;
  } = {},
): Terminal {
  const [clientKind, clientPlatform] = opts.client ?? ["browser", "linux"];
  const [cols, rows] = opts.size ?? [100, 30];
  const ws = new WebSocket(
    `${node.ws}/pty/${id}?cols=${cols}&rows=${rows}&clientKind=${clientKind}&clientPlatform=${clientPlatform}${opts.resume ? "&resume=1" : ""}`,
    { headers: { Authorization: `Bearer ${opts.token ?? node.token}` } } as never,
  );
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const t: Terminal = { ws, output: [], opened: false, closed: null };
  ws.onopen = () => (t.opened = true);
  ws.onmessage = (e) =>
    t.output.push(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  ws.onclose = (e) => (t.closed = { code: e.code, reason: e.reason });
  return t;
}

/** An `/events` dashboard on `node`; returns the latest `terminal:owners` map it received. */
function ownersOn(node: Node, token = node.token): () => Record<string, unknown> | undefined {
  const frames: { event: string; data: { owners: Record<string, unknown> } }[] = [];
  const ws = new WebSocket(`${node.ws}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  } as never);
  sockets.push(ws);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  return () => frames.filter((f) => f.event === "terminal:owners").at(-1)?.data.owners;
}

describe("terminal of a mirrored session through the coordinator", () => {
  test("opens at the caller's size; input and resize reach the machine, its output comes back", async () => {
    const a = startNode();
    const b = startNode();
    const remote = startSession(b, "on-b");
    await connectWith(a, b, remote);

    const t = terminal(a, remote.id, { size: [132, 43] });
    await until(
      () => t.output.join(""),
      (out) => out === "hi",
    );
    expect(opens).toEqual([{ cols: 132, rows: 43 }]);
    t.ws.send("ls\r");
    t.ws.send("\x00resize:90:20\n");
    await until(
      () => writes,
      (w) => w.length === 2,
    );
    expect(writes).toEqual(["ls\r", "\x00resize:90:20\n"]);
    // Nothing of it is local: the coordinator never attached a terminal of its own.
    expect(a.deps.store.get(remote.id)).toBeNull();
    expect(t.closed).toBeNull();
  });

  test("a second client takes over as it would locally, and owners name the machine's holder", async () => {
    const a = startNode();
    const b = startNode();
    const remote = startSession(b, "on-b");
    await connectWith(a, b, remote);
    const owners = ownersOn(a);

    const first = terminal(a, remote.id, { client: ["browser", "linux"] });
    await until(owners, (o) => !!o?.[remote.id]);
    expect(owners()).toEqual({ [remote.id]: { kind: "browser", platform: "linux" } });

    const second = terminal(a, remote.id, { client: ["pwa", "ios"] });
    await until(
      () => first.closed,
      (c) => c !== null,
    );
    expect(first.closed!.code).toBe(4000);
    await until(owners, (o) => (o?.[remote.id] as { kind?: string })?.kind === "pwa");

    // A client directly on the machine supersedes the bridged one in turn.
    const direct = terminal(b, remote.id, { client: ["mac-app", "macos"] });
    await until(
      () => second.closed,
      (c) => c !== null,
    );
    expect(second.closed!.code).toBe(4000);
    await until(owners, (o) => (o?.[remote.id] as { kind?: string })?.kind === "mac-app");
    expect(direct.closed).toBeNull();

    // And the parked client takes it back through the coordinator.
    terminal(a, remote.id, { client: ["browser", "linux"] });
    await until(
      () => direct.closed,
      (c) => c !== null,
    );
    expect(direct.closed!.code).toBe(4000);
  });

  test("a resuming client yields to the machine's holder instead of taking over (#3035)", async () => {
    const a = startNode();
    const b = startNode();
    const remote = startSession(b, "on-b");
    await connectWith(a, b, remote);
    const owners = ownersOn(a);

    const phone = terminal(a, remote.id, { client: ["pwa", "ios"] });
    await until(owners, (o) => (o?.[remote.id] as { kind?: string })?.kind === "pwa");

    // The desktop window paused its stream while hidden and now comes back.
    const desktop = terminal(a, remote.id, { client: ["browser", "macos"], resume: true });
    await until(
      () => desktop.closed,
      (c) => c !== null,
    );
    expect(desktop.closed!.code).toBe(4000);
    expect(phone.closed).toBeNull();
    expect((owners()?.[remote.id] as { kind?: string })?.kind).toBe("pwa");
  });

  test("a session that ended on its machine closes as gone", async () => {
    const a = startNode();
    const b = startNode();
    const remote = startSession(b, "on-b");
    await connectWith(a, b, remote);
    b.deps.store.update(remote.id, { status: "archived" });

    const t = terminal(a, remote.id);
    await until(
      () => t.closed,
      (c) => c !== null,
    );
    expect(t.closed!.code).toBe(4001);
    expect(opens).toEqual([]);
  });

  test("an unreachable machine closes as unreachable; once it is back the terminal opens again", async () => {
    const a = startNode();
    const store = new SessionStore(":memory:");
    const b = startNode(0, store);
    const port = b.server.port;
    const remote = startSession(b, "on-b");
    const bId = await connectWith(a, b, remote);

    b.server.stop(true);
    nodes.splice(nodes.indexOf(b), 1);
    b.deps.remoteSessions.stop();
    await until(
      () => sessions(a),
      (l) => l.find((s) => s.id === remote.id)?.connection?.state === "disconnected",
    );
    const lost = terminal(a, remote.id);
    await until(
      () => lost.closed,
      (c) => c !== null,
    );
    expect(lost.closed).toEqual({ code: 4002, reason: "machine unreachable" });
    expect(opens).toEqual([]);
    // The mirror's recheck probes the dead machine; let it settle first, or the check below joins
    // that in-flight probe and reads its stale "unreachable" (#3299).
    await until(
      () => a.deps.remoteInstances.get(bId)?.status,
      (s) => s === "unreachable",
    );

    // Same machine (same store and identity) back on the same address.
    startNode(port, store);
    await a.deps.remoteInstances.check(bId);
    await until(
      () => sessions(a),
      (l) => l.find((s) => s.id === remote.id)?.connection?.state === "connected",
    );
    const back = terminal(a, remote.id);
    await until(
      () => back.output.join(""),
      (out) => out === "hi",
    );
    expect(back.closed).toBeNull();
  });

  test("read, submit and repository-restricted tokens never reach a mirrored session's terminal", async () => {
    const a = startNode();
    const b = startNode();
    const remote = startSession(b, "on-b");
    await connectWith(a, b, remote);
    const ownersOnB = ownersOn(b);
    await until(ownersOnB, (o) => o !== undefined);

    const mint = (scope: "read" | "submit" | "full", repoPaths: string[] | null = null) =>
      a.deps.accessTokens.mint(scope, null, scope, repoPaths).token;
    const upgrade = (token: string) =>
      fetch(`${a.base}/pty/${remote.id}`, {
        headers: {
          authorization: `Bearer ${token}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
    // The coordinator's own gates answer before any bridge: no escalation through the machine's
    // full token.
    expect((await upgrade(mint("read"))).status).toBe(403);
    expect((await upgrade(mint("submit"))).status).toBe(403);
    expect((await upgrade(mint("full", [repo]))).status).toBe(404);

    for (const token of [mint("read"), mint("submit"), mint("full", [repo])]) {
      const t = terminal(a, remote.id, { token });
      await until(
        () => t.closed,
        (c) => c !== null,
      );
      expect(t.opened).toBe(false);
    }
    // The machine was never asked for a terminal.
    await Bun.sleep(50);
    expect(opens).toEqual([]);
    expect(ownersOnB()).toEqual({});
  });

  test("restricting or revoking the caller's token ends the bridged terminal and frees it on the machine", async () => {
    const a = startNode();
    const b = startNode();
    const remote = startSession(b, "on-b");
    await connectWith(a, b, remote);
    const ownersOnB = ownersOn(b);

    for (const end of ["restrict", "revoke"] as const) {
      const { token, entry } = a.deps.accessTokens.mint("operator", null, "full", null);
      const t = terminal(a, remote.id, { token });
      await until(ownersOnB, (o) => !!o?.[remote.id]);
      if (end === "restrict") a.deps.accessTokens.updateRepositories(entry.id, [repo]);
      else a.deps.accessTokens.revoke(entry.id);
      await until(
        () => t.closed,
        (c) => c !== null,
      );
      expect(t.closed!.code).toBe(1008);
      await until(ownersOnB, (o) => o !== undefined && !o[remote.id]);
    }
  });
});
