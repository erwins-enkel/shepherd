import { join } from "node:path";
import { open, readdir } from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import type { SessionPreviewState } from "./types";

// ── detectDevCommand ──────────────────────────────────────────────────────────

/** Injectable filesystem accessors so tests don't touch the real FS. */
export interface FsAccessors {
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
}

const realFs: FsAccessors = {
  readText: async (p: string) => {
    try {
      const f = Bun.file(p);
      return (await f.exists()) ? await f.text() : null;
    } catch {
      return null;
    }
  },
  exists: async (p: string) => {
    try {
      return await Bun.file(p).exists();
    } catch {
      return false;
    }
  },
  readdir: async (p: string) => {
    try {
      return await readdir(p);
    } catch {
      return [];
    }
  },
};

/** Curated subdir names to scan when root has no `scripts.dev`. */
const CURATED_SUBDIRS = ["ui", "app", "web", "frontend", "client"] as const;

/**
 * Detect the package manager from lockfiles in `dir`, returning null if none found.
 * Call site must supply a fallback (e.g. root dir) before defaulting to "npm".
 */
async function detectPmInDir(
  dir: string,
  fs: FsAccessors,
): Promise<"bun" | "pnpm" | "yarn" | "npm" | null> {
  if (await fs.exists(`${dir}/bun.lock`)) return "bun";
  if (await fs.exists(`${dir}/bun.lockb`)) return "bun";
  if (await fs.exists(`${dir}/pnpm-lock.yaml`)) return "pnpm";
  if (await fs.exists(`${dir}/yarn.lock`)) return "yarn";
  if (await fs.exists(`${dir}/package-lock.json`)) return "npm";
  return null;
}

/**
 * Resolve the package manager for `dir`, falling back to the worktree root lockfile,
 * then to "npm". Canonical monorepos keep the lockfile at the root only.
 */
async function detectPm(
  dir: string,
  root: string,
  fs: FsAccessors,
): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
  return (await detectPmInDir(dir, fs)) ?? (await detectPmInDir(root, fs)) ?? "npm";
}

/** Build the run command for a given package manager. */
function pmDevCmd(pm: "bun" | "pnpm" | "yarn" | "npm"): string {
  return pm === "yarn" ? "yarn dev" : `${pm} run dev`;
}

/** Parse package.json text; return null on failure. */
function parsePkg(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True if pkg has a non-empty `scripts.dev`. */
function hasDev(pkg: Record<string, unknown>): boolean {
  const scripts = pkg["scripts"];
  if (typeof scripts !== "object" || scripts === null) return false;
  const dev = (scripts as Record<string, unknown>)["dev"];
  return typeof dev === "string" && dev.trim().length > 0;
}

/**
 * Resolve the dev-server command for a worktree, using injectable fs accessors.
 *
 * Resolution order:
 * 1. Root package.json with scripts.dev → `<pm> run dev`
 * 2. Exactly one curated/workspace subdir with scripts.dev → `cd <dir> && <pm> run dev`
 * 3. Zero or multiple subdirs → null
 *
 * NEVER uses sync fs operations (hard rule for Shepherd's single Bun event loop).
 */
export async function detectDevCommand(
  worktreePath: string,
  fs: FsAccessors = realFs,
): Promise<string | null> {
  try {
    return await detectDevCommandImpl(worktreePath, fs);
  } catch {
    return null;
  }
}

/**
 * Extract the workspace patterns array from a root package.json object.
 * Supports both array form (["packages/*"]) and npm/yarn-classic object
 * form ({ packages: ["packages/*"] }). Any other shape returns [].
 */
function extractWsPatterns(rootPkg: Record<string, unknown>): string[] {
  const ws = rootPkg["workspaces"];
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === "string");
  if (ws !== null && typeof ws === "object") {
    const pkgs = (ws as Record<string, unknown>)["packages"];
    if (Array.isArray(pkgs)) return pkgs.filter((x): x is string => typeof x === "string");
  }
  return [];
}

/**
 * Expand a single workspace pattern into relative subdir paths.
 * `packages/*` → one-level readdir of `packages/`; exact paths (no `*`) → [pattern].
 * Patterns with `*` other than a trailing `/*` are skipped (unsupported glob).
 */
async function expandWsPattern(
  pattern: string,
  worktreePath: string,
  fs: FsAccessors,
): Promise<string[]> {
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2); // strip "/*"
    const entries = await fs.readdir(`${worktreePath}/${prefix}`);
    return entries.map((entry) => `${prefix}/${entry}`);
  }
  if (!pattern.includes("*")) return [pattern];
  return []; // unsupported glob shape — skip
}

/**
 * Build the full candidate-subdir set (curated + workspace globs) and return only
 * those relative paths whose package.json contains a non-empty `scripts.dev`.
 */
async function collectDevSubdirs(
  worktreePath: string,
  rootPkg: Record<string, unknown>,
  fs: FsAccessors,
): Promise<string[]> {
  const subdirs = new Set<string>(CURATED_SUBDIRS);

  for (const pattern of extractWsPatterns(rootPkg)) {
    for (const rel of await expandWsPattern(pattern, worktreePath, fs)) {
      subdirs.add(rel);
    }
  }

  const matches: string[] = [];
  for (const rel of subdirs) {
    const pkgText = await fs.readText(`${worktreePath}/${rel}/package.json`);
    if (pkgText === null) continue;
    const pkg = parsePkg(pkgText);
    if (pkg !== null && hasDev(pkg)) matches.push(rel);
  }
  return matches;
}

async function detectDevCommandImpl(worktreePath: string, fs: FsAccessors): Promise<string | null> {
  // Step 1: root package.json
  const rootPkgText = await fs.readText(`${worktreePath}/package.json`);
  if (rootPkgText === null) return null;
  const rootPkg = parsePkg(rootPkgText);
  if (rootPkg === null) return null;

  if (hasDev(rootPkg)) {
    const pm = await detectPm(worktreePath, worktreePath, fs);
    return pmDevCmd(pm);
  }

  // Step 2: scan subdirs — curated list + workspace globs; exactly one match wins.
  const matches = await collectDevSubdirs(worktreePath, rootPkg, fs);
  if (matches.length !== 1) return null; // 0 = none, >1 = ambiguous

  const subdir = matches[0];
  const pm = await detectPm(`${worktreePath}/${subdir}`, worktreePath, fs);
  return `cd ${subdir} && ${pmDevCmd(pm)}`;
}

// ── dev-port detection primitives ─────────────────────────────────────────────
//
// Task 2: primary-port selection for agent preview detection.
// Preview listener lifecycle, slot allocation, poller sweep, and UI are later tasks.

/**
 * Priority-ordered curated list of well-known frontend/full-stack dev-server ports.
 * List-order is the selection priority — NOT numeric order.
 * Curated ports are trusted HTTP servers; they are NEVER probed via HTTP.
 */
const CURATED_PORTS: readonly number[] = [5173, 5174, 4321, 4173, 3000, 8000, 8080];

const CURATED_SET = new Set<number>(CURATED_PORTS);

/**
 * HTTP liveness probe: returns true when a plain HTTP GET/HEAD to 127.0.0.1:<port>
 * yields any well-formed HTTP response within ~500 ms.
 *
 * This ensures non-HTTP sockets (debugger 9229, DB ports, etc.) are never surfaced.
 * Injectable for tests (pass a custom probe to avoid real network calls).
 */
async function defaultHttpProbe(port: number): Promise<boolean> {
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

const PREVIEW_HINT_FILE = ".shepherd-preview";

/**
 * Max bytes read from a `.shepherd-preview` file. A valid hint is a short port
 * number (≤5 digits) plus optional surrounding whitespace, so 64 bytes is ample.
 * Capping the read keeps a pathologically large hint file from being slurped into
 * memory on every preview sweep.
 */
const MAX_HINT_BYTES = 64;

/**
 * Default hint reader: reads at most MAX_HINT_BYTES from the file via a file
 * handle, never the whole file. Matches the injectable
 * `(path, enc) => Promise<string>` shape so tests can substitute a plain reader.
 */
async function readHintFileBounded(path: string, enc: "utf8"): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(MAX_HINT_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_HINT_BYTES, 0);
    return buf.toString(enc, 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Read a `.shepherd-preview` hint file from the worktree root.
 *
 * Returns the declared port (integer in [1, 65535]) or null on any failure:
 * missing/unreadable file, empty/whitespace content, content that is not a
 * pure run of decimal digits (e.g. "3000abc", "3000 5173", "3000.5"), NaN,
 * or out-of-range. Never throws.
 *
 * Only the first MAX_HINT_BYTES of the file are read (see `readHintFileBounded`),
 * so the file must put the port number (optionally surrounded by whitespace)
 * within that prefix — no trailing characters, no decimal points, no spaces
 * between digits.
 */
async function readPreviewHint(
  worktreePath: string,
  readFile: (path: string, enc: "utf8") => Promise<string> = readHintFileBounded,
): Promise<number | null> {
  const hintPath = join(worktreePath, PREVIEW_HINT_FILE);
  let text: string;
  try {
    text = await readFile(hintPath, "utf8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  if (port < 1 || port > 65535) return null;
  return port;
}

/**
 * Resolve the active dev port for a worktree, honoring an optional
 * `.shepherd-preview` hint file.
 *
 * Honor rule: the hint is used ONLY when the declared port is in `ports`
 * (confirmed listening) AND passes the HTTP liveness check — the same check
 * `pickPrimaryPort` uses for non-curated ports (curated ports are trusted
 * unprobed). This preserves every invariant from #345:
 *   - never surface a dead port or a port owned by another process/worktree
 *   - never surface a non-HTTP socket (DB port, debugger, etc.)
 *   - the hint's purpose is to disambiguate WHICH live HTTP port wins over
 *     the heuristic for multi-listener apps or apps on uncommon ports
 *
 * Falls through to `pickPrimaryPort` when the hint is absent, unreadable,
 * not in `ports`, or not an HTTP server.
 *
 * @param ports        Listening ports for this worktree (from /proc scan).
 * @param worktreePath Absolute path to the worktree root (hint file location).
 * @param readFile     Injectable file reader (forwarded to readPreviewHint).
 * @param httpProbe    Injectable HTTP liveness probe (default: real network call).
 */
export async function resolveDevPort(
  ports: number[],
  worktreePath: string,
  readFile?: (path: string, enc: "utf8") => Promise<string>,
  httpProbe: (port: number) => Promise<boolean> = defaultHttpProbe,
): Promise<number | null> {
  const hint = await readPreviewHint(worktreePath, readFile);
  if (hint !== null && ports.includes(hint)) {
    // Curated ports are trusted HTTP servers — no probe needed.
    // Non-curated declared ports must still pass the HTTP probe to be surfaced.
    if (CURATED_SET.has(hint) || (await httpProbe(hint))) return hint;
    // Declared port is listening but not an HTTP server (DB/debugger) — the probe just
    // failed. Drop it from the fallback set so pickPrimaryPort doesn't re-probe the same
    // known-dead port (a wasted ~500ms timeout when no curated port is present). The hint
    // is always non-curated here (curated short-circuits above), so removing it is safe.
    return pickPrimaryPort(
      ports.filter((p) => p !== hint),
      httpProbe,
    );
  }
  return pickPrimaryPort(ports, httpProbe);
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

// Hop-by-hop + content-framing headers stripped from the UPSTREAM RESPONSE. Bun's
// fetch transparently DECODES a compressed body but leaves `content-encoding` and the
// original `content-length` in place — forwarding them makes the browser try to decode
// an already-decoded body (ERR_CONTENT_DECODING_FAILED) or truncate at the wrong length.
// So drop both, plus the hop-by-hop headers that mustn't be proxied end-to-end.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
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
  /** Stamp session activity on a relayed frame. */
  touch?: () => void;
}

/** Bound listener record: the running server + the live (mutable) dev port.
 *  `server` is null only for the brief window between record creation and a
 *  successful `bind`; a listener is never stored in the service while null. */
interface Listener {
  previewPort: number;
  devPort: number;
  server: Server<RelayData> | null;
  /** Timestamp (ms) of the last proxied HTTP request or relayed WS frame. Set at
   *  first bind; updated on every HTTP request and relayed WS frame (both directions). */
  lastActivityAt: number;
}

export interface PreviewServiceOptions {
  /** Preview-port range base (config.previewPortBase). */
  base: number;
  /** Range size AND max concurrent previews (config.previewPortCount). */
  count: number;
  /** Fired ONLY on a real previewPort transition: null→port (first bind) and
   *  port→null (release). NOT fired when only the devPort changes. */
  onChange?: (sessionId: string, previewPort: number | null) => void;
  /** Injectable clock for activity timestamps; defaults to Date.now. */
  now?: () => number;
}

export class PreviewService {
  private readonly base: number;
  private readonly count: number;
  private readonly onChange?: (sessionId: string, previewPort: number | null) => void;
  private readonly now: () => number;

  /** sessionId → bound listener. */
  private readonly listeners = new Map<string, Listener>();
  /** previewPort → sessionId, so a freed slot is reclaimable. */
  private readonly slotOwner = new Map<number, string>();

  constructor(opts: PreviewServiceOptions) {
    this.base = opts.base;
    this.count = opts.count;
    this.onChange = opts.onChange;
    this.now = opts.now ?? Date.now;
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
      const listener: Listener = { previewPort, devPort, server: null, lastActivityAt: this.now() };
      try {
        // bind reads listener.devPort live (re-ensure mutates it), so the record
        // must exist first — server is the only field bind fills in.
        listener.server = this.bind(previewPort, listener);
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
    // `stop(true)` is async — the sync try/catch it used to sit in could never have seen its
    // rejection. Attach the handler to the promise so an already-gone server stays a no-op.
    void listener.server?.stop(true).catch(() => {
      /* already gone */
    });
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
      void listener.server?.stop(true).catch(() => {
        /* already gone */
      });
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

  /** Bind the loopback reverse-proxy `Bun.serve` for one listener record.
   *  Takes `previewPort` explicitly + the `listener` whose live `devPort` the
   *  fetch handler reads on every request (re-ensure mutates it in place). */
  private bind(previewPort: number, listener: Listener): Server<RelayData> {
    return Bun.serve<RelayData>({
      port: previewPort,
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
    listener.lastActivityAt = this.now(); // stamp on every HTTP request and WS upgrade
    const devPort = listener.devPort; // live read — re-ensure may have updated it
    if (isWebSocketUpgrade(req)) {
      const url = new URL(req.url);
      const protocols = parseSubprotocols(req.headers.get("sec-websocket-protocol"));
      const upgraded = server.upgrade(req, {
        data: {
          devPort,
          path: url.pathname + url.search,
          protocols,
          touch: () => {
            listener.lastActivityAt = this.now();
          },
        },
        // Deliberately echo NO subprotocol here. Bun commits this 101 synchronously,
        // BEFORE the relay's `open` handler opens the upstream socket and learns which
        // subprotocol it actually negotiated — so echoing the client's first offer could
        // claim one the upstream never selected. Selecting none is spec-valid (RFC 6455
        // §4.1 — the client connection still succeeds) and never mismatches; the upstream
        // still negotiates the client's offered `protocols` on the relay's own socket,
        // and frames relay verbatim regardless of the label.
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 426 });
    }
    return proxyHttp(req, devPort);
  }

  /**
   * Returns the number of milliseconds since the last proxied HTTP request or
   * relayed WS frame for `sessionId`, measured against `now`. Returns `null`
   * when the session is not bound (no listener exists).
   *
   * CALLER CONTRACT: `now` MUST share a time base with the clock this service
   * stamps `lastActivityAt` with (the injectable `now` in PreviewServiceOptions).
   * In production both are `Date.now`, so callers (the poller) just pass their own
   * `Date.now()`. In tests, inject the SAME clock into PreviewService AND pass its
   * value here — mixing a fake service clock with a real `Date.now()` here yields
   * a nonsense delta (a test footgun, not a prod bug).
   */
  idleSince(sessionId: string, now: number): number | null {
    const listener = this.listeners.get(sessionId);
    if (!listener) return null;
    return now - listener.lastActivityAt;
  }

  /**
   * Returns the live dev port that the bound listener for `sessionId` is
   * currently targeting, or `null` when the session is not bound.
   */
  devPortFor(sessionId: string): number | null {
    const listener = this.listeners.get(sessionId);
    if (!listener) return null;
    return listener.devPort;
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
 * content-framing + hop-by-hop + framing-blocking headers from the response (Bun's
 * fetch decodes the body, so a forwarded content-encoding/length would break it).
 * Fails closed with a 502 if upstream throws.
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
  for (const h of STRIPPED_RESPONSE_HEADERS) respHeaders.delete(h);
  stripFramingHeaders(respHeaders);
  rewriteLoopbackLocation(respHeaders, devPort);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

/**
 * Rewrite an upstream redirect whose `Location` points back at the loopback dev server
 * (`http://127.0.0.1:<devPort>/…` or `localhost:<devPort>`) to a PATH-RELATIVE form, so
 * the browser resolves it against the preview origin (`host.ts.net:<previewPort>`) rather
 * than following an unreachable loopback URL. The redirect: "manual" proxy passes Location
 * through verbatim, so a dev server's own absolute self-redirect (trailing-slash, base
 * path, post-login) would otherwise strand the browser. Already-relative Locations and
 * genuinely cross-origin redirects (OAuth providers, CDNs) are left untouched.
 */
export function rewriteLoopbackLocation(headers: Headers, devPort: number): void {
  const loc = headers.get("location");
  if (loc === null) return;
  let u: URL;
  try {
    u = new URL(loc);
  } catch {
    return; // relative Location — already resolves against the preview origin
  }
  const isLoopbackHost = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (isLoopbackHost && u.port === String(devPort)) {
    headers.set("location", u.pathname + u.search + u.hash);
  }
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

/**
 * Cap on bytes buffered client→upstream before the upstream socket opens. The
 * relay carries UNTRUSTED agent apps; a client flooding frames during the open
 * window would otherwise grow the heap without bound. On overflow we fail safe —
 * close both sockets — rather than buffer forever. ~1 MiB.
 */
const MAX_PENDING_WS_BYTES = 1024 * 1024;

/** Byte length of a buffered client→upstream frame (string or binary). */
function frameByteLength(frame: string | ArrayBufferLike | Uint8Array): number {
  if (typeof frame === "string") return Buffer.byteLength(frame);
  if (frame instanceof Uint8Array) return frame.byteLength;
  return frame.byteLength;
}

/** Mutable per-socket relay context, stashed on the ServerWebSocket. */
interface RelayContext {
  upstream: WebSocket | null;
  upstreamOpen: boolean;
  /** client→upstream frames buffered until the upstream socket opens. */
  pending: Array<string | ArrayBufferLike | Uint8Array>;
  /** bytes currently held in `pending`; capped by MAX_PENDING_WS_BYTES. */
  pendingBytes: number;
  /** true once either side initiated a close, so handlers stop relaying. */
  closing: boolean;
}

/** WS client→server messages are typed loosely; this is the relay's view of one socket. */
type RelaySocket = ServerWebSocket<RelayData> & { __relay?: RelayContext };

export function makeRelayHandlers() {
  return {
    open(ws: RelaySocket) {
      const ctx: RelayContext = {
        upstream: null,
        upstreamOpen: false,
        pending: [],
        pendingBytes: 0,
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
        ctx.pendingBytes = 0;
        for (const frame of ctx.pending.splice(0)) safeSend(upstream, frame);
      };
      upstream.onmessage = (e: MessageEvent) => {
        ws.data.touch?.();
        safeSend(ws, e.data);
      };
      upstream.onclose = (e: CloseEvent) => {
        ctx.closing = true;
        safeClose(ws, e.code, e.reason);
      };
      upstream.onerror = () => safeClose(ws);
    },

    message(ws: RelaySocket, msg: string | Buffer) {
      const ctx = ws.__relay;
      if (!ctx || ctx.closing) return;
      ws.data.touch?.();
      const frame = typeof msg === "string" ? msg : new Uint8Array(msg);
      if (ctx.upstream && ctx.upstreamOpen) {
        safeSend(ctx.upstream, frame);
        return;
      }
      // Pre-open buffering: bound the heap. A flooding client (untrusted app)
      // during the open window would otherwise grow `pending` forever → fail safe.
      if (ctx.pendingBytes + frameByteLength(frame) > MAX_PENDING_WS_BYTES) {
        ctx.closing = true;
        if (ctx.upstream) safeClose(ctx.upstream);
        safeClose(ws);
        return;
      }
      ctx.pendingBytes += frameByteLength(frame);
      ctx.pending.push(frame);
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
export function sanitizeCloseCode(code: number | undefined): number | null {
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
