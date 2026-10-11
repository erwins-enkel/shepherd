import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SESSION_COOKIE, signCookie } from "../src/operator-auth";

// Manual assignment across two machines (#2769), the Phase-1 close of epic #2778: two Shepherd
// servers as two OS processes — coordinator C and machine M — each with its own port, SQLite file,
// repo root, checkout and worktrees (test/fixtures/machine-node.ts). Only the agent is stubbed: its
// starts commit real work in a real worktree, its replies/interrupts/archives are logged per
// machine, and M's terminal is the real PtyBridge + node-pty against a fake herdr echo terminal.
//
// C reaches M only through a TCP proxy owned by this test, which can cut the network, restore it,
// or swallow the answer to one task start (a proxy error page instead of the machine's 201). M also
// connects C directly, so both directions run at once.
//
// The tests are steps of ONE scenario and run in order on the same two processes.

const FIXTURE = new URL("./fixtures/machine-node.ts", import.meta.url).pathname;
const FAKE_HERDR = new URL("./fixtures/fake-herdr-echo.mjs", import.meta.url).pathname;
const STEP_TIMEOUT_MS = 30_000;

interface Node {
  name: string;
  root: string;
  checkout: string;
  secret: string;
  herdrBin: string | null;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  token: string;
  instanceId: string;
  /** Everything the process wrote to stderr — shown when it fails to come up. */
  stderr: string[];
}

type Json = Record<string, any>;

/** The test's own stand-in for the network between C and M. */
class Network {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private down = false;
  private failCreate = false;
  port = 0;

  constructor(private readonly targetPort: () => number) {
    this.server = createServer((client) => this.accept(client));
  }

  listen(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve();
      }),
    );
  }

  /** Every open connection dies at once and new ones are reset until `restore()`. */
  cut(): void {
    this.down = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  restore(): void {
    this.down = false;
  }

  /** The next `POST /api/sessions` reaches the machine, but its answer is swallowed and the
   *  coordinator gets a proxy error page — the task may have started, nobody here knows. */
  failNextCreate(): void {
    this.failCreate = true;
  }

  close(): Promise<void> {
    this.cut();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private accept(client: Socket): void {
    if (this.down) return void client.destroy();
    const upstream = netConnect(this.targetPort(), "127.0.0.1");
    this.sockets.add(client);
    this.sockets.add(upstream);
    let swallow = false;
    let answered = false;
    client.on("data", (chunk: Buffer) => {
      if (this.failCreate && chunk.includes("POST /api/sessions HTTP/1.1")) {
        this.failCreate = false;
        swallow = true;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!swallow) return void client.write(chunk);
      if (answered) return;
      answered = true;
      const page = "<html><body>502 Bad Gateway</body></html>";
      client.end(
        `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/html\r\ncontent-length: ${page.length}\r\nconnection: close\r\n\r\n${page}`,
      );
      upstream.destroy();
    });
    const drop = () => {
      this.sockets.delete(client);
      this.sockets.delete(upstream);
      upstream.destroy();
      // A swallowed answer's page is still being flushed; `end` closes the client after it.
      if (!answered) client.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("close", drop);
      socket.on("error", drop);
    }
  }
}

let base: string;
let c: Node;
let m: Node;
let net: Network;
const sockets: WebSocket[] = [];

function spawnNode(
  spec: Pick<Node, "name" | "root" | "checkout" | "secret" | "herdrBin">,
  port: number,
): Promise<Node> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(spec.root, "home"),
    TMPDIR: join(spec.root, "tmp"),
    SHEPHERD_DB: join(spec.root, "home", "shepherd.db"),
    SHEPHERD_REPO_ROOT: spec.root,
    SHEPHERD_HOST: "127.0.0.1",
    SHEPHERD_COOKIE_SECRET: spec.secret,
    SHEPHERD_HOOKS_INGEST: "0",
    SHEPHERD_HOOKS_SIGNALS: "0",
    DO_NOT_TRACK: "1",
    MACHINE_NODE_ROOT: spec.root,
    MACHINE_NODE_NAME: spec.name,
    MACHINE_NODE_PORT: String(port),
  };
  if (spec.herdrBin) env.HERDR_BIN = spec.herdrBin;
  const proc = Bun.spawn([process.execPath, FIXTURE], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr: string[] = [];
  void (async () => {
    for await (const chunk of proc.stderr) stderr.push(new TextDecoder().decode(chunk));
  })();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${spec.name} did not come up:\n${stderr.join("")}`)),
      20_000,
    );
    // Read stdout to its end so the process never blocks on a full pipe.
    void (async () => {
      let out = "";
      let ready = false;
      for await (const chunk of proc.stdout) {
        out += new TextDecoder().decode(chunk);
        const line = /MACHINE-NODE-READY (\{.*\})/.exec(out);
        if (line && !ready) {
          ready = true;
          clearTimeout(timer);
          const info = JSON.parse(line[1]!) as Pick<Node, "port" | "token" | "instanceId">;
          resolve({ ...spec, proc, stderr, ...info });
        }
      }
    })();
  });
}

async function stopNode(node: Node, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  node.proc.kill(signal);
  const exited = await Promise.race([node.proc.exited, Bun.sleep(5_000).then(() => null)]);
  if (exited === null) {
    node.proc.kill("SIGKILL");
    await node.proc.exited;
  }
}

function nodeSpec(name: string, herdrBin: string | null) {
  const root = join(base, name);
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  return { name, root, checkout: join(root, "app"), secret: `${name}-cookie-secret`, herdrBin };
}

/** An HTTP request to `node` as a client sends it: bearer by default, the operator's signed-in
 *  browser cookie with `operator`. */
async function api(
  node: Node,
  method: string,
  path: string,
  opts: { json?: unknown; body?: BodyInit; key?: string; operator?: boolean } = {},
): Promise<{ status: number; text: string; body: Json }> {
  const headers: Record<string, string> = opts.operator
    ? { cookie: `${SESSION_COOKIE}=${signCookie(node.secret)}` }
    : { authorization: `Bearer ${node.token}` };
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  if (opts.key) headers["idempotency-key"] = opts.key;
  const res = await fetch(`http://127.0.0.1:${node.port}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    /* not JSON — `text` has it */
  }
  return { status: res.status, text, body };
}

async function sessions(node: Node): Promise<Json[]> {
  const res = await api(node, "GET", "/api/sessions");
  expect(res.status).toBe(200);
  return res.body as unknown as Json[];
}

async function machine(on: Node, of: Node): Promise<Json | undefined> {
  const res = await api(on, "GET", "/api/remote-instances", { operator: true });
  return (res.body.instances as Json[]).find((i) => i.instanceId === of.instanceId);
}

/** What the agent stub on `node` was asked to do, in order. */
function agentLog(node: Node): Json[] {
  const file = join(node.root, "agent.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
}

const ops = (node: Node, op: string) => agentLog(node).filter((e) => e.op === op);

async function until<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

/** A New Task body for the project acme/app, from `from`'s checkout. */
function task(from: Node, prompt: string, extra: Json = {}): Json {
  return { repoPath: from.checkout, baseBranch: "main", prompt, ...extra };
}

function startOn(from: Node, to: Node, prompt: string, key: string, extra: Json = {}) {
  return api(from, "POST", "/api/sessions", {
    json: task(from, prompt, { ...extra, target: { instanceId: to.instanceId } }),
    key,
  });
}

/** A terminal on `node` for session `id`, as the web UI opens it. */
function terminal(node: Node, id: string) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${node.port}/pty/${id}?cols=80&rows=24&clientKind=browser&clientPlatform=linux`,
    { headers: { authorization: `Bearer ${node.token}` } } as never,
  );
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  let text = "";
  ws.addEventListener("message", (ev) => {
    text +=
      typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (ev) => resolve(ev.code)),
  );
  return { ws, text: () => text, closed };
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "shepherd-two-machines-"));
  m = await spawnNode(nodeSpec("mac", FAKE_HERDR), 0);
  c = await spawnNode(nodeSpec("linux", null), 0);
  net = new Network(() => m.port);
  await net.listen();
}, STEP_TIMEOUT_MS);

afterAll(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await Promise.all([c, m].filter(Boolean).map((node) => stopNode(node, "SIGTERM")));
  await net?.close();
  rmSync(base, { recursive: true, force: true });
}, STEP_TIMEOUT_MS);

describe("manual assignment across two Shepherd processes", () => {
  /** The session handed to M in step 3; most later steps act on it. */
  let s1: Json;

  test(
    "connect: the operator connects M to C with M's Full token",
    async () => {
      expect(c.proc.pid).not.toBe(m.proc.pid);
      expect(c.instanceId).not.toBe(m.instanceId);
      const res = await api(c, "POST", "/api/remote-instances", {
        operator: true,
        json: { url: `http://127.0.0.1:${net.port}`, token: m.token, label: null },
      });
      expect(res.status).toBe(201);
      expect(res.body.instance).toMatchObject({
        instanceId: m.instanceId,
        name: "mac",
        status: "connected",
      });
      expect(res.body.instance.projects).toContain("acme/app");
      // A token is a bearer token without the operator's session: it can't connect machines.
      const viaToken = await api(c, "POST", "/api/remote-instances", {
        json: { url: `http://127.0.0.1:${net.port}`, token: m.token },
      });
      expect(viaToken.status).toBe(403);
      // The token stays on C's server: never in an answer.
      const listed = await api(c, "GET", "/api/remote-instances", { operator: true });
      expect(res.text + listed.text).not.toContain(m.token);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "mirror: sessions of each side appear on the other, each exactly once",
    async () => {
      // A task started on M itself — by its own operator or automation.
      const local = await api(m, "POST", "/api/sessions", { json: task(m, "started on the mac") });
      expect(local.status).toBe(201);
      const onC = await until(
        () => sessions(c),
        (l) => l.some((s) => s.id === local.body.id),
      );
      expect(onC.find((s) => s.id === local.body.id)).toMatchObject({
        host: { instanceId: m.instanceId, name: "mac" },
        connection: { state: "connected" },
      });

      // The other direction: M connects C and hands C a task.
      const back = await api(m, "POST", "/api/remote-instances", {
        operator: true,
        json: { url: `http://127.0.0.1:${c.port}`, token: c.token },
      });
      expect(back.status).toBe(201);
      const reverse = await startOn(m, c, "built on linux", "reverse-1");
      expect(reverse.status).toBe(201);
      expect(reverse.body.host).toMatchObject({ instanceId: c.instanceId });
      expect(ops(c, "create").map((e) => e.id)).toEqual([reverse.body.id]);
      expect(ops(m, "create").map((e) => e.id)).toEqual([local.body.id]);

      for (const [self, other, id] of [
        [c, m, local.body.id],
        [m, c, reverse.body.id],
      ] as const) {
        const list = await until(
          () => sessions(self),
          (l) => l.some((s) => s.id === id && s.connection?.state === "connected"),
        );
        const ids = list.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(list.filter((s) => s.host?.instanceId === self.instanceId)).toEqual([]);
        expect(list.find((s) => s.id === id)!.host.instanceId).toBe(other.instanceId);
      }
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "idempotent hand-off: a lost answer is retried under its key and starts nothing twice",
    async () => {
      const before = ops(m, "create").length;
      net.failNextCreate();
      const lost = await startOn(c, m, "port the settings screen", "hand-off-1");
      expect(lost.status).toBe(504);
      expect(lost.body).toMatchObject({
        code: "remote_dispatch_unknown",
        dispatchId: "hand-off-1",
        host: { instanceId: m.instanceId },
      });
      // It did arrive and start on M.
      const started = ops(m, "create");
      expect(started).toHaveLength(before + 1);
      expect(started.at(-1)).toMatchObject({ prompt: "port the settings screen" });

      const again = await startOn(c, m, "port the settings screen", "hand-off-1");
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(started.at(-1)!.id);
      expect(again.body.host).toMatchObject({ instanceId: m.instanceId });
      const third = await startOn(c, m, "port the settings screen", "hand-off-1");
      expect(third.body.id).toBe(again.body.id);
      expect(ops(m, "create")).toHaveLength(before + 1);

      const changed = await startOn(c, m, "something else", "hand-off-1");
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe("dispatch_payload_mismatch");
      expect(ops(m, "create")).toHaveLength(before + 1);
      // Nothing of it ran on C.
      expect(ops(c, "create").map((e) => e.prompt)).toEqual(["built on linux"]);

      s1 = (
        await until(
          () => sessions(c),
          (l) => l.some((s) => s.id === again.body.id),
        )
      ).find((s) => s.id === again.body.id)!;
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "attachments: a file staged on C reaches M's own staging before the task starts",
    async () => {
      const bytes = "\x89PNG attachment from linux";
      const form = new FormData();
      form.append("file", new File([bytes], "screen.png", { type: "image/png" }));
      const staged = await api(c, "POST", "/api/uploads", { body: form });
      expect(staged.status).toBe(200);
      const cPath = staged.body.path as string;

      const res = await startOn(c, m, "use the screenshot", "attach-1", { images: [cPath] });
      expect(res.status).toBe(201);
      const images = ops(m, "create").at(-1)!.images as string[];
      expect(images).toHaveLength(1);
      expect(images[0]).not.toBe(cPath);
      expect(images[0]!.startsWith(join(m.root, ".shepherd-uploads-staging"))).toBe(true);
      expect(readFileSync(images[0]!, "utf8")).toBe(bytes);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "terminal: C's /pty bridges to the session's terminal on M",
    async () => {
      const term = terminal(c, s1.id);
      await until(term.text, (t) => t.includes("fake-herdr attached term-"));
      term.ws.send("hello\r");
      await until(term.text, (t) => t.includes("echo: hello"));
      term.ws.close();
      await term.closed;
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "reply and interrupt reach the agent on M, and nothing runs on C",
    async () => {
      const reply = await api(c, "POST", `/api/sessions/${s1.id}/reply`, {
        json: { text: "carry on" },
      });
      expect(reply.status).toBe(200);
      expect(ops(m, "reply")).toEqual([{ op: "reply", id: s1.id, text: "carry on" }]);

      const stop = await api(c, "POST", `/api/sessions/${s1.id}/interrupt`);
      expect(stop.status).toBe(200);
      expect(ops(m, "interrupt")).toEqual([{ op: "interrupt", id: s1.id }]);

      expect(ops(c, "reply")).toEqual([]);
      expect(ops(c, "interrupt")).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "diff: C shows the agent's commit from M's worktree",
    async () => {
      const diff = await api(c, "GET", `/api/sessions/${s1.id}/diff`);
      expect(diff.status).toBe(200);
      expect(diff.body.head).toBe(s1.branch);
      expect((diff.body.files as Json[]).map((f) => f.path)).toEqual([`agent-${s1.name}.txt`]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "network interruption: the session stays, nothing is sent, and it reconnects by itself",
    async () => {
      const open = terminal(c, s1.id);
      await until(open.text, (t) => t.includes("fake-herdr attached"));
      const replies = ops(m, "reply").length;

      net.cut();
      await open.closed;
      const cut = await until(
        () => sessions(c),
        (l) => l.find((s) => s.id === s1.id)?.connection?.state === "disconnected",
      );
      expect(cut.find((s) => s.id === s1.id)!.host.instanceId).toBe(m.instanceId);
      await until(
        () => machine(c, m),
        (i) => i?.status === "unreachable",
      );
      const refused = await api(c, "POST", `/api/sessions/${s1.id}/reply`, {
        json: { text: "while cut" },
      });
      expect(refused.status).toBe(502);
      expect(refused.body.code).toBe("machine_unreachable");
      expect(await terminal(c, s1.id).closed).toBe(4002);
      expect(ops(m, "reply")).toHaveLength(replies);

      net.restore();
      await until(
        () => sessions(c),
        (l) => l.find((s) => s.id === s1.id)?.connection?.state === "connected",
      );
      expect((await machine(c, m))?.status).toBe("connected");
      const reply = await api(c, "POST", `/api/sessions/${s1.id}/reply`, {
        json: { text: "back again" },
      });
      expect(reply.status).toBe(200);
      expect(ops(m, "reply").at(-1)).toEqual({ op: "reply", id: s1.id, text: "back again" });
      const term = terminal(c, s1.id);
      await until(term.text, (t) => t.includes("fake-herdr attached"));
      term.ws.send("again\r");
      await until(term.text, (t) => t.includes("echo: again"));
      term.ws.close();
      await term.closed;
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "coordinator restart: machine, sessions and pending hand-offs survive a crash of C",
    async () => {
      net.failNextCreate();
      const lost = await startOn(c, m, "after a crash", "hand-off-2");
      expect(lost.status).toBe(504);
      const startedOnM = ops(m, "create").at(-1)!;
      expect(startedOnM.prompt).toBe("after a crash");

      await stopNode(c, "SIGKILL");
      const port = c.port;
      c = await spawnNode(c, port);
      expect(c.port).toBe(port);

      await until(
        () => machine(c, m),
        (i) => i?.status === "connected",
      );
      await until(
        () => sessions(c),
        (l) =>
          [s1.id, startedOnM.id].every(
            (id) => l.find((s) => s.id === id)?.connection?.state === "connected",
          ),
      );
      const creates = ops(m, "create").length;
      const retried = await startOn(c, m, "after a crash", "hand-off-2");
      expect(retried.status).toBe(201);
      expect(retried.body.id).toBe(startedOnM.id);
      const first = await startOn(c, m, "port the settings screen", "hand-off-1");
      expect(first.status).toBe(201);
      expect(first.body.id).toBe(s1.id);
      expect(ops(m, "create")).toHaveLength(creates);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "archive: archiving through C archives the session on M",
    async () => {
      const res = await api(c, "DELETE", `/api/sessions/${s1.id}`);
      expect(res.status).toBe(200);
      expect(ops(m, "archive")).toEqual([{ op: "archive", id: s1.id }]);
      expect(ops(c, "archive")).toEqual([]);
      await until(
        () => sessions(c),
        (l) => !l.some((s) => s.id === s1.id),
      );
      expect((await sessions(m)).some((s) => s.id === s1.id)).toBe(false);
    },
    STEP_TIMEOUT_MS,
  );
});
