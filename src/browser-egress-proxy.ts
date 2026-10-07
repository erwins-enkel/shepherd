/**
 * Filtering SOCKS5 proxy for a confined Browser Attach (#2883). Every connection an autonomous
 * session's isolated browser context makes arrives here as a SOCKS CONNECT (Chromium sends the
 * hostname, so DNS happens here, never in the browser); `checkDestination` decides, and allowed
 * tunnels connect to the address that was vetted — no second lookup a rebinding answer could win.
 *
 * Loopback-only listener on an ephemeral port, one per confined attach. No auth: Chromium's SOCKS
 * client has none, and the proxy grants nothing beyond the allowlist. Async sockets only — this
 * runs on the server's single event loop.
 */
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { checkDestination, type LookupFn, type OriginPolicy } from "./browser-origin-policy";

/** Greeting + request never legitimately exceed this; more is a protocol error. */
const MAX_HANDSHAKE_BYTES = 600;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

const VER = 5;
const REP_OK = 0;
const REP_NOT_ALLOWED = 2;
const REP_HOST_UNREACHABLE = 4;
const REP_CMD_UNSUPPORTED = 7;
const REP_ATYP_UNSUPPORTED = 8;

export type SocksParse<T> = { need: true } | { error: number } | ({ consumed: number } & T);

/** Client greeting: `VER NMETHODS METHODS…`; only "no auth" (0) is offered back. */
export function parseSocksGreeting(buf: Buffer): SocksParse<object> {
  if (buf.length < 2) return { need: true };
  if (buf[0] !== VER) return { error: -1 };
  const n = buf[1]!;
  if (buf.length < 2 + n) return { need: true };
  if (!buf.subarray(2, 2 + n).includes(0)) return { error: -1 };
  return { consumed: 2 + n };
}

/** Request: `VER CMD RSV ATYP DST.ADDR DST.PORT`; CONNECT only. */
export function parseSocksRequest(buf: Buffer): SocksParse<{ host: string; port: number }> {
  if (buf.length < 5) return { need: true };
  if (buf[0] !== VER) return { error: -1 };
  if (buf[1] !== 1) return { error: REP_CMD_UNSUPPORTED };
  const atyp = buf[3];
  let host: string;
  let off: number;
  if (atyp === 1) {
    if (buf.length < 10) return { need: true };
    host = [...buf.subarray(4, 8)].join(".");
    off = 8;
  } else if (atyp === 3) {
    const len = buf[4]!;
    if (buf.length < 5 + len + 2) return { need: true };
    host = buf.subarray(5, 5 + len).toString("latin1");
    off = 5 + len;
  } else if (atyp === 4) {
    if (buf.length < 22) return { need: true };
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
    host = parts.join(":");
    off = 20;
  } else {
    return { error: REP_ATYP_UNSUPPORTED };
  }
  return { host, port: buf.readUInt16BE(off), consumed: off + 2 };
}

function reply(rep: number): Buffer {
  return Buffer.from([VER, rep, 0, 1, 0, 0, 0, 0, 0, 0]);
}

export interface BrowserEgressProxyOptions {
  lookup?: LookupFn;
  log?: (msg: string) => void;
}

export class BrowserEgressProxy {
  readonly #server: Server;
  readonly #policy: OriginPolicy;
  readonly #lookup: LookupFn | undefined;
  readonly #log: (msg: string) => void;
  readonly #sockets = new Set<Socket>();
  #closed = false;

  private constructor(server: Server, policy: OriginPolicy, opts: BrowserEgressProxyOptions) {
    this.#server = server;
    this.#policy = policy;
    this.#lookup = opts.lookup;
    this.#log = opts.log ?? ((msg) => console.warn(`[browser-egress] ${msg}`));
  }

  /** Listens on `127.0.0.1:0`; resolves once bound. */
  static start(
    policy: OriginPolicy,
    opts: BrowserEgressProxyOptions = {},
  ): Promise<BrowserEgressProxy> {
    const server = createServer();
    const proxy = new BrowserEgressProxy(server, policy, opts);
    server.on("connection", (socket) => proxy.#accept(socket));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (err) => proxy.#log(`listener error: ${err.message}`));
        resolve(proxy);
      });
    });
  }

  get port(): number {
    const addr = this.#server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  /** The `proxyServer` value for `Target.createBrowserContext`. */
  get url(): string {
    return `socks5://127.0.0.1:${this.port}`;
  }

  /** Stops listening and destroys every tunnel. Idempotent, synchronous. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#server.close();
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
  }

  #track(socket: Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  #accept(client: Socket): void {
    this.#track(client);
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "request" | "busy" = "greeting";
    client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => client.destroy());
    const onData = (chunk: Buffer) => {
      if (stage === "busy") return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_HANDSHAKE_BYTES) {
        client.destroy();
        return;
      }
      if (stage === "greeting") {
        const g = parseSocksGreeting(buf);
        if ("need" in g) return;
        if ("error" in g) {
          client.end(Buffer.from([VER, 0xff]));
          return;
        }
        client.write(Buffer.from([VER, 0]));
        buf = buf.subarray(g.consumed);
        stage = "request";
      }
      const r = parseSocksRequest(buf);
      if ("need" in r) return;
      if ("error" in r) {
        if (r.error < 0) client.destroy();
        else client.end(reply(r.error));
        return;
      }
      stage = "busy";
      client.off("data", onData);
      client.pause();
      void this.#connect(client, r.host, r.port, buf.subarray(r.consumed));
    };
    client.on("data", onData);
  }

  async #connect(client: Socket, host: string, port: number, early: Buffer): Promise<void> {
    const verdict = await checkDestination(this.#policy, host, port, this.#lookup);
    if (client.destroyed) return;
    // Denials stay silent: Chromium's own background fetches would flood the log.
    if (!verdict.allow) {
      client.end(reply(REP_NOT_ALLOWED));
      return;
    }
    const upstream = netConnect({ host: verdict.address, port: verdict.port });
    this.#track(upstream);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
    let connected = false;
    upstream.once("error", () => {
      // Before the tunnel exists the client still expects a SOCKS reply; after, `close` tears down.
      if (!connected && !client.destroyed) client.end(reply(REP_HOST_UNREACHABLE));
    });
    upstream.once("connect", () => {
      connected = true;
      upstream.setTimeout(0);
      client.setTimeout(0);
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write(reply(REP_OK));
      if (early.length > 0) upstream.write(early);
      client.pipe(upstream);
      upstream.pipe(client);
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      client.resume();
    });
  }
}
