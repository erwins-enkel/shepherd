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

/** `addClient` options. */
export interface CdpClientOptions {
  /**
   * Confine the client to one browser context (#2883, autonomous attach): it may create, see,
   * attach to and drive only that context's targets and cookies, and gets no browser-wide
   * interception. Absent → the unconfined slice-1 client.
   */
  contextId?: string;
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
  /** Confined clients only: the browser context they are limited to. */
  readonly contextId: string | null;
  /** Confined clients only: own-context targets this client has been shown. */
  readonly shownTargets: Set<string>;
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
  | { kind: "internal"; onReply: (msg: Json) => void; onAbort?: (reason: string) => void }
  | {
      kind: "client";
      client: ClientState;
      originalId: number;
      stripSessionId: boolean;
      method: unknown;
      /** `Target.attachToTarget` only: the target and the session it was sent on. */
      attach?: { targetId: string; parent: string };
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
 * CDP domains an agent may use at all — an ALLOWLIST, so a domain Chromium adds or that we
 * overlooked (PWA.launchFilesInApp, Extensions.loadUnpacked, Tracing, SystemInfo, …) is refused by
 * default instead of becoming a host-file read. Sized to what page automation needs (measured
 * against agent-browser 0.32: Target, Page, Runtime, DOM, Network, Input, Emulation,
 * Accessibility, Browser) plus their read-only/in-page siblings.
 */
const ALLOWED_DOMAINS = new Set([
  "Accessibility",
  "Animation",
  "CSS",
  "DOM",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "IO",
  "Input",
  "Inspector",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Runtime",
  "Security",
  "Storage",
  "Target",
]);
/** The Browser domain drives the shared browser process itself: only these window/version reads. */
const ALLOWED_BROWSER_METHODS = new Set([
  "Browser.getVersion",
  "Browser.getWindowForTarget",
  "Browser.getWindowBounds",
  "Browser.setWindowBounds",
  "Browser.setContentsSize",
]);
/**
 * Methods inside allowed domains an agent may never send: they reach the host outside the page
 * sandbox (download paths, host files fed to file inputs) or tunnel past this policy.
 */
const BLOCKED_METHODS = new Set([
  "Page.setDownloadBehavior",
  "DOM.setFileInputFiles",
  "Page.handleFileChooser",
  "Target.exposeDevToolsProtocol",
  // Opens a devtools:// frontend target whose embedder bindings sit outside the page sandbox.
  "Target.openDevTools",
  "Target.setRemoteLocations",
  // Tunnels a nested command to a non-flat session; the policy cannot see inside it.
  "Target.sendMessageToTarget",
]);
/**
 * Session-creating methods allowed only in flat mode: a non-flat session is driven through
 * `Target.sendMessageToTarget`, whose nested command the broker never parses.
 */
const FLAT_ONLY_METHODS = new Set(["Target.attachToTarget", "Target.setAutoAttach"]);

function isAllowedMethod(method: string): boolean {
  const domain = method.slice(0, method.indexOf("."));
  if (domain === "Browser") return ALLOWED_BROWSER_METHODS.has(method);
  return ALLOWED_DOMAINS.has(domain) && !BLOCKED_METHODS.has(method);
}
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

/**
 * Targets an agent may attach to: web content only. devtools://, chrome://, chrome-extension://
 * and file:// targets carry privileged bindings (DevTools embedder, WebUI `chrome.send`) the
 * page-sandbox policy above assumes away. Empty URL = a target still being created.
 */
const WEB_TARGET_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"]);
export function isWebTargetUrl(url: unknown): boolean {
  if (url === "") return true;
  if (typeof url !== "string") return false;
  try {
    return WEB_TARGET_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

const blockedBy = (what: string) => `${what} is blocked by the Shepherd browser broker`;
const webOnly = (method: string) =>
  `${method} is limited to http(s) URLs by the Shepherd browser broker`;

/** One policy check: why `method` with `params` is refused, or null. */
type PolicyRule = (method: string, params: Json) => string | null;

const POLICY_RULES: PolicyRule[] = [
  (method) => (isAllowedMethod(method) ? null : blockedBy(method)),
  (method, params) =>
    FLAT_ONLY_METHODS.has(method) && params.flatten !== true
      ? `${method} requires flatten: true on the Shepherd browser broker`
      : null,
  (method, params) => (URL_METHODS.has(method) && !isWebUrl(params.url) ? webOnly(method) : null),
  // Optional URL rewrite of an intercepted request: only to another web URL.
  (method, params) =>
    method === "Fetch.continueRequest" && params.url !== undefined && !isWebUrl(params.url)
      ? webOnly(method)
      : null,
  // A synthetic drop carrying host file paths is a file upload by another name.
  (method, params) => {
    const files = (params.data as Json | undefined)?.files;
    return method === "Input.dispatchDragEvent" && Array.isArray(files) && files.length > 0
      ? "file drops are blocked by the Shepherd browser broker"
      : null;
  },
  (method, params) =>
    method === "Target.createBrowserContext" && params.proxyServer
      ? `${method} proxy overrides are blocked by the Shepherd browser broker`
      : null,
];

/** Why the broker refuses this client message, or null when it may be forwarded. */
export function cdpPolicyViolation(method: unknown, params: unknown): string | null {
  if (typeof method !== "string") return "a CDP command needs a method name";
  const p = params && typeof params === "object" ? (params as Json) : {};
  for (const rule of POLICY_RULES) {
    const violation = rule(method, p);
    if (violation) return violation;
  }
  return null;
}

/**
 * Confined clients (#2883): on their browser-level session only these domains/methods. Browser-wide
 * `Fetch`/`Network` would see every context's traffic; other `Storage` methods act on the default
 * partition. Page-level work happens on child sessions, which all live in the client's context.
 */
const CONFINED_BROWSER_LEVEL_DOMAINS = new Set(["Target", "Browser"]);
const CONFINED_COOKIE_METHODS = new Set([
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
]);
/** Methods that would escape the context: a new (unproxied) context, another browser session. */
const CONFINED_BLOCKED_METHODS = new Set([
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.attachToBrowserTarget",
]);
const outsideContext = "target is outside this attach's browser context";

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
  /** Every target's current URL, from root-session discovery (broker-only). */
  readonly #targetUrls = new Map<string, string>();
  /** Every target's browser context, from root-session discovery (confined clients). */
  readonly #targetContexts = new Map<string, string>();
  /** Child session → its target and the session that attached it (for broker-side detach). */
  readonly #childTargets = new Map<string, { targetId: string; parent: string }>();
  /** Child sessions the broker detached itself: their detach event is not echoed to clients. */
  readonly #suppressed = new Set<string>();
  #partial: Uint8Array[] = [];
  #nextId = 0;
  #closed = false;

  constructor(opts: CdpPipeOptions) {
    this.#write = opts.write;
    // Root-session discovery feeds #targetUrls, so attaches can be gated on the target's URL.
    this.#sendInternal(
      { method: "Target.setDiscoverTargets", params: { discover: true } },
      () => {},
    );
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

  addClient(sink: CdpClient, opts: CdpClientOptions = {}): CdpPipeClient {
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
      contextId: opts.contextId ?? null,
      shownTargets: new Set(),
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

  /**
   * A broker-internal command on the root session (never visible to clients). Resolves with the
   * result; rejects on a CDP error or when the browser closes first.
   */
  call(method: string, params: Json = {}): Promise<Json> {
    if (this.#closed) return Promise.reject(new Error("browser closed"));
    return new Promise((resolve, reject) => {
      this.#sendInternal(
        { method, params },
        (msg) => {
          const error = msg.error as { message?: unknown } | undefined;
          if (error) reject(new Error(`${method} failed: ${String(error.message)}`));
          else resolve((msg.result as Json | undefined) ?? {});
        },
        (reason) => reject(new Error(reason)),
      );
    });
  }

  /**
   * Ask Chromium to shut down gracefully (broker-internal; clients may not send Browser.close).
   * Only a graceful exit flushes the cookie store, so a recent login survives the restart.
   */
  closeBrowser(): void {
    if (this.#closed) return;
    this.#sendInternal({ method: "Browser.close" }, () => {});
  }

  /** The browser is gone: close every client and forget all routing state. */
  close(reason = "browser closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const clients = [...this.#clients];
    const pending = [...this.#pending.values()];
    this.#clients.clear();
    this.#owners.clear();
    this.#pending.clear();
    for (const p of pending) if (p.kind === "internal") p.onAbort?.(reason);
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
    const violation =
      cdpPolicyViolation(msg.method, msg.params) ?? this.#confinedViolation(client, msg, sessionId);
    const attach = violation ?? this.#attachRequest(client, msg, sessionId);
    if (typeof attach === "string") {
      client.sink.send(
        JSON.stringify({
          id,
          error: { code: BLOCKED_BY_POLICY, message: attach },
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
      ...(attach ? { attach } : {}),
    });
    client.pendingIds.add(pipeId);
    this.#write(
      `${JSON.stringify({ ...msg, id: pipeId, sessionId: sessionId ?? client.browserSession })}\0`,
    );
  }

  /**
   * Confined clients: why `msg` is refused, or null. Rewrites in place what must target the
   * client's own context (`Target.createTarget`, cookie reads/writes).
   */
  #confinedViolation(client: ClientState, msg: Json, sessionId: string | undefined): string | null {
    const contextId = client.contextId;
    if (contextId === null) return null;
    const method = msg.method as string;
    if (CONFINED_BLOCKED_METHODS.has(method))
      return `${method} is blocked for confined attaches by the Shepherd browser broker`;
    const browserLevel = sessionId === undefined || sessionId === client.browserSession;
    const domain = method.slice(0, method.indexOf("."));
    if (
      browserLevel &&
      !CONFINED_BROWSER_LEVEL_DOMAINS.has(domain) &&
      !CONFINED_COOKIE_METHODS.has(method)
    )
      return `${method} is not available at browser level on a confined attach`;
    const params: Json =
      msg.params && typeof msg.params === "object" ? { ...(msg.params as Json) } : {};
    const targetId = stringField(params, "targetId");
    if (targetId !== null && this.#targetContexts.get(targetId) !== contextId)
      return outsideContext;
    if (method === "Target.createTarget" || CONFINED_COOKIE_METHODS.has(method)) {
      params.browserContextId = contextId;
      msg.params = params;
    }
    return null;
  }

  /** Confined clients: true when an event or listed target belongs to another context. */
  #foreignTarget(client: ClientState, info: Json | undefined): boolean {
    if (client.contextId === null) return false;
    const targetId = stringField(info, "targetId");
    const own = stringField(info, "browserContextId") === client.contextId;
    if (own && targetId) client.shownTargets.add(targetId);
    return !own;
  }

  /** Confined clients: drop target events and listings of other contexts. False → drop event. */
  #confinedEvent(client: ClientState, msg: Json): boolean {
    if (client.contextId === null) return true;
    const params = msg.params as Json | undefined;
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        return !this.#foreignTarget(client, params?.targetInfo as Json | undefined);
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const targetId = stringField(params, "targetId");
        if (!targetId || !client.shownTargets.has(targetId)) return false;
        if (msg.method === "Target.targetDestroyed") client.shownTargets.delete(targetId);
        return true;
      }
      default:
        return true;
    }
  }

  /** Confined clients: strip other contexts' targets from a `Target.getTargets` result. */
  #confinedResponse(client: ClientState, method: unknown, msg: Json): void {
    if (client.contextId === null || method !== "Target.getTargets") return;
    const result = msg.result as Json | undefined;
    const infos = result?.targetInfos;
    if (!Array.isArray(infos)) return;
    msg.result = {
      ...result,
      targetInfos: infos.filter((info) => !this.#foreignTarget(client, info as Json)),
    };
  }

  /** For `Target.attachToTarget`: the attach record, or why it is refused (non-web target). */
  #attachRequest(
    client: ClientState,
    msg: Json,
    sessionId: string | undefined,
  ): { targetId: string; parent: string } | string | null {
    if (msg.method !== "Target.attachToTarget") return null;
    const targetId = stringField(msg.params, "targetId");
    const url = targetId === null ? undefined : this.#targetUrls.get(targetId);
    if (targetId === null || url === undefined) return "unknown target";
    if (!isWebTargetUrl(url))
      return "attaching to non-web targets is blocked by the Shepherd browser broker";
    return { targetId, parent: sessionId ?? client.browserSession! };
  }

  /** Broker-side detach of a child session the client must not drive. */
  #detachChild(child: string, parent: string): void {
    this.#suppressed.add(child);
    this.#sendInternal(
      { method: "Target.detachFromTarget", params: { sessionId: child }, sessionId: parent },
      () => {},
    );
  }

  /** Root discovery events: track URLs; a target that navigated off the web loses its agents. */
  #onRootEvent(msg: Json): void {
    const info = (msg.params as Json | undefined)?.targetInfo as Json | undefined;
    const targetId = stringField(info, "targetId") ?? stringField(msg.params, "targetId");
    if (!targetId) return;
    if (msg.method === "Target.targetDestroyed") {
      this.#targetUrls.delete(targetId);
      this.#targetContexts.delete(targetId);
      return;
    }
    if (msg.method !== "Target.targetCreated" && msg.method !== "Target.targetInfoChanged") return;
    const url = typeof info?.url === "string" ? info.url : "";
    this.#targetUrls.set(targetId, url);
    const contextId = stringField(info, "browserContextId");
    if (contextId) this.#targetContexts.set(targetId, contextId);
    if (isWebTargetUrl(url)) return;
    for (const [child, rec] of this.#childTargets) {
      if (rec.targetId === targetId && this.#owners.has(child)) {
        // Unlike #detachChild the client saw this session: let its detach event through.
        this.#sendInternal(
          {
            method: "Target.detachFromTarget",
            params: { sessionId: child },
            sessionId: rec.parent,
          },
          () => {},
        );
      }
    }
  }

  #sendInternal(msg: Json, onReply: (msg: Json) => void, onAbort?: (reason: string) => void): void {
    const id = ++this.#nextId;
    this.#pending.set(id, { kind: "internal", onReply, ...(onAbort ? { onAbort } : {}) });
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
      if (child) {
        this.#own(client, child);
        if (pending.attach) this.#childTargets.set(child, pending.attach);
      }
    }
    const out: Json = { ...msg, id: pending.originalId };
    if (pending.stripSessionId) delete out.sessionId;
    this.#confinedResponse(client, pending.method, out);
    client.sink.send(JSON.stringify(out));
  }

  #onEvent(msg: Json): void {
    const sessionId = msg.sessionId;
    if (typeof sessionId !== "string") {
      this.#onRootEvent(msg); // root-session events are broker-only
      return;
    }
    const client = this.#owners.get(sessionId);
    if (!client) return;
    if (!this.#trackChild(client, msg, sessionId) || !this.#confinedEvent(client, msg)) return;
    if (sessionId === client.browserSession) {
      const out: Json = { ...msg };
      delete out.sessionId;
      client.sink.send(JSON.stringify(out));
    } else {
      client.sink.send(JSON.stringify(msg));
    }
  }

  /** Child attach/detach bookkeeping for a client event; false → the event is not shown. */
  #trackChild(client: ClientState, msg: Json, sessionId: string): boolean {
    const child = stringField(msg.params, "sessionId");
    if (!child) return true;
    if (msg.method === "Target.attachedToTarget") {
      const info = (msg.params as Json).targetInfo as Json | undefined;
      if (!isWebTargetUrl(info?.url) || this.#foreignTarget(client, info)) {
        // Auto-attach reached a devtools:// / chrome:// target, or (confined) another context's
        // target: never hand it to the client.
        this.#detachChild(child, sessionId);
        return false;
      }
      this.#own(client, child);
      const targetId = stringField(info, "targetId");
      if (targetId) this.#childTargets.set(child, { targetId, parent: sessionId });
    }
    if (msg.method === "Target.detachedFromTarget") {
      this.#disown(client, child);
      this.#childTargets.delete(child);
      if (this.#suppressed.delete(child)) return false;
    }
    return true;
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
    for (const sessionId of client.sessions) {
      this.#owners.delete(sessionId);
      this.#childTargets.delete(sessionId);
    }
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
