import type { Server, ServerWebSocket } from "bun";
import type { SessionPreviewState } from "./types";

// ── dev-port detection primitives ─────────────────────────────────────────────
//
// Task 2: primary-port selection for agent preview detection.
// Preview listener lifecycle, slot allocation, poller sweep, and UI are later tasks.

/**
 * Priority-ordered curated list of well-known frontend/full-stack dev-server ports.
 * List-order is the selection priority — NOT numeric order.
 * Curated ports are trusted HTTP servers; they are NEVER probed via HTTP.
 */
// fallow-ignore-next-line unused-export
export const CURATED_PORTS: readonly number[] = [5173, 5174, 4321, 4173, 3000, 8000, 8080];

const CURATED_SET = new Set<number>(CURATED_PORTS);

/**
 * HTTP liveness probe: returns true when a plain HTTP GET/HEAD to 127.0.0.1:<port>
 * yields any well-formed HTTP response within ~500 ms.
 *
 * This ensures non-HTTP sockets (debugger 9229, DB ports, etc.) are never surfaced.
 * Injectable for tests (pass a custom probe to avoid real network calls).
 */
// fallow-ignore-next-line unused-export
export async function defaultHttpProbe(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      signal: controller.signal,
    });
    // Any well-formed HTTP response counts — even 4xx/5xx confirms an HTTP server.
    return typeof res.status === "number";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the primary dev-server port from a set of listening ports, using this rule:
 *
 * 1. If any port from the curated list is present, return the one that appears FIRST
 *    in CURATED_PORTS (list-order priority, NOT numeric). No HTTP probe for curated ports.
 * 2. Otherwise, among non-curated ports, return the numerically LOWEST that passes
 *    the HTTP liveness probe.
 * 3. If nothing answers → null.
 *
 * @param ports      Listening ports detected in the worktree (any order).
 * @param httpProbe  Injectable probe; defaults to real network call.
 */
export async function pickPrimaryPort(
  ports: number[],
  httpProbe: (port: number) => Promise<boolean> = defaultHttpProbe,
): Promise<number | null> {
  if (ports.length === 0) return null;

  // Step 1: curated-first by list order.
  for (const candidate of CURATED_PORTS) {
    if (ports.includes(candidate)) return candidate;
  }

  // Step 2: non-curated fallback — numerically lowest HTTP-answering port.
  const nonCurated = ports.filter((p) => !CURATED_SET.has(p)).sort((a, b) => a - b);
  for (const port of nonCurated) {
    if (await httpProbe(port)) return port;
  }

  return null;
}

// ── PreviewService: per-session reverse-proxy listeners ───────────────────────
//
// Each active session gets a stable loopback `Bun.serve` listener on a slot from
// the configured preview-port range. The listener reverse-proxies HTTP **and**
// relays WebSocket frames to the session's CURRENT dev port (read live, so a
// devPort change needs no rebind). The proxy target is ALWAYS the session's own
// dev port — never derived from the request path/host/query (no SSRF surface).
//
// Lifecycle: detect-and-proxy only. Shepherd never owns the dev-server process;
// it binds a listener when a dev port appears and tears it down when the session
// is gone (release) or absent from a converge set.

/** Hop-by-hop headers (RFC 7230 §6.1) plus `host`, dropped before forwarding. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Per-WS-connection relay state attached via `server.upgrade(req, { data })`. */
interface RelayData {
  devPort: number;
  /** Path + query to dial on the upstream (e.g. "/?token=…"). */
  path: string;
  /** Requested subprotocols, forwarded to the upstream client socket. */
  protocols: string[];
}

/** Bound listener record: the running server + the live (mutable) dev port. */
interface Listener {
  previewPort: number;
  devPort: number;
  server: Server<RelayData>;
}

export interface PreviewServiceOptions {
  /** Preview-port range base (config.previewPortBase). */
  base: number;
  /** Range size AND max concurrent previews (config.previewPortCount). */
  count: number;
  /** Fired ONLY on a real previewPort transition: null→port (first bind) and
   *  port→null (release). NOT fired when only the devPort changes. */
  onChange?: (sessionId: string, previewPort: number | null) => void;
}

export class PreviewService {
  private readonly base: number;
  private readonly count: number;
  private readonly onChange?: (sessionId: string, previewPort: number | null) => void;

  /** sessionId → bound listener. */
  private readonly listeners = new Map<string, Listener>();
  /** previewPort → sessionId, so a freed slot is reclaimable. */
  private readonly slotOwner = new Map<number, string>();

  constructor(opts: PreviewServiceOptions) {
    this.base = opts.base;
    this.count = opts.count;
    this.onChange = opts.onChange;
  }

  /**
   * Ensure a listener exists for `sessionId` proxying to `devPort`.
   *
   * - Already bound → UPDATE the stored devPort live (no rebind, no onChange);
   *   returns the existing preview port.
   * - Not bound → allocate a free slot, bind a loopback `Bun.serve`, fire
   *   `onChange(sessionId, previewPort)`, return the port.
   * - Range exhausted → log + return null (never throws).
   * - Bind error on a slot → try the next free slot; null if all fail.
   */
  ensure(sessionId: string, devPort: number): number | null {
    const existing = this.listeners.get(sessionId);
    if (existing) {
      existing.devPort = devPort; // live target update — the fetch/relay read this
      return existing.previewPort;
    }

    const candidates = this.freeSlots();
    if (candidates.length === 0) {
      console.warn(
        `[preview] port range [${this.base}, ${this.base + this.count}) exhausted ` +
          `(${this.count} concurrent previews) — no slot for session ${sessionId}`,
      );
      return null;
    }

    for (const previewPort of candidates) {
      const listener: Listener = {
        previewPort,
        devPort,
        server: undefined as unknown as Server<RelayData>,
      };
      try {
        listener.server = this.bind(listener);
      } catch (err) {
        console.warn(`[preview] failed to bind ${previewPort} for ${sessionId}: ${String(err)}`);
        continue; // try the next free slot
      }
      this.listeners.set(sessionId, listener);
      this.slotOwner.set(previewPort, sessionId);
      try {
        this.onChange?.(sessionId, previewPort);
      } catch {
        /* observer side-effect must not break allocation */
      }
      return previewPort;
    }

    console.warn(`[preview] all free slots failed to bind for session ${sessionId}`);
    return null;
  }

  /** Tear down a session's listener and reclaim its slot. Idempotent. */
  release(sessionId: string): void {
    const listener = this.listeners.get(sessionId);
    if (!listener) return;
    this.listeners.delete(sessionId);
    this.slotOwner.delete(listener.previewPort);
    try {
      listener.server.stop(true);
    } catch {
      /* already gone */
    }
    try {
      this.onChange?.(sessionId, null);
    } catch {
      /* observer side-effect must not break teardown */
    }
  }

  /** Reconcile to `active`: ensure each entry, release any bound session absent from it. */
  converge(active: Array<{ sessionId: string; devPort: number }>): void {
    const wanted = new Set(active.map((a) => a.sessionId));
    for (const sessionId of [...this.listeners.keys()]) {
      if (!wanted.has(sessionId)) this.release(sessionId);
    }
    for (const { sessionId, devPort } of active) this.ensure(sessionId, devPort);
  }

  /** Live preview snapshot for client bootstrap: bound sessions only. */
  snapshot(): Record<string, SessionPreviewState> {
    const out: Record<string, SessionPreviewState> = {};
    for (const [sessionId, listener] of this.listeners) {
      out[sessionId] = { previewPort: listener.previewPort };
    }
    return out;
  }

  /** Stop every listener (shutdown / tests). Does NOT fire onChange. */
  stopAll(): void {
    for (const listener of this.listeners.values()) {
      try {
        listener.server.stop(true);
      } catch {
        /* already gone */
      }
    }
    this.listeners.clear();
    this.slotOwner.clear();
  }

  /** Free ports in the range, in ascending order. */
  private freeSlots(): number[] {
    const free: number[] = [];
    for (let port = this.base; port < this.base + this.count; port++) {
      if (!this.slotOwner.has(port)) free.push(port);
    }
    return free;
  }

  /** Bind the loopback reverse-proxy `Bun.serve` for one listener record. */
  private bind(listener: Listener): Server<RelayData> {
    return Bun.serve<RelayData>({
      port: listener.previewPort,
      hostname: "127.0.0.1",
      fetch: (req, server) => this.handleFetch(req, server, listener),
      websocket: makeRelayHandlers(),
    });
  }

  /** HTTP request handler: WS upgrades go to the relay; everything else proxies. */
  private handleFetch(
    req: Request,
    server: Server<RelayData>,
    listener: Listener,
  ): Response | Promise<Response> | undefined {
    const devPort = listener.devPort; // live read — re-ensure may have updated it
    if (isWebSocketUpgrade(req)) {
      const url = new URL(req.url);
      const protocols = parseSubprotocols(req.headers.get("sec-websocket-protocol"));
      const upgraded = server.upgrade(req, {
        data: { devPort, path: url.pathname + url.search, protocols },
        // Echo the client's first requested subprotocol so subprotocol-sensitive
        // clients (Vite HMR) are satisfied by the upgrade response.
        headers: protocols[0] ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 426 });
    }
    return proxyHttp(req, devPort);
  }
}

/** True when the request is a WebSocket upgrade (case-insensitive `Upgrade: websocket`). */
function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/** Split a `Sec-WebSocket-Protocol` header into trimmed, non-empty subprotocols. */
function parseSubprotocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reverse-proxy a plain HTTP request to `127.0.0.1:<devPort>` with the same path,
 * query, method, headers (minus host + hop-by-hop) and a streamed body. Strips
 * framing-blocking response headers. Fails closed with a 502 if upstream throws.
 */
async function proxyHttp(req: Request, devPort: number): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://127.0.0.1:${devPort}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);

  const hasBody = req.body !== null && req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      // Streaming a request body through Bun's fetch requires half-duplex.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch {
    // Dev server gone / refused — fail closed, never a silent empty 200.
    return new Response("Preview upstream unavailable", { status: 502 });
  }

  const respHeaders = new Headers(upstream.headers);
  stripFramingHeaders(respHeaders);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

/** Delete `X-Frame-Options`; remove only the `frame-ancestors` directive from CSP. */
function stripFramingHeaders(headers: Headers): void {
  headers.delete("x-frame-options");
  const csp = headers.get("content-security-policy");
  if (csp === null) return;
  const kept = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/i.test(d));
  if (kept.length === 0) headers.delete("content-security-policy");
  else headers.set("content-security-policy", kept.join("; "));
}

// ── WebSocket relay ───────────────────────────────────────────────────────────
//
// Bun.serve does NOT auto-proxy an upstream socket. We accept the client WS, open
// a `new WebSocket` CLIENT to the upstream dev port, and relay frames both ways.
// Client→upstream frames that arrive before the upstream opens are buffered and
// flushed on upstream open.

/** Mutable per-socket relay context, stashed on the ServerWebSocket. */
interface RelayContext {
  upstream: WebSocket | null;
  upstreamOpen: boolean;
  /** client→upstream frames buffered until the upstream socket opens. */
  pending: Array<string | ArrayBufferLike | Uint8Array>;
  /** true once either side initiated a close, so handlers stop relaying. */
  closing: boolean;
}

/** WS client→server messages are typed loosely; this is the relay's view of one socket. */
type RelaySocket = ServerWebSocket<RelayData> & { __relay?: RelayContext };

function makeRelayHandlers() {
  return {
    open(ws: RelaySocket) {
      const ctx: RelayContext = {
        upstream: null,
        upstreamOpen: false,
        pending: [],
        closing: false,
      };
      ws.__relay = ctx;
      const { devPort, path, protocols } = ws.data;
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(
          `ws://127.0.0.1:${devPort}${path}`,
          protocols.length > 0 ? protocols : undefined,
        );
      } catch {
        safeClose(ws);
        return;
      }
      upstream.binaryType = "arraybuffer";
      ctx.upstream = upstream;

      upstream.onopen = () => {
        ctx.upstreamOpen = true;
        for (const frame of ctx.pending.splice(0)) safeSend(upstream, frame);
      };
      upstream.onmessage = (e: MessageEvent) => safeSend(ws, e.data);
      upstream.onclose = (e: CloseEvent) => {
        ctx.closing = true;
        safeClose(ws, e.code, e.reason);
      };
      upstream.onerror = () => safeClose(ws);
    },

    message(ws: RelaySocket, msg: string | Buffer) {
      const ctx = ws.__relay;
      if (!ctx || ctx.closing) return;
      const frame = typeof msg === "string" ? msg : new Uint8Array(msg);
      if (ctx.upstream && ctx.upstreamOpen) safeSend(ctx.upstream, frame);
      else ctx.pending.push(frame);
    },

    close(ws: RelaySocket, code: number, reason: string) {
      const ctx = ws.__relay;
      if (!ctx) return;
      ctx.closing = true;
      if (ctx.upstream) safeClose(ctx.upstream, code, reason);
    },
  };
}

/** A WebSocket close code the client/upstream WS API will accept without throwing:
 *  1000 (normal) or the application range 3000–4999. Reserved/abnormal codes
 *  (1005/1006/1011/…) are mapped to a safe no-arg close. */
function sanitizeCloseCode(code: number | undefined): number | null {
  if (code === undefined) return null;
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return null; // reserved/abnormal → safe no-arg close
}

/** Send on either peer; the socket may already be gone, so swallow throws. */
function safeSend(
  sock: WebSocket | ServerWebSocket<RelayData>,
  data: string | ArrayBufferLike | Uint8Array | Blob,
): void {
  try {
    // Both Bun's ServerWebSocket and the client WebSocket expose `.send`.
    (sock as { send: (d: unknown) => void }).send(data);
  } catch {
    /* peer gone */
  }
}

/** Close either peer with a sanitized code (preserving reason when present). */
function safeClose(
  sock: WebSocket | ServerWebSocket<RelayData>,
  code?: number,
  reason?: string,
): void {
  const safe = sanitizeCloseCode(code);
  try {
    if (safe === null) (sock as { close: (c?: number, r?: string) => void }).close();
    else (sock as { close: (c?: number, r?: string) => void }).close(safe, reason || undefined);
  } catch {
    /* peer gone */
  }
}
