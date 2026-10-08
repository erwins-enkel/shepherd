/**
 * In-netns dev server forwarding for a confined Browser Attach (#2889). An autonomous session's
 * dev server runs inside its slirp4netns namespace, invisible on host loopback. On the first SOCKS
 * CONNECT to `localhost:<devPort>`, Shepherd asks that session's slirp4netns (API socket written by
 * `scripts/egress-runner.sh`) to `add_hostfwd` the dev port to a fresh host `127.0.0.1` port, and
 * the egress proxy tunnels there, so the page keeps the origin `localhost:<devPort>`.
 *
 * The dev port is the session's `.shepherd-preview` hint, accepted only while it is LISTENing
 * inside the netns on an address slirp can reach (any, the tap address, or loopback via the
 * runner's `devfwd` DNAT). The forward dies with the netns; the cache is keyed on the netns pid
 * so a respawned session gets a fresh one. Async I/O only — this runs on the server's event loop.
 */
import { readFile, readlink } from "node:fs/promises";
import { connect as netConnect, createServer } from "node:net";
import { endianness } from "node:os";
import { egressApiSocketPath, egressNetnsPidPath, SLIRP_GUEST_ADDR } from "./egress";
import { readPreviewHint } from "./preview";
import type { SessionStore } from "./store";

const SLIRP_CALL_TIMEOUT_MS = 2_000;
/** slirp answers in one short JSON object; more is a broken peer. */
const MAX_SLIRP_REPLY_BYTES = 64 * 1024;
const ADD_ATTEMPTS = 3;

/** One slirp4netns API request → its parsed JSON reply (`{return}` or `{error}`). */
export type SlirpCall = (socketPath: string, request: object) => Promise<unknown>;

export interface NetnsDevForwarderDeps {
  store: Pick<SessionStore, "get">;
  readHint?: (dir: string) => Promise<number | null>;
  /** Reads a small text file; null when unreadable. */
  readText?: (path: string) => Promise<string | null>;
  /** The network namespace of `pid` (`"self"` = Shepherd's own), e.g. `net:[4026531840]`; null when unreadable. */
  netnsOf?: (pid: number | "self") => Promise<string | null>;
  /** A host `127.0.0.1` port that is free right now. */
  allocPort?: () => Promise<number>;
  slirpCall?: SlirpCall;
  apiSocketPath?: (sessionId: string) => string;
  netnsPidPath?: (sessionId: string) => string;
  log?: (msg: string) => void;
}

interface Forward {
  pid: number;
  devPort: number;
  hostPort: number;
  id: number;
}

/** `/proc/net/tcp` local addresses (hex) slirp hostfwd traffic can reach, per host byte order. */
function reachableV4(): Set<string> {
  const hex = (ip: string) => {
    const b = ip.split(".").map((n) => Number(n).toString(16).padStart(2, "0"));
    return (endianness() === "LE" ? b.reverse() : b).join("").toUpperCase();
  };
  return new Set(["0.0.0.0", "127.0.0.1", SLIRP_GUEST_ADDR].map(hex));
}
const ANY_V6 = "0".repeat(32);

/**
 * True when `/proc/<pid>/net/tcp` (`v4`) or `tcp6` (`v6`) text shows a LISTEN socket on `port`
 * bound to an address slirp hostfwd traffic reaches: `0.0.0.0`, `127.0.0.1`, the tap address, or
 * `::`. A `::1`-only listener does not count.
 */
export function netnsListening(
  text: { v4: string | null; v6: string | null },
  port: number,
): boolean {
  const v4 = reachableV4();
  const check = (body: string | null, ok: (addr: string) => boolean) =>
    (body ?? "")
      .split("\n")
      .slice(1)
      .some((line) => {
        const f = line.trim().split(/\s+/);
        if (f.length < 4 || f[3] !== "0A") return false; // 0A == TCP_LISTEN
        const [addr, portHex] = (f[1] ?? "").split(":");
        return parseInt(portHex ?? "", 16) === port && ok((addr ?? "").toUpperCase());
      });
  return check(text.v4, (a) => v4.has(a)) || check(text.v6, (a) => a === ANY_V6);
}

async function readNetns(pid: number | "self"): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/ns/net`);
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** slirp4netns API client: one request per connection, half-closed after writing (its contract). */
export const slirpApiCall: SlirpCall = (socketPath, request) =>
  new Promise((resolve, reject) => {
    const sock = netConnect({ path: socketPath });
    const chunks: Buffer[] = [];
    let size = 0;
    sock.setTimeout(SLIRP_CALL_TIMEOUT_MS, () => sock.destroy(new Error("slirp API timeout")));
    sock.once("error", reject);
    sock.once("connect", () => sock.end(JSON.stringify(request)));
    sock.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_SLIRP_REPLY_BYTES) sock.destroy(new Error("slirp API reply too large"));
      else chunks.push(c);
    });
    sock.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });

/** The `return` member of a slirp reply, or throws with its `error` description. */
function slirpReturn(reply: unknown): Record<string, unknown> {
  const r = reply as { return?: unknown; error?: { desc?: unknown } } | null;
  if (r && typeof r.return === "object" && r.return !== null)
    return r.return as Record<string, unknown>;
  throw new Error(`slirp API error: ${String(r?.error?.desc ?? "malformed reply")}`);
}

export class NetnsDevForwarder {
  readonly #store: Pick<SessionStore, "get">;
  readonly #readHint: (dir: string) => Promise<number | null>;
  readonly #readText: (path: string) => Promise<string | null>;
  readonly #netnsOf: (pid: number | "self") => Promise<string | null>;
  readonly #allocPort: () => Promise<number>;
  readonly #slirpCall: SlirpCall;
  readonly #apiSocketPath: (sessionId: string) => string;
  readonly #netnsPidPath: (sessionId: string) => string;
  readonly #log: (msg: string) => void;
  readonly #forwards = new Map<string, Forward>();
  readonly #inflight = new Map<string, Promise<number | null>>();

  constructor(deps: NetnsDevForwarderDeps) {
    this.#store = deps.store;
    this.#readHint = deps.readHint ?? ((dir) => readPreviewHint(dir));
    this.#readText = deps.readText ?? readTextFile;
    this.#netnsOf = deps.netnsOf ?? readNetns;
    this.#allocPort = deps.allocPort ?? freeLoopbackPort;
    this.#slirpCall = deps.slirpCall ?? slirpApiCall;
    this.#apiSocketPath = deps.apiSocketPath ?? egressApiSocketPath;
    this.#netnsPidPath = deps.netnsPidPath ?? egressNetnsPidPath;
    this.#log = deps.log ?? ((msg) => console.warn(`[netns-dev-forward] ${msg}`));
  }

  /** The session's verified in-netns dev port, or null (no egress netns, no hint, not listening). */
  async devPort(sessionId: string): Promise<number | null> {
    return (await this.#probe(sessionId))?.devPort ?? null;
  }

  /**
   * The host `127.0.0.1` port that reaches the session's in-netns dev server on `port`, creating
   * the forward on first use; null unless `port` is the session's verified dev port.
   */
  forward(sessionId: string, port: number): Promise<number | null> {
    const pending = this.#inflight.get(sessionId);
    if (pending) return pending.catch(() => null).then(() => this.forward(sessionId, port));
    const run = this.#forward(sessionId, port).finally(() => this.#inflight.delete(sessionId));
    this.#inflight.set(sessionId, run);
    return run;
  }

  /** Forgets the session's forward (archive). slirp dies with the netns, taking the forward along. */
  drop(sessionId: string): void {
    this.#forwards.delete(sessionId);
  }

  async #probe(sessionId: string): Promise<{ pid: number; devPort: number } | null> {
    const s = this.#store.get(sessionId);
    if (!s || s.status === "archived" || !s.egressApplied || !s.isolated) return null;
    const devPort = await this.#readHint(s.worktreePath);
    if (devPort === null) return null;
    const pidText = await this.#readText(this.#netnsPidPath(sessionId));
    const pid = Number(pidText?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // A stale pid file (session stopped) whose pid now belongs to a host process would read the
    // host's own listeners: only a pid in a namespace other than Shepherd's counts.
    const [ns, own] = await Promise.all([this.#netnsOf(pid), this.#netnsOf("self")]);
    if (ns === null || own === null || ns === own) return null;
    const [v4, v6] = await Promise.all([
      this.#readText(`/proc/${pid}/net/tcp`),
      this.#readText(`/proc/${pid}/net/tcp6`),
    ]);
    return netnsListening({ v4, v6 }, devPort) ? { pid, devPort } : null;
  }

  async #forward(sessionId: string, port: number): Promise<number | null> {
    const probe = await this.#probe(sessionId);
    if (!probe || probe.devPort !== port) return null;
    const cached = this.#forwards.get(sessionId);
    if (cached && cached.pid === probe.pid && cached.devPort === probe.devPort)
      return cached.hostPort;
    const socket = this.#apiSocketPath(sessionId);
    this.#forwards.delete(sessionId);
    if (cached && cached.pid === probe.pid)
      await this.#slirpCall(socket, {
        execute: "remove_hostfwd",
        arguments: { id: cached.id },
      }).catch(() => {});
    for (let attempt = 1; attempt <= ADD_ATTEMPTS; attempt++) {
      try {
        const hostPort = await this.#allocPort();
        const ret = slirpReturn(
          await this.#slirpCall(socket, {
            execute: "add_hostfwd",
            arguments: {
              proto: "tcp",
              host_addr: "127.0.0.1",
              host_port: hostPort,
              guest_port: probe.devPort,
            },
          }),
        );
        if (typeof ret.id !== "number") throw new Error("slirp API error: no forward id");
        this.#forwards.set(sessionId, { ...probe, hostPort, id: ret.id });
        return hostPort;
      } catch (err) {
        if (attempt === ADD_ATTEMPTS)
          this.#log(`session ${sessionId}: forwarding dev port ${port} failed: ${String(err)}`);
      }
    }
    return null;
  }
}
