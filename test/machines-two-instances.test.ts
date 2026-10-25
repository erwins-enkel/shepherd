import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SESSION_COOKIE, signCookie } from "../src/operator-auth";
import type { Capability } from "../src/remote-instances/capabilities";

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
// The tests are steps of ONE scenario and run in order on the same two processes. The second block
// (#2777, the acceptance of epic #2778) continues it with the automatic choice: M reports macOS
// with Xcode, C Linux without, each from a capability file the test can change, and a stand-in for
// the model that reads requirements from a description gives both the same fixed answers.

const FIXTURE = new URL("./fixtures/machine-node.ts", import.meta.url).pathname;
const FAKE_HERDR = new URL("./fixtures/fake-herdr-echo.mjs", import.meta.url).pathname;
const STEP_TIMEOUT_MS = 30_000;
const LINUX: Capability[] = ["platform:linux", "agent:claude"];
const MAC: Capability[] = ["platform:macos", "xcode", "sdk:macos", "agent:claude"];

interface Node {
  name: string;
  root: string;
  checkout: string;
  secret: string;
  herdrBin: string | null;
  platform: "linux" | "macos";
  proc: Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  token: string;
  instanceId: string;
  /** Everything the process wrote to stderr — shown when it fails to come up. */
  stderr: string[];
  /** Everything it wrote to stdout, its log lines included. */
  stdout: string[];
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
  spec: Pick<Node, "name" | "root" | "checkout" | "secret" | "herdrBin" | "platform">,
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
    MACHINE_NODE_PLATFORM: spec.platform,
  };
  if (spec.herdrBin) env.HERDR_BIN = spec.herdrBin;
  const proc = Bun.spawn([process.execPath, FIXTURE], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr: string[] = [];
  const stdout: string[] = [];
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
        const text = new TextDecoder().decode(chunk);
        stdout.push(text);
        out += text;
        const line = /MACHINE-NODE-READY (\{.*\})/.exec(out);
        if (line && !ready) {
          ready = true;
          clearTimeout(timer);
          const info = JSON.parse(line[1]!) as Pick<Node, "port" | "token" | "instanceId">;
          resolve({ ...spec, proc, stderr, stdout, ...info });
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

function nodeSpec(
  name: string,
  herdrBin: string | null,
  platform: Node["platform"],
  capabilities: Capability[],
) {
  const root = join(base, name);
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const spec = { name, root, checkout: join(root, "app"), secret: `${name}-cookie-secret` };
  setCapabilities(spec, capabilities);
  return { ...spec, herdrBin, platform };
}

/** What `node`'s capability probe finds from now on (the fixture re-reads it on every check). */
function setCapabilities(node: Pick<Node, "root">, capabilities: Capability[]): void {
  writeFileSync(join(node.root, "capabilities.json"), JSON.stringify(capabilities));
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

/** The Shepherds mirroring `node` right now, as Settings → Machines lists them (#3056). */
async function incoming(node: Node): Promise<Json[]> {
  const res = await api(node, "GET", "/api/remote-instances", { operator: true });
  expect(res.status).toBe(200);
  return res.body.incoming as Json[];
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

/** Hand-offs from `node` that no machine has confirmed yet — what its herd shows as "start status
 *  unknown", and tasks waiting there for their machine. */
async function unconfirmed(node: Node): Promise<Json[]> {
  const res = await api(node, "GET", "/api/remote-dispatches");
  expect(res.status).toBe(200);
  return res.body.dispatches as Json[];
}

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
  m = await spawnNode(nodeSpec("mac", FAKE_HERDR, "macos", MAC), 0);
  c = await spawnNode(nodeSpec("linux", null, "linux", LINUX), 0);
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

      // Who mirrors whom (#3056): only C connected M, so M lists C as mirroring it in one
      // direction, under the name C gives and the name of M's token it uses.
      const onM = await until(
        () => incoming(m),
        (l) => l.length > 0,
      );
      expect(onM).toEqual([
        {
          instanceId: c.instanceId,
          name: "linux",
          tokenName: "machines-test",
          since: expect.any(Number),
          direction: "one",
        },
      ]);
      expect(await incoming(c)).toEqual([]);
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
      // Now both directions (#3056), each side confirming the other's ID with its own probe.
      for (const [self, other, name] of [
        [m, c, "linux"],
        [c, m, "mac"],
      ] as const) {
        const [entry] = await until(
          () => incoming(self),
          (l) => l.length === 1 && l[0]!.direction === "both",
        );
        expect(entry).toMatchObject({ instanceId: other.instanceId, name, direction: "both" });
      }
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
      // Neither side logs a token, whatever its peers claim about themselves. (The fixture's own
      // ready line hands this test its token; it is no log line.)
      for (const node of [c, m]) {
        const log = (node.stdout.join("") + node.stderr.join(""))
          .split("\n")
          .filter((line) => !line.startsWith("MACHINE-NODE-READY"))
          .join("\n");
        expect(log).not.toContain(c.token);
        expect(log).not.toContain(m.token);
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
      // It did arrive and start on M; C lists it as a start whose status is unknown.
      const started = ops(m, "create");
      expect(started).toHaveLength(before + 1);
      expect(started.at(-1)).toMatchObject({ prompt: "port the settings screen" });
      expect(
        (await unconfirmed(c)).map(({ state, host, summary }) => [state, host.instanceId, summary]),
      ).toEqual([["unknown", m.instanceId, "port the settings screen"]]);

      const again = await startOn(c, m, "port the settings screen", "hand-off-1");
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(started.at(-1)!.id);
      expect(again.body.host).toMatchObject({ instanceId: m.instanceId });
      expect(await unconfirmed(c)).toEqual([]);
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
    "coordinator restart: machine, sessions and a lost hand-off survive a crash of C",
    async () => {
      net.failNextCreate();
      const lost = await startOn(c, m, "after a crash", "hand-off-2");
      expect(lost.status).toBe(504);
      const startedOnM = ops(m, "create").at(-1)!;
      expect(startedOnM.prompt).toBe("after a crash");
      expect((await unconfirmed(c)).map((d) => d.state)).toEqual(["unknown"]);
      const creates = ops(m, "create").length;

      await stopNode(c, "SIGKILL");
      const port = c.port;
      c = await spawnNode(c, port);
      expect(c.port).toBe(port);
      // M's own link to C dropped with the crash, and its re-probe may have hit C still booting:
      // Check now on M, so a task M places later does not wait for a C that is already back.
      await until(
        () => api(m, "POST", `/api/remote-instances/${c.instanceId}/check`, { operator: true }),
        (res) => res.body.instance?.status === "connected",
      );

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
      // The restarted C asks M what became of the lost hand-off on its first probe, before any
      // client sends it again: M started it, so it is settled — nothing is sent a second time.
      await until(
        () => unconfirmed(c),
        (l) => l.length === 0,
      );
      expect(ops(m, "create")).toHaveLength(creates);
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

// ── The automatic choice across the two processes (#2777) ─────────────────────────────────────────

/** A New Task on Automatic — no machine named — as the web form sends it (the operator's browser)
 *  or as the native apps do (a token, and the composer's own fields). Both key every submission. */
function submit(
  from: Node,
  prompt: string,
  client: "web" | "native",
  key: string,
  extra: Json = {},
) {
  const native = { agentProvider: "claude", research: false, epicAuthoring: false, plain: false };
  return api(from, "POST", "/api/sessions", {
    json: task(from, prompt, { ...(client === "native" && native), ...extra }),
    key,
    operator: client === "web",
  });
}

/** What New Task shows before a submit: where the task would run, and why. */
const preview = (on: Node, extra: Json = {}) =>
  api(on, "POST", "/api/placement", { json: { repoPath: on.checkout, ...extra } });

const derive = (on: Node, prompt: string) =>
  api(on, "POST", "/api/requirements/derive", { json: { repoPath: on.checkout, prompt } });

/** Runs `send` and answers where it started: the machines whose agent got a new task. */
async function landedOn(send: () => Promise<{ status: number; text: string }>): Promise<string[]> {
  const before = [c, m].map((node) => ops(node, "create").length);
  const res = await send();
  expect(res.status, res.text).toBe(201);
  return [c, m].filter((node, i) => ops(node, "create").length > before[i]!).map((n) => n.name);
}

const UNCLEAR = "Passe die App an das neue Logo an";

describe("automatic choice, asking back, waiting and reconnect across two Shepherd processes", () => {
  test(
    "automatic choice: the same task lands on the same machine from either entry, web and native alike",
    async () => {
      let n = 0;
      for (const from of [c, m]) {
        // The checkout has a Package.swift and native/: a task that asks for nothing still runs on
        // Linux, preferred; one that needs Xcode runs on the Mac — from whichever Shepherd.
        for (const [requirements, expected] of [
          [[], c],
          [["xcode"], m],
        ] as [Capability[], Node][]) {
          const extra = requirements.length > 0 ? { requirements } : {};
          const shown = await preview(from, extra);
          expect(shown.body).toMatchObject({
            active: true,
            placement: { target: { instanceId: expected.instanceId } },
          });
          for (const client of ["web", "native"] as const) {
            const prompt = `automatic ${++n}`;
            const where = await landedOn(() => submit(from, prompt, client, `auto-${n}`, extra));
            expect(where, `${client} on ${from.name}`).toEqual([expected.name]);
            // The record of the choice travels with the task: decided where it was submitted.
            expect(ops(expected, "create").at(-1)).toMatchObject({
              prompt,
              placement: {
                mode: "auto",
                target: { instanceId: expected.instanceId },
                requirements,
                basis: requirements.length > 0 ? "requirements" : "preference",
                preferred: requirements.length > 0 ? null : "linux",
                by: { instanceId: from.instanceId },
              },
            });
          }
        }
      }
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "asking back: an unclear description is asked about, and the answer decides the machine",
    async () => {
      for (const from of [c, m]) {
        // Linux and the Mac differ in Xcode, so what a description calls for can change the choice.
        expect((await preview(from)).body.deriveRequirements).toBe(true);
        expect((await derive(from, "Erweitere die native macOS-App")).body).toEqual({
          status: "derived",
          requirements: ["xcode"],
        });
        expect((await derive(from, "Implementiere die Web-Einstellungen")).body).toEqual({
          status: "derived",
          requirements: [],
        });
        expect((await derive(from, UNCLEAR)).body).toEqual({
          status: "unclear",
          options: [["xcode"], []],
        });
        // Each Shepherd reads the description itself; nothing is asked across.
        expect(ops(from, "derive").map((e) => e.prompt)).toEqual([
          "Erweitere die native macOS-App",
          "Implementiere die Web-Einstellungen",
          UNCLEAR,
        ]);
      }

      // The operator's answer becomes the task's requirements, and they decide where it runs.
      let n = 0;
      for (const from of [c, m]) {
        for (const [answer, expected] of [
          [["xcode"], m],
          [[], c],
        ] as [Capability[], Node][]) {
          const extra = answer.length > 0 ? { requirements: answer } : {};
          const where = await landedOn(() => submit(from, UNCLEAR, "web", `answer-${++n}`, extra));
          expect(where).toEqual([expected.name]);
        }
      }

      // A create never reads the description: sent unanswered, it is a task that asks for nothing.
      const derived = ops(c, "derive").length + ops(m, "derive").length;
      expect(await landedOn(() => submit(m, UNCLEAR, "native", "unanswered"))).toEqual([c.name]);
      expect(ops(c, "derive").length + ops(m, "derive").length).toBe(derived);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "start status unknown: an automatic hand-off whose answer is lost is retried where it went, once",
    async () => {
      const xcode = { requirements: ["xcode"] };
      const creates = { c: ops(c, "create").length, m: ops(m, "create").length };
      net.failNextCreate();
      const lost = await submit(c, "build the iOS widget", "native", "auto-lost", xcode);
      expect(lost.status).toBe(504);
      expect(lost.body).toMatchObject({
        code: "remote_dispatch_unknown",
        dispatchId: "auto-lost",
        host: { instanceId: m.instanceId },
      });
      const started = ops(m, "create").at(-1)!;
      expect(started).toMatchObject({
        prompt: "build the iOS widget",
        placement: { mode: "auto", basis: "requirements" },
      });
      expect((await unconfirmed(c)).map((d) => [d.state, d.host.instanceId])).toEqual([
        ["unknown", m.instanceId],
      ]);

      // Linux gains Xcode: the same task would now stay on Linux — but this one went out already.
      setCapabilities(c, [...LINUX, "xcode"]);
      try {
        expect((await preview(c, xcode)).body).toMatchObject({
          placement: { target: { instanceId: c.instanceId } },
        });
        const again = await submit(c, "build the iOS widget", "native", "auto-lost", xcode);
        expect(again.status).toBe(201);
        expect(again.body.id).toBe(started.id);
        expect(again.body.host).toMatchObject({ instanceId: m.instanceId });
        expect(await unconfirmed(c)).toEqual([]);
        expect(ops(m, "create")).toHaveLength(creates.m + 1);
        expect(ops(c, "create")).toHaveLength(creates.c);
      } finally {
        setCapabilities(c, LINUX);
      }
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "waiting: an Xcode task for an unreachable Mac waits, outlives a crash of C and starts there once it is back",
    async () => {
      net.cut();
      await until(
        () => machine(c, m),
        (i) => i?.status === "unreachable",
      );
      const xcode = { requirements: ["xcode"] };
      // New Task says so before a submit: it waits for the Mac, and nothing else fits now.
      expect((await preview(c, xcode)).body).toMatchObject({
        placement: { target: { instanceId: m.instanceId } },
        wait: { alternatives: [] },
      });

      const bytes = "\x89PNG mockup of the macOS menu";
      const form = new FormData();
      form.append("file", new File([bytes], "menu.png", { type: "image/png" }));
      const staged = await api(c, "POST", "/api/uploads", { body: form });
      expect(staged.status).toBe(200);
      const body = { ...xcode, images: [staged.body.path as string] };
      const creates = { c: ops(c, "create").length, m: ops(m, "create").length };

      const res = await submit(c, "build the macOS menu", "web", "wait-1", body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        held: true,
        waiting: true,
        host: { instanceId: m.instanceId },
        dispatch: {
          state: "waiting",
          readiness: { state: "offline" },
          placement: { requirements: ["xcode"], target: { instanceId: m.instanceId } },
        },
      });
      const id = res.body.id as string;
      expect((await submit(c, "build the macOS menu", "web", "wait-1", body)).body).toMatchObject({
        waiting: true,
        id,
      });

      // A machine picked by hand must fit right now: Linux lacks Xcode, the Mac is out of reach.
      const here = await api(c, "POST", `/api/remote-dispatches/${id}/redirect`, {
        json: { target: { instanceId: c.instanceId } },
      });
      expect(here.status).toBe(422);
      expect(here.body).toMatchObject({
        code: "missing_capabilities",
        host: { instanceId: c.instanceId },
        missing: [{ capability: "xcode", reason: "not_installed" }],
      });
      const named = await api(c, "POST", "/api/sessions", {
        json: task(c, "build the macOS menu on Linux", {
          ...xcode,
          target: { instanceId: c.instanceId },
        }),
      });
      // Named here, C checks itself on a fresh probe before anything starts (#2770).
      expect(named.status).toBe(422);
      expect(named.body).toMatchObject({
        code: "missing_capabilities",
        missing: [{ capability: "xcode", reason: "not_installed" }],
      });
      const away = await startOn(c, m, "build the macOS menu over there", "wait-named", xcode);
      expect(away.status).toBe(409);
      expect(away.body.code).toBe("remote_target_unavailable");
      expect((await unconfirmed(c)).map((d) => [d.id, d.state])).toEqual([[id, "waiting"]]);

      // C crashes and comes back while the Mac is still away: the task still waits.
      await stopNode(c, "SIGKILL");
      c = await spawnNode(c, c.port);
      expect((await unconfirmed(c)).map((d) => [d.id, d.state, d.readiness?.state])).toEqual([
        [id, "waiting", "offline"],
      ]);
      expect(ops(m, "create")).toHaveLength(creates.m);

      // The Mac is back. Nobody asks: C's next probe finds it, the Mac checks Xcode right then, and
      // the task goes out — attachment first.
      const seen = agentLog(m).length;
      net.restore();
      await until(
        () => ops(m, "create").length,
        (count) => count === creates.m + 1,
      );
      const since = agentLog(m).slice(seen);
      expect(since.map((e) => e.op)).toEqual(["probe", "verify", "create"]);
      const ran = since.at(-1)!;
      expect(ran).toMatchObject({
        prompt: "build the macOS menu",
        requirements: ["xcode"],
        placement: { requirements: ["xcode"], target: { instanceId: m.instanceId } },
      });
      expect((ran.images as string[]).map((path) => readFileSync(path, "utf8"))).toEqual([bytes]);
      expect((ran.images as string[])[0]!.startsWith(m.root)).toBe(true);

      await until(
        () => unconfirmed(c),
        (l) => l.length === 0,
      );
      const replay = await submit(c, "build the macOS menu", "web", "wait-1", body);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(ran.id);
      expect(ops(m, "create")).toHaveLength(creates.m + 1);
      expect(ops(c, "create")).toHaveLength(creates.c);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "missing Xcode is named: back without it the task is blocked and nothing is sent; with Xcode again it starts",
    async () => {
      net.cut();
      await until(
        () => machine(c, m),
        (i) => i?.status === "unreachable",
      );
      const creates = ops(m, "create").length;
      const res = await submit(c, "archive the macOS build", "native", "blocked-1", {
        requirements: ["xcode"],
      });
      expect(res.body).toMatchObject({ waiting: true });

      // The Mac comes back with only the Command Line Tools: Xcode is missing there now.
      setCapabilities(
        m,
        MAC.filter((cap) => cap !== "xcode"),
      );
      net.restore();
      const [blocked] = await until(
        () => unconfirmed(c),
        (l) => l[0]?.readiness?.state === "missing_capabilities",
      );
      expect(blocked).toMatchObject({
        id: res.body.id,
        state: "waiting",
        readiness: { missing: [{ capability: "xcode", reason: "not_installed" }] },
      });
      // Settings → Machines on C names it too.
      const checks = (await machine(c, m))!.capabilities.checks as Json[];
      expect(checks.find((check) => check.id === "xcode")).toMatchObject({
        ok: false,
        reason: "not_installed",
      });
      expect(ops(m, "create")).toHaveLength(creates);

      // Xcode is back; the next check of the Mac (here: Check now in Settings → Machines) sends it.
      setCapabilities(m, MAC);
      const check = () =>
        api(c, "POST", `/api/remote-instances/${m.instanceId}/check`, { operator: true });
      expect((await check()).status).toBe(200);
      await until(
        () => ops(m, "create").length,
        (count) => count === creates + 1,
      );
      expect(ops(m, "create").at(-1)).toMatchObject({ prompt: "archive the macOS build" });
      await until(
        () => unconfirmed(c),
        (l) => l.length === 0,
      );
      // Settled: another check sends nothing.
      await check();
      await Bun.sleep(100);
      expect(ops(m, "create")).toHaveLength(creates + 1);
    },
    STEP_TIMEOUT_MS,
  );
});
