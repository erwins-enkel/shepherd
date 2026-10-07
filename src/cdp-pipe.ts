/**
 * CDP multiplexer over Chromium's `--remote-debugging-pipe` (see
 * docs/adr/0001-brokered-cdp-for-shared-browser.md).
 *
 * Chromium speaks NUL-terminated JSON on the pipe. The root pipe session is
 * broker-only: every client (one agent's WebSocket) gets its own browser-level
 * DevTools session via `Target.attachToBrowserTarget`, so per-session Target
 * state (`setAutoAttach`, `setDiscoverTargets`) never leaks between clients.
 * Message ids are rewritten to pipe-unique ids and mapped back; responses and
 * events are routed by session ownership, so clients never see each other's
 * traffic.
 */

/** A WebSocket-like sink to one attached client. */
export interface CdpClient {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** The pipe's handle for one client: feed it the client's messages, detach on disconnect. */
export interface CdpPipeClient {
  receive(text: string): void;
  detach(): void;
  /** Resolves once the client's browser session exists; rejects if it never will. */
  readonly ready: Promise<void>;
}

export interface CdpPipeOptions {
  /** Writes raw bytes to Chromium's fd3. Must not throw. */
  write: (data: string) => void;
}

/** Pre-ready queue bounds per client; exceeding either closes the client with 1009. */
const MAX_QUEUED_MESSAGES = 1000;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

const CLOSE_PROTOCOL_ERROR = 1003;
const CLOSE_TOO_BIG = 1009;
const CLOSE_INTERNAL = 1011;
const SESSION_NOT_OWNED = -32001;

type Json = Record<string, unknown>;

interface ClientState {
  readonly sink: CdpClient;
  browserSession: string | null;
  readonly sessions: Set<string>;
  readonly pendingIds: Set<number>;
  queue: string[];
  queuedBytes: number;
  detached: boolean;
  resolveReady: () => void;
  rejectReady: (err: Error) => void;
}

type Pending =
  | { kind: "internal"; onReply: (msg: Json) => void }
  | {
      kind: "client";
      client: ClientState;
      originalId: number;
      stripSessionId: boolean;
      method: unknown;
    };

function parseObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Methods an agent may never send: they reach the host outside the page sandbox (download
 * paths, host files fed to file inputs, browser-process control, tracing/system info).
 * Without this a membrane-sandboxed agent could write or read host files through Chromium.
 */
const BLOCKED_METHODS = new Set([
  "Browser.setDownloadBehavior",
  "Page.setDownloadBehavior",
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Browser.executeBrowserCommand",
  "DOM.setFileInputFiles",
  "Target.exposeDevToolsProtocol",
  "Target.setRemoteLocations",
]);
const BLOCKED_DOMAINS = ["Tracing.", "SystemInfo."];
/** Methods whose `params.url` must stay on the web (no file:, chrome:, devtools:, …). */
const URL_METHODS = new Set([
  "Page.navigate",
  "Target.createTarget",
  "Network.loadNetworkResource",
]);
const BLOCKED_BY_POLICY = -32000;

function isWebUrl(url: unknown): boolean {
  if (url === "about:blank") return true;
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Why the broker refuses this client message, or null when it may be forwarded. */
export function cdpPolicyViolation(method: unknown, params: unknown): string | null {
  if (typeof method !== "string") return null;
  if (BLOCKED_METHODS.has(method) || BLOCKED_DOMAINS.some((d) => method.startsWith(d)))
    return `${method} is blocked by the Shepherd browser broker`;
  if (URL_METHODS.has(method) && !isWebUrl((params as Json | undefined)?.url))
    return `${method} is limited to http(s) URLs by the Shepherd browser broker`;
  if (method === "Target.createBrowserContext" && (params as Json | undefined)?.proxyServer)
    return "Target.createBrowserContext proxy overrides are blocked by the Shepherd browser broker";
  return null;
}

function stringField(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Json)[key];
  return typeof value === "string" ? value : null;
}

export class CdpPipe {
  readonly #write: (data: string) => void;
  readonly #decoder = new TextDecoder();
  readonly #clients = new Set<ClientState>();
  /** Every attached session (browser-level and child) → the client that owns it. */
  readonly #owners = new Map<string, ClientState>();
  readonly #pending = new Map<number, Pending>();
  #partial: Uint8Array[] = [];
  #nextId = 0;
  #closed = false;

  constructor(opts: CdpPipeOptions) {
    this.#write = opts.write;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Bytes read from Chromium's fd4. Frames may be split or batched arbitrarily. */
  feed(chunk: Uint8Array | string): void {
    if (this.#closed) return;
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    let start = 0;
    let end = bytes.indexOf(0, start);
    while (end !== -1) {
      this.#partial.push(bytes.subarray(start, end));
      const frame = this.#decoder.decode(concatBytes(this.#partial));
      this.#partial = [];
      this.#dispatch(frame);
      if (this.#closed) return;
      start = end + 1;
      end = bytes.indexOf(0, start);
    }
    // Copy: the caller may reuse its read buffer.
    if (start < bytes.length) this.#partial.push(bytes.slice(start));
  }

  addClient(sink: CdpClient): CdpPipeClient {
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Callers need not await `ready`; a rejection must never go unhandled.
    ready.catch(() => {});
    const client: ClientState = {
      sink,
      browserSession: null,
      sessions: new Set(),
      pendingIds: new Set(),
      queue: [],
      queuedBytes: 0,
      detached: false,
      resolveReady,
      rejectReady,
    };
    const handle: CdpPipeClient = {
      receive: (text) => this.#receive(client, text),
      detach: () => this.#detach(client),
      ready,
    };
    if (this.#closed) {
      client.detached = true;
      rejectReady(new Error("browser closed"));
      sink.close(CLOSE_INTERNAL, "browser closed");
      return handle;
    }
    this.#clients.add(client);
    this.#sendInternal({ method: "Target.attachToBrowserTarget" }, (msg) =>
      this.#onAttached(client, msg),
    );
    return handle;
  }

  /** The browser is gone: close every client and forget all routing state. */
  close(reason = "browser closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const clients = [...this.#clients];
    this.#clients.clear();
    this.#owners.clear();
    this.#pending.clear();
    this.#partial = [];
    for (const client of clients) {
      client.detached = true;
      client.queue = [];
      client.rejectReady(new Error(reason));
      client.sink.close(CLOSE_INTERNAL, reason);
    }
  }

  #onAttached(client: ClientState, msg: Json): void {
    const sessionId = stringField(msg.result, "sessionId");
    if (!sessionId) {
      client.rejectReady(new Error("Target.attachToBrowserTarget failed"));
      this.#fail(client, CLOSE_INTERNAL, "browser attach failed");
      return;
    }
    if (client.detached) {
      // Disconnected before the attach resolved: release the session now.
      client.rejectReady(new Error("client detached"));
      this.#sendInternal({ method: "Target.detachFromTarget", params: { sessionId } }, () => {});
      return;
    }
    client.browserSession = sessionId;
    client.sessions.add(sessionId);
    this.#owners.set(sessionId, client);
    const queued = client.queue;
    client.queue = [];
    client.queuedBytes = 0;
    for (const text of queued) {
      if (client.detached) break;
      this.#forward(client, text);
    }
    client.resolveReady();
  }

  #receive(client: ClientState, text: string): void {
    if (client.detached) return;
    if (client.browserSession) {
      this.#forward(client, text);
      return;
    }
    client.queue.push(text);
    client.queuedBytes += Buffer.byteLength(text);
    if (client.queue.length > MAX_QUEUED_MESSAGES || client.queuedBytes > MAX_QUEUED_BYTES)
      this.#fail(client, CLOSE_TOO_BIG, "too many messages before browser attach");
  }

  #forward(client: ClientState, text: string): void {
    const msg = parseObject(text);
    const id = msg?.id;
    const sessionId = msg?.sessionId;
    if (
      !msg ||
      typeof id !== "number" ||
      !Number.isFinite(id) ||
      (sessionId !== undefined && typeof sessionId !== "string")
    ) {
      this.#fail(client, CLOSE_PROTOCOL_ERROR, "invalid CDP message");
      return;
    }
    if (sessionId !== undefined && !client.sessions.has(sessionId)) {
      client.sink.send(
        JSON.stringify({
          id,
          error: { code: SESSION_NOT_OWNED, message: "Session not owned by this client" },
          sessionId,
        }),
      );
      return;
    }
    const violation = cdpPolicyViolation(msg.method, msg.params);
    if (violation) {
      client.sink.send(
        JSON.stringify({
          id,
          error: { code: BLOCKED_BY_POLICY, message: violation },
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
      return;
    }
    const pipeId = ++this.#nextId;
    this.#pending.set(pipeId, {
      kind: "client",
      client,
      originalId: id,
      stripSessionId: sessionId === undefined,
      method: msg.method,
    });
    client.pendingIds.add(pipeId);
    this.#write(
      `${JSON.stringify({ ...msg, id: pipeId, sessionId: sessionId ?? client.browserSession })}\0`,
    );
  }

  #sendInternal(msg: Json, onReply: (msg: Json) => void): void {
    const id = ++this.#nextId;
    this.#pending.set(id, { kind: "internal", onReply });
    this.#write(`${JSON.stringify({ ...msg, id })}\0`);
  }

  #dispatch(frame: string): void {
    const msg = parseObject(frame);
    if (!msg) return;
    if (typeof msg.id === "number") this.#onResponse(msg.id, msg);
    else this.#onEvent(msg);
  }

  #onResponse(id: number, msg: Json): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.kind === "internal") {
      pending.onReply(msg);
      return;
    }
    const { client } = pending;
    client.pendingIds.delete(id);
    if (client.detached) return;
    if (pending.method === "Target.attachToTarget") {
      const child = stringField(msg.result, "sessionId");
      if (child) this.#own(client, child);
    }
    const out: Json = { ...msg, id: pending.originalId };
    if (pending.stripSessionId) delete out.sessionId;
    client.sink.send(JSON.stringify(out));
  }

  #onEvent(msg: Json): void {
    const sessionId = msg.sessionId;
    if (typeof sessionId !== "string") return; // root-session events are broker-only
    const client = this.#owners.get(sessionId);
    if (!client) return;
    const child = stringField(msg.params, "sessionId");
    if (child && msg.method === "Target.attachedToTarget") this.#own(client, child);
    if (child && msg.method === "Target.detachedFromTarget") this.#disown(client, child);
    if (sessionId === client.browserSession) {
      const out: Json = { ...msg };
      delete out.sessionId;
      client.sink.send(JSON.stringify(out));
    } else {
      client.sink.send(JSON.stringify(msg));
    }
  }

  #own(client: ClientState, sessionId: string): void {
    client.sessions.add(sessionId);
    this.#owners.set(sessionId, client);
  }

  #disown(client: ClientState, sessionId: string): void {
    if (this.#owners.get(sessionId) !== client || sessionId === client.browserSession) return;
    client.sessions.delete(sessionId);
    this.#owners.delete(sessionId);
  }

  /** Close the client from our side (protocol violation, overflow, attach failure). */
  #fail(client: ClientState, code: number, reason: string): void {
    if (client.detached) return;
    this.#detach(client);
    client.sink.close(code, reason);
  }

  #detach(client: ClientState): void {
    if (client.detached) return;
    client.detached = true;
    client.queue = [];
    client.queuedBytes = 0;
    this.#clients.delete(client);
    for (const id of client.pendingIds) this.#pending.delete(id);
    client.pendingIds.clear();
    for (const sessionId of client.sessions) this.#owners.delete(sessionId);
    client.sessions.clear();
    const browserSession = client.browserSession;
    if (!browserSession) return; // the pending attach releases its session when it resolves
    client.browserSession = null;
    if (this.#closed) return;
    this.#sendInternal(
      { method: "Target.detachFromTarget", params: { sessionId: browserSession } },
      () => {},
    );
  }
}
