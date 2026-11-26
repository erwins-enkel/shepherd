import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import type { PreviewReach, PreviewUnavailable, SessionPreviewState } from "./types";
import { SESSION_COOKIE } from "./operator-auth";

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
 * Never a preview, always an HTTP responder: the Node inspector (9229, and 9230 for a
 * second concurrent inspector) and a Chrome DevTools Protocol endpoint (9222) both answer
 * a plain GET, so the liveness probe alone would let one win the non-curated fallback.
 * Excluded outright rather than probed — proxying a debugger to the operator's browser is
 * never the intent, and the agent scratchpad is full of both.
 */
const EXCLUDED_PORTS = new Set<number>([9222, 9229, 9230]);

/** Inclusive TCP port range. */
export interface PortRange {
  lo: number;
  hi: number;
}

/** Linux's default `ip_local_port_range`, used when the kernel value is unreadable. */
const LINUX_DEFAULT_EPHEMERAL: PortRange = { lo: 32768, hi: 60999 };

/** macOS default (`net.inet.ip.portrange.first/last`, the IANA dynamic range). */
const DARWIN_EPHEMERAL: PortRange = { lo: 49152, hi: 65535 };

/**
 * Parse `/proc/sys/net/ipv4/ip_local_port_range` ("<lo>\t<hi>\n"). Null on anything that
 * is not exactly two in-range integers with lo ≤ hi.
 */
export function parsePortRange(text: string): PortRange | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const [lo, hi] = parts.map((p) => Number.parseInt(p, 10)) as [number, number];
  if (lo < 1 || hi > 65535 || lo > hi) return null;
  return { lo, hi };
}

let ephemeralRangeCache: Promise<PortRange> | null = null;

/**
 * The OS ephemeral port range — where `listen(0)` lands, i.e. test suites' short-lived
 * fake servers. Read once per process (async: the server is a single loop).
 */
function defaultEphemeralRange(): Promise<PortRange> {
  ephemeralRangeCache ??=
    process.platform === "darwin"
      ? Promise.resolve(DARWIN_EPHEMERAL)
      : readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8").then(
          (text) => parsePortRange(text) ?? LINUX_DEFAULT_EPHEMERAL,
          () => LINUX_DEFAULT_EPHEMERAL,
        );
  return ephemeralRangeCache;
}

/**
 * HTTP liveness probe: returns true when a plain HTTP GET/HEAD to 127.0.0.1:<port>
 * yields any well-formed HTTP response within ~500 ms.
 *
 * This ensures non-HTTP sockets (debugger 9229, DB ports, etc.) are never surfaced.
 * Never aimed at an undeclared ephemeral-range port (see `resolveDevPort`): a test
 * suite's fake server can choke on the bodyless HEAD (#3237).
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

/** Upper bound on one whole hint read (open + fstat + read); a slower read is abandoned. */
const HINT_READ_TIMEOUT_MS = 1_000;

/** O_NOFOLLOW: a symlink fails the open (ELOOP). O_NONBLOCK: opening a FIFO returns at once. */
const HINT_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

async function readRegularHint(path: string, enc: "utf8"): Promise<string> {
  const handle = await open(path, HINT_OPEN_FLAGS);
  try {
    // Checked on the opened handle, so the file read is the file checked.
    if (!(await handle.stat()).isFile()) throw new Error("hint is not a regular file");
    const buf = Buffer.alloc(MAX_HINT_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_HINT_BYTES, 0);
    return buf.toString(enc, 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Default hint reader. Guarantees: only a regular file is read (a symlink, FIFO or
 * other special file is rejected and never followed), the open never blocks, at most
 * MAX_HINT_BYTES are read, and the whole operation finishes within
 * HINT_READ_TIMEOUT_MS or throws. Matches the injectable
 * `(path, enc) => Promise<string>` shape so tests can substitute a plain reader.
 */
async function readHintFileBounded(path: string, enc: "utf8"): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("hint read timed out")), HINT_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readRegularHint(path, enc), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a `.shepherd-preview` hint file from a directory.
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
export async function readPreviewHint(
  dir: string,
  readFile: (path: string, enc: "utf8") => Promise<string> = readHintFileBounded,
): Promise<number | null> {
  const hintPath = join(dir, PREVIEW_HINT_FILE);
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
 * First readable, well-formed hint across `hintDirs`, in order. The caller puts the
 * worktree root first, so an agent-declared port there always outranks one found next
 * to a scratchpad-rooted server.
 */
async function firstPreviewHint(
  hintDirs: readonly string[],
  readFile?: (path: string, enc: "utf8") => Promise<string>,
): Promise<number | null> {
  for (const dir of hintDirs) {
    const hint = await readPreviewHint(dir, readFile);
    if (hint !== null) return hint;
  }
  return null;
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
 * not in `ports`, or not an HTTP server. `EXCLUDED_PORTS` are dropped up front, so not
 * even an explicit hint can point the preview at a debugger.
 *
 * The heuristic fallback also skips every port in the OS ephemeral range: those are
 * `listen(0)` servers — typically a test suite's fakes, which a HEAD probe can break
 * (#3237). Only an explicit hint can select one.
 *
 * @param candidates Listening ports for this worktree (from /proc scan).
 * @param hintDirs   Directories to look for `.shepherd-preview` in, most authoritative
 *                   FIRST — the worktree root, then any directory contributed by a
 *                   scratchpad-rooted listener.
 * @param readFile   Injectable file reader (forwarded to readPreviewHint).
 * @param httpProbe  Injectable HTTP liveness probe (default: real network call).
 * @param ephemeralRange Injectable OS ephemeral-range lookup (default: kernel value).
 */
export async function resolveDevPort(
  candidates: number[],
  hintDirs: readonly string[],
  readFile?: (path: string, enc: "utf8") => Promise<string>,
  httpProbe: (port: number) => Promise<boolean> = defaultHttpProbe,
  ephemeralRange: () => Promise<PortRange> = defaultEphemeralRange,
): Promise<number | null> {
  const listening = candidates.filter((p) => !EXCLUDED_PORTS.has(p));
  const hint = await firstPreviewHint(hintDirs, readFile);
  const { lo, hi } = await ephemeralRange();
  // Fallback set for the heuristic: no undeclared ephemeral-range ports. Curated ports are
  // never probed, so they stay even under a custom range that covers them.
  const ports = listening.filter((p) => CURATED_SET.has(p) || p < lo || p > hi);
  if (hint !== null && listening.includes(hint)) {
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
 * `EXCLUDED_PORTS` are dropped before either step.
 *
 * @param candidates Listening ports detected in the worktree (any order).
 * @param httpProbe  Injectable probe; defaults to real network call.
 */
export async function pickPrimaryPort(
  candidates: number[],
  httpProbe: (port: number) => Promise<boolean> = defaultHttpProbe,
): Promise<number | null> {
  const ports = candidates.filter((p) => !EXCLUDED_PORTS.has(p));
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

// ── previewReach: where a session's preview can be opened (#2767) ─────────────

export interface PreviewReachInput {
  /** The session's bound preview slot, or null when no listener is bound. */
  previewPort: number | null;
  /** This node's tailnet host (`config.previewHost`); null when tailscale is unresolved. */
  host: string | null;
  /** `config.previewAutoServe`: Shepherd maps each slot with `tailscale serve` itself. */
  autoServe: boolean;
  /** This slot's `tailscale serve` state; undefined while it has not settled (or is unmanaged). */
  serve: "ok" | "failed" | undefined;
  /** `TailscaleServeService.permissionDenied()`: tailscale refused this user serve config. */
  denied: boolean;
}

/**
 * The URL a device in the tailnet opens a session's preview at, or why there is none. Built by the
 * instance that runs the session, from its own host and slot — the same `https://<host>:<slot>/`
 * the HUD builds locally (`tailscale serve --https` is HTTPS-only). With auto-serve off the operator
 * maps the range by hand, so a bound slot is offered as the local HUD offers it. The two
 * instance-wide reasons (no tailnet host, serve config refused) are reported for an unbound session
 * too, so a caller can explain before a preview is started.
 */
export function previewReach(input: PreviewReachInput): PreviewReach {
  const bound = input.previewPort !== null;
  const none = (unavailable: PreviewUnavailable | null): PreviewReach => ({
    bound,
    url: null,
    unavailable,
  });
  if (input.host === null) return none("not_served");
  if (bound && (input.serve === "ok" || !input.autoServe)) {
    return { bound, url: `https://${input.host}:${input.previewPort}/`, unavailable: null };
  }
  if (input.autoServe && input.denied) return none("serve_denied");
  if (!bound) return none(null);
  return none(input.serve === "failed" ? "serve_failed" : "serve_pending");
}

// ── IPv6 loopback companions ──────────────────────────────────────────────────
//
// Browsers resolve `localhost` to `::1` first. A loopback listener bound to IPv4 only leaves
// `[::1]:<port>` to whichever process binds it, so the HUD and the preview slots also hold
// `[::1]` on the same port when the host has IPv6 loopback.

let loopbackV6Cache: boolean | null = null;

/**
 * True when this host can listen on `::1`. Probed once per process with a port-0 bind: that
 * can't collide with another listener, so a failure means no usable IPv6 loopback.
 */
export function loopbackV6Available(): boolean {
  loopbackV6Cache ??= probeLoopbackV6();
  return loopbackV6Cache;
}

function probeLoopbackV6(): boolean {
  try {
    const s = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response(null) });
    void s.stop(true).catch(() => {
      /* best-effort: probe already gone */
    });
    return true;
  } catch {
    return false;
  }
}

/** True for a bind host whose listener is IPv4 loopback-reachable but not `[::1]`. */
export function needsLoopbackV6(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0";
}

/** `Bun.serve` with `options` on `[::1]:<port>` (overriding `hostname` and `port`). Throws
 *  like `Bun.serve`; call only when `loopbackV6Available()`. */
export function serveLoopbackV6<T>(options: Bun.Serve.Options<T>, port: number): Server<T> {
  // Cast: Bun's options type is a hostname-or-unix union, and a spread over it fits neither member.
  return Bun.serve<T>({ ...options, hostname: "::1", port } as Bun.Serve.Options<T>);
}

/** Stop `server` without awaiting. BOTH guards are load-bearing: `stop(true)` is async, so the
 *  sync try/catch alone could never see its rejection — hence the `.catch`. The try/catch
 *  covers a synchronous throw (or a non-promise return, which makes `.catch` itself throw). */
function stopServerQuietly(server: Server<RelayData>): void {
  try {
    void server.stop(true).catch(() => {
      /* best-effort: server already gone */
    });
  } catch {
    /* best-effort: server already gone */
  }
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
// `clear-site-data` never passes either: cookies are per host, not per port, so an upstream
// value could clear the HUD's state too. `markNavigation` sets the proxy's own scoped value.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "clear-site-data",
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

/** Deadline from request arrival to upstream response headers (queue wait included). */
const PROXY_HEADERS_TIMEOUT_MS = 120_000;

/** Max in-flight upstream fetches per slot; a permit is held until the response body ends. */
const PROXY_SLOT_CONCURRENCY = 16;

/** Max requests waiting FIFO for a permit per slot; a request arriving at a full queue gets 503. */
const PROXY_SLOT_QUEUE = 1024;

/** Resolved per-slot proxy limits (defaults: the PROXY_* constants above). */
interface ProxyLimits {
  headersTimeoutMs: number;
  concurrency: number;
  queue: number;
}

/**
 * FIFO permit gate for one slot's upstream fetches: at most `limit` permits held and at
 * most `maxQueue` waiters. A released permit passes straight to the oldest waiter.
 */
class ProxyGate {
  private readonly limit: number;
  private readonly maxQueue: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number, maxQueue: number) {
    this.limit = limit;
    this.maxQueue = maxQueue;
  }

  /** Resolves true once a permit is held; false if the queue is full or `signal` aborts first
   *  (an aborted waiter leaves the queue). Every true must be paired with one `release()`. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.maxQueue) return Promise.resolve(false);
    return new Promise((resolve) => {
      const admit = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const i = this.waiters.indexOf(admit);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      };
      this.waiters.push(admit);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /** Return a permit: hand it to the oldest waiter, else free it. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

/** Per-WS-connection relay state attached via `server.upgrade(req, { data })`. */
interface RelayData {
  /** Loopback port the relay dials: the listener's upstream port. */
  devPort: number;
  /** Path + query to dial on the upstream (e.g. "/?token=…"). */
  path: string;
  /** Requested subprotocols, forwarded to the upstream client socket. */
  protocols: string[];
  /** Origin the relay sends upstream: `http://localhost:<the listener's dev port>` (not the
   *  dialled upstream port held in `devPort` above) when the client sent an Origin, else null
   *  (no Origin sent). */
  origin: string | null;
  /** Stamp session activity on a relayed frame. */
  touch?: () => void;
}

/** Bound listener record: the running servers + the live (mutable) dev port.
 *  `servers` is empty only for the brief window between record creation and a
 *  successful `bind`; a listener is never stored in the service while empty. */
interface Listener {
  previewPort: number;
  devPort: number;
  /** Loopback port the proxy dials: `devPort`, or the host port an autonomous session's
   *  in-netns dev server is forwarded to (#2902). Live, like `devPort`. */
  upstreamPort: number;
  /** The slot's `127.0.0.1` server, then its `[::1]` server when one is held. */
  servers: Server<RelayData>[];
  /** Timestamp (ms) of the last proxied HTTP request or relayed WS frame. Set at
   *  first bind; updated on every HTTP request and relayed WS frame (both directions). */
  lastActivityAt: number;
  /** Random per-bind owner id. The slot's origin outlives its owner, so a browser whose
   *  owner-marker cookie doesn't carry this value gets its origin state cleared. */
  ownerNonce: string;
  /** This slot's upstream fetch gate (concurrency cap + FIFO queue). */
  gate: ProxyGate;
  /** Deadline (ms) from request arrival to upstream response headers. */
  headersTimeoutMs: number;
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
  /** Live thunk of ports the proxy must never target (Shepherd's own listeners). */
  reservedPorts?: () => readonly (number | null | undefined)[];
  /** Per-slot proxy limits (test override); defaults are the PROXY_* constants. */
  proxyLimits?: Partial<ProxyLimits>;
  /** Live thunk of hostnames a slot answers to besides loopback (see `previewRequestAllowed`). */
  allowedHosts?: () => readonly (string | null | undefined)[];
  /** Also hold `[::1]` on each slot when the host has IPv6 loopback (default false). */
  loopbackV6?: boolean;
}

export class PreviewService {
  private readonly base: number;
  private readonly count: number;
  private readonly onChange?: (sessionId: string, previewPort: number | null) => void;
  private readonly now: () => number;
  private readonly reservedPorts: () => readonly (number | null | undefined)[];
  private readonly proxyLimits: ProxyLimits;
  private readonly allowedHosts: () => readonly (string | null | undefined)[];
  private readonly loopbackV6: boolean;
  /** sessionId → reserved ports already warned about (warn once; cleared on bind/release and
   *  by `converge` for sessions it no longer lists). */
  private readonly warnedReserved = new Map<string, Set<number>>();

  /** sessionId → bound listener. */
  private readonly listeners = new Map<string, Listener>();
  /** previewPort → sessionId, so a freed slot is reclaimable. */
  private readonly slotOwner = new Map<number, string>();

  constructor(opts: PreviewServiceOptions) {
    this.base = opts.base;
    this.count = opts.count;
    this.onChange = opts.onChange;
    this.now = opts.now ?? Date.now;
    this.reservedPorts = opts.reservedPorts ?? (() => []);
    this.proxyLimits = {
      headersTimeoutMs: opts.proxyLimits?.headersTimeoutMs ?? PROXY_HEADERS_TIMEOUT_MS,
      concurrency: opts.proxyLimits?.concurrency ?? PROXY_SLOT_CONCURRENCY,
      queue: opts.proxyLimits?.queue ?? PROXY_SLOT_QUEUE,
    };
    this.allowedHosts = opts.allowedHosts ?? (() => []);
    this.loopbackV6 = opts.loopbackV6 ?? false;
  }

  /** True for a port in the preview slot range or one of Shepherd's own reserved ports. */
  isReservedPort(port: number): boolean {
    if (port >= this.base && port < this.base + this.count) return true;
    return this.reservedPorts().some((p) => !!p && p === port);
  }

  /** Refuse a reserved upstream port: drop any listener, warn once per session+port. */
  private rejectReserved(sessionId: string, port: number): null {
    const warned = this.warnedReserved.get(sessionId) ?? new Set<number>();
    this.release(sessionId); // clears warn state; restored below
    this.warnedReserved.set(sessionId, warned);
    if (!warned.has(port)) {
      warned.add(port);
      console.warn(`[preview] port ${port} is reserved — not proxying it for session ${sessionId}`);
    }
    return null;
  }

  /**
   * Ensure a listener exists for `sessionId` proxying to `devPort` — dialled at
   * `upstreamPort` when that differs (an in-netns dev server's host forward, #2902).
   *
   * - Already bound → UPDATE the stored devPort live (no rebind, no onChange);
   *   returns the existing preview port.
   * - Not bound → allocate a free slot, bind a loopback `Bun.serve`, fire
   *   `onChange(sessionId, previewPort)`, return the port.
   * - Range exhausted → log + return null (never throws).
   * - Bind error on a slot → try the next free slot; null if all fail.
   * - Reserved `upstreamPort` (the port actually dialled; an in-netns `devPort` never is) →
   *   release any listener, warn once, return null.
   */
  ensure(sessionId: string, devPort: number, upstreamPort: number = devPort): number | null {
    if (this.isReservedPort(upstreamPort)) return this.rejectReserved(sessionId, upstreamPort);
    this.warnedReserved.delete(sessionId);
    const existing = this.listeners.get(sessionId);
    if (existing) {
      existing.devPort = devPort; // live target update — the fetch/relay read this
      existing.upstreamPort = upstreamPort;
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
        upstreamPort,
        servers: [],
        lastActivityAt: this.now(),
        ownerNonce: crypto.randomUUID(),
        gate: new ProxyGate(this.proxyLimits.concurrency, this.proxyLimits.queue),
        headersTimeoutMs: this.proxyLimits.headersTimeoutMs,
      };
      try {
        // bind reads listener.devPort live (re-ensure mutates it), so the record
        // must exist first — servers is the only field bind fills in.
        listener.servers = this.bind(previewPort, listener);
      } catch (err) {
        console.warn(`[preview] failed to bind ${previewPort} for ${sessionId}: ${String(err)}`);
        continue; // try the next free slot
      }
      this.listeners.set(sessionId, listener);
      this.slotOwner.set(previewPort, sessionId);
      try {
        this.onChange?.(sessionId, previewPort);
      } catch {
        /* best-effort: observer side-effect must not break allocation */
      }
      return previewPort;
    }

    console.warn(`[preview] all free slots failed to bind for session ${sessionId}`);
    return null;
  }

  /** Tear down a session's listener and reclaim its slot. Idempotent. */
  release(sessionId: string): void {
    this.warnedReserved.delete(sessionId);
    const listener = this.listeners.get(sessionId);
    if (!listener) return;
    this.listeners.delete(sessionId);
    this.slotOwner.delete(listener.previewPort);
    // `stopServerQuietly` never throws: a synchronous throw would otherwise skip the `onChange`
    // below and strand the listener half-torn-down.
    for (const server of listener.servers) stopServerQuietly(server);
    try {
      this.onChange?.(sessionId, null);
    } catch {
      /* best-effort: observer side-effect must not break teardown */
    }
  }

  /** Reconcile to `active`: ensure each entry, release any bound session absent from it and
   *  drop warn state for sessions it no longer lists. */
  converge(active: Array<{ sessionId: string; devPort: number; upstreamPort?: number }>): void {
    const wanted = new Set(active.map((a) => a.sessionId));
    for (const sessionId of [...this.listeners.keys()]) {
      if (!wanted.has(sessionId)) this.release(sessionId);
    }
    for (const sessionId of [...this.warnedReserved.keys()]) {
      if (!wanted.has(sessionId)) this.warnedReserved.delete(sessionId);
    }
    for (const { sessionId, devPort, upstreamPort } of active)
      this.ensure(sessionId, devPort, upstreamPort);
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
      // `stopServerQuietly` never throws: one server throwing synchronously must not abort the
      // loop and leave `listeners`/`slotOwner` uncleared below.
      for (const server of listener.servers) stopServerQuietly(server);
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

  /** Bind the loopback reverse-proxy `Bun.serve` on `127.0.0.1` for one listener record, plus
   *  `[::1]` on the same port with the same handlers when `loopbackV6` is set and the host has
   *  IPv6 loopback. A failed `[::1]` bind stops the `127.0.0.1` server and rethrows, so the
   *  slot is skipped whole. Takes `previewPort` explicitly + the `listener` whose live `devPort`
   *  the fetch handler reads on every request (re-ensure mutates it in place). */
  private bind(previewPort: number, listener: Listener): Server<RelayData>[] {
    const options: Bun.Serve.Options<RelayData> = {
      port: previewPort,
      hostname: "127.0.0.1",
      fetch: (req, server) => this.handleFetch(req, server, listener),
      websocket: makeRelayHandlers(),
    };
    const v4 = Bun.serve<RelayData>(options);
    if (!this.loopbackV6 || !loopbackV6Available()) return [v4];
    try {
      return [v4, serveLoopbackV6(options, previewPort)];
    } catch (err) {
      stopServerQuietly(v4);
      throw err;
    }
  }

  /** HTTP request handler: requests failing the Host/Origin check get 403; WS upgrades go to
   *  the relay; everything else proxies. */
  private handleFetch(
    req: Request,
    server: Server<RelayData>,
    listener: Listener,
  ): Response | Promise<Response> | undefined {
    if (!previewRequestAllowed(req.headers, this.allowedHosts()))
      return new Response("Forbidden", { status: 403 });
    listener.lastActivityAt = this.now(); // stamp on every HTTP request and WS upgrade
    const { upstreamPort, devPort } = listener; // live read — re-ensure may have updated it
    if (isWebSocketUpgrade(req)) {
      const url = new URL(req.url);
      const protocols = parseSubprotocols(req.headers.get("sec-websocket-protocol"));
      const upgraded = server.upgrade(req, {
        data: {
          devPort: upstreamPort,
          path: url.pathname + url.search,
          protocols,
          origin: req.headers.has("origin") ? `http://localhost:${devPort}` : null,
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
    // A slot origin outlives its session: a registered worker would control the next owner's preview.
    if (req.headers.get("service-worker") === "script")
      return new Response("service workers are not allowed on preview origins", { status: 403 });
    return proxyHttp(req, listener);
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

// ── Host/Origin check ─────────────────────────────────────────────────────────

/** Hostnames every slot answers to, in `normalHostname` form. */
const LOOPBACK_PREVIEW_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Characters outside a Host header's `host[:port]` grammar (userinfo, path, query, …). */
const NON_AUTHORITY_CHARS = /[\s/\\?#@]/;

/** `scheme//authority` parsed, or null when the authority is absent, not a bare
 *  `host[:port]`, or unparseable. */
function parseAuthority(scheme: string, authority: string | null | undefined): URL | null {
  if (!authority || NON_AUTHORITY_CHARS.test(authority)) return null;
  try {
    return new URL(`${scheme}//${authority}`);
  } catch {
    return null;
  }
}

/** Hostname without a trailing dot; already lowercased (IPv6 bracketed) by URL. */
function normalHostname(url: URL): string {
  return url.hostname.replace(/\.$/, "");
}

/** An allowlist entry in `normalHostname` form, or null when blank or unparseable. A bare
 *  IPv6 address (`::1`) is bracketed first, so it matches the `[::1]` a Host header carries. */
function normalAllowedHost(entry: string | null | undefined): string | null {
  const h = entry?.trim();
  if (!h) return null;
  const url = parseAuthority("http:", h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  return url && normalHostname(url);
}

/** True when `origin` is an http(s) origin naming the same hostname and port as the `host`
 *  header. Both sides are read under the origin's scheme, so an elided port means that
 *  scheme's default (http 80, https 443) on either side. */
function sameOriginAsHost(origin: string, host: string): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false; // includes `null`
  }
  if (o.protocol !== "http:" && o.protocol !== "https:") return false;
  const h = parseAuthority(o.protocol, host);
  return h !== null && normalHostname(o) === normalHostname(h) && o.port === h.port;
}

/** True for a loopback hostname or one matching an `extraHosts` entry. */
function isPreviewHostname(
  hostname: string,
  extraHosts: readonly (string | null | undefined)[],
): boolean {
  if (LOOPBACK_PREVIEW_HOSTS.has(hostname)) return true;
  return extraHosts.some((e) => normalAllowedHost(e) === hostname);
}

/**
 * Whether a slot serves this request. The Host header's hostname must be loopback
 * (`127.0.0.1`, `localhost`, `[::1]`) or one of `extraHosts`; a missing or unparseable Host
 * fails. An Origin header, when present, must be same-origin with Host (same hostname and
 * port); an unparseable Origin fails. `Origin: null` passes only with the browser-set
 * `Sec-Fetch-Site: same-origin` (a same-origin form post under `Referrer-Policy: no-referrer`
 * is sent with `null`); any other `null` fails. No Origin passes. Exported for tests.
 */
export function previewRequestAllowed(
  headers: Headers,
  extraHosts: readonly (string | null | undefined)[],
): boolean {
  const host = headers.get("host") ?? "";
  const hostUrl = parseAuthority("http:", host);
  if (hostUrl === null || !isPreviewHostname(normalHostname(hostUrl), extraHosts)) return false;
  const origin = headers.get("origin");
  if (origin === null) return true;
  if (origin === "null") return headers.get("sec-fetch-site")?.toLowerCase() === "same-origin";
  return sameOriginAsHost(origin, host);
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
 * Reverse-proxy a plain HTTP request to `127.0.0.1:<upstreamPort>` with the same path,
 * query, method, headers (minus host + hop-by-hop) and a streamed body. Strips
 * content-framing + hop-by-hop + framing-blocking headers from the response (Bun's
 * fetch decodes the body, so a forwarded content-encoding/length would break it).
 * The HUD session cookie never crosses the proxy: it is stripped from the request
 * (the browser attaches it, since cookies ignore ports) and any upstream Set-Cookie
 * naming it is dropped; other app cookies pass both ways. Navigations get the slot-origin
 * isolation treatment (see `markNavigation`).
 * Upstream fetches are bounded per slot (see `gatedFetch`): a concurrency cap with a FIFO
 * queue (503 when full), a headers deadline (504) and abort on client disconnect.
 * Fails closed with a 502 if upstream throws.
 */
async function proxyHttp(req: Request, listener: Listener): Promise<Response> {
  const { upstreamPort, devPort, previewPort, ownerNonce } = listener;
  const url = new URL(req.url);
  const target = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`;

  const navigation = req.headers.get("sec-fetch-mode") === "navigate";
  const newOwner = navigation && !hasOwnerMarker(req.headers, previewPort, ownerNonce);

  const headers = new Headers(req.headers);
  for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);
  stripSessionCookie(headers);
  // Never let a previous owner's cached copy be revalidated into this owner's page.
  if (newOwner) for (const h of CONDITIONAL_REQUEST_HEADERS) headers.delete(h);

  const hasBody = req.body !== null && req.method !== "GET" && req.method !== "HEAD";

  const gated = await gatedFetch(req, listener, target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    // Streaming a request body through Bun's fetch requires half-duplex.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
  if (gated instanceof Response) return gated;
  const { upstream, release } = gated;

  const respHeaders = new Headers(upstream.headers);
  for (const h of STRIPPED_RESPONSE_HEADERS) respHeaders.delete(h);
  stripFramingHeaders(respHeaders);
  stripSessionSetCookie(respHeaders);
  rewriteLoopbackLocation(respHeaders, devPort, upstreamPort);
  if (navigation) markNavigation(respHeaders, newOwner, previewPort, ownerNonce);
  const body = releaseWhenDone(upstream.body, release);
  try {
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    // An upstream status Response can't carry (600–999) throws: free the permit and body first.
    void body?.cancel();
    throw err;
  }
}

/** An admitted upstream response plus the once-only release of its slot permit. */
interface GatedUpstream {
  upstream: Response;
  release: () => void;
}

/**
 * Fetch `target` under the slot's limits: wait FIFO for a gate permit, abort when the client
 * disconnects, and abort when response headers have not arrived `headersTimeoutMs` after the
 * request did (queue wait included). Returns the proxy's own reply when it gives up — 503 for
 * a full queue, 504 past the deadline, 502 when the upstream fails. Otherwise the caller owns
 * `release`, which must run once the response body ends; a client abort also releases.
 */
async function gatedFetch(
  req: Request,
  listener: Listener,
  target: string,
  init: RequestInit,
): Promise<GatedUpstream | Response> {
  const deadline = requestDeadline(req, listener.headersTimeoutMs);
  if (!(await listener.gate.acquire(deadline.signal))) {
    deadline.dispose();
    return deadline.timedOut() ? upstreamTimedOut() : new Response("Preview busy", { status: 503 });
  }
  const release = onceRelease(listener.gate, deadline.dispose);
  // Aborted after admission (client gone or deadline passed): nothing is left to deliver.
  deadline.signal.addEventListener("abort", release, { once: true });
  try {
    const upstream = await fetch(target, { ...init, signal: deadline.signal });
    deadline.clearTimer(); // headers are in; the body streams on, tied only to client abort
    return { upstream, release };
  } catch {
    release();
    if (deadline.timedOut()) return upstreamTimedOut();
    // Dev server gone / refused — fail closed, never a silent empty 200.
    return new Response("Preview upstream unavailable", { status: 502 });
  }
}

/** The proxy's reply when the headers deadline passes. */
function upstreamTimedOut(): Response {
  return new Response("Preview upstream timed out", { status: 504 });
}

/** Abort wiring for one proxied request: `signal` aborts when the client disconnects or the
 *  headers deadline passes. `dispose` clears the timer and detaches from `req.signal`. */
function requestDeadline(req: Request, timeoutMs: number) {
  const ctl = new AbortController();
  const onClientAbort = () => ctl.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  if (req.signal.aborted) ctl.abort();
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    clearTimer: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onClientAbort);
    },
  };
}

/** A release that runs at most once: `dispose` the request wiring, then return the permit. */
function onceRelease(gate: ProxyGate, dispose: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    dispose();
    gate.release();
  };
}

/** Stream `body` through unchanged, calling `release` when it ends, errors or is cancelled
 *  (cancel also cancels the upstream). A null body releases at once. */
function releaseWhenDone(
  body: ReadableStream<Uint8Array> | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (body === null) {
    release();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read().catch((err: unknown) => {
        release();
        throw err;
      });
      if (!chunk.done) return controller.enqueue(chunk.value);
      release();
      controller.close();
    },
    cancel(reason) {
      release();
      return reader.cancel(reason).catch(() => {
        /* best-effort: upstream body already gone */
      });
    },
  });
}

/**
 * Rewrite an upstream redirect whose `Location` points back at the loopback dev server
 * (`http://127.0.0.1:<devPort>/…` or `localhost:<devPort>`) to a PATH-RELATIVE form, so
 * the browser resolves it against the preview origin (`host.ts.net:<previewPort>`) rather
 * than following an unreachable loopback URL. The redirect: "manual" proxy passes Location
 * through verbatim, so a dev server's own absolute self-redirect (trailing-slash, base
 * path, post-login) would otherwise strand the browser. Already-relative Locations and
 * genuinely cross-origin redirects (OAuth providers, CDNs) are left untouched. `ports` are the
 * dev port plus, for a forwarded in-netns dev server, the host port the proxy dialled (#2902).
 */
export function rewriteLoopbackLocation(headers: Headers, ...ports: number[]): void {
  const loc = headers.get("location");
  if (loc === null) return;
  let u: URL;
  try {
    u = new URL(loc);
  } catch {
    return; // relative Location — already resolves against the preview origin
  }
  const isLoopbackHost = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (isLoopbackHost && ports.some((p) => u.port === String(p))) {
    headers.set("location", u.pathname + u.search + u.hash);
  }
}

// ── Slot-origin isolation ─────────────────────────────────────────────────────
//
// A preview origin is `host:<slot>`, and slots are reused across sessions. Per-origin browser
// state (storage, HTTP cache) left by a previous owner must not reach the next one. Each bind
// mints an `ownerNonce`; a navigation whose browser doesn't carry it in the slot's HttpOnly
// marker cookie gets `Clear-Site-Data: "cache", "storage"` (never "cookies": those are
// host-wide and include the HUD session) plus the marker. Navigations are `no-store`, so a
// cached document can never skip this check.

/** Prefix of the per-slot owner-marker cookie; the slot port follows. */
const OWNER_COOKIE_PREFIX = "shepherd_preview_owner_";

/** Validators dropped on a new owner's navigation (no 304 against a prior owner's cache). */
const CONDITIONAL_REQUEST_HEADERS = ["if-none-match", "if-modified-since"];

/** True when any `Cookie` pair is this slot's marker carrying the current owner nonce. */
function hasOwnerMarker(headers: Headers, previewPort: number, ownerNonce: string): boolean {
  const want = `${OWNER_COOKIE_PREFIX}${previewPort}=${ownerNonce}`;
  return (headers.get("cookie") ?? "").split(/[;,]/).some((pair) => pair.trim() === want);
}

/** Navigation response: never cached; on a new owner, wipe origin state and set the marker. */
function markNavigation(
  headers: Headers,
  newOwner: boolean,
  previewPort: number,
  ownerNonce: string,
): void {
  headers.set("cache-control", "no-store");
  headers.delete("expires");
  if (!newOwner) return;
  headers.set("clear-site-data", '"cache", "storage"');
  headers.append(
    "set-cookie",
    `${OWNER_COOKIE_PREFIX}${previewPort}=${ownerNonce}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

/** Cookie names the proxy owns and never lets cross it: the HUD session + owner markers. */
function isProxyCookie(name: string): boolean {
  return name === SESSION_COOKIE || name.startsWith(OWNER_COOKIE_PREFIX);
}

/** Name of a `name=value` cookie pair (text before the first `=`, trimmed). */
function cookieName(pair: string): string {
  const eq = pair.indexOf("=");
  return (eq < 0 ? pair : pair.slice(0, eq)).trim();
}

/** Remove the HUD session cookie and owner markers from the request `Cookie` header, keeping
 *  every other pair. Fails closed on comma-joined duplicate headers: a pair is dropped when ANY
 *  of its `,`-separated segments names a proxy cookie. */
function stripSessionCookie(headers: Headers): void {
  const cookie = headers.get("cookie");
  if (cookie === null) return;
  const kept = cookie
    .split(";")
    .filter((pair) => pair.trim().length > 0)
    .filter((pair) => !pair.split(",").some((seg) => isProxyCookie(cookieName(seg))))
    .map((pair) => pair.trim());
  if (kept.length === 0) headers.delete("cookie");
  else headers.set("cookie", kept.join("; "));
}

/** Drop any upstream `Set-Cookie` that would set, overwrite or clear the HUD session cookie
 *  or an owner marker.
 *  Leading `=` are skipped before matching: browsers store `=shepherd_session=x` as an
 *  empty-name cookie and send it back as `shepherd_session=x`, shadowing the real one. */
function stripSessionSetCookie(headers: Headers): void {
  const all = headers.getSetCookie();
  if (all.length === 0) return;
  headers.delete("set-cookie");
  for (const c of all) {
    const pair = c.split(";")[0]!.replace(/^[\s=]+/, "");
    if (!isProxyCookie(cookieName(pair))) headers.append("set-cookie", c);
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
// flushed on upstream open. After open they are sent straight on, but only while the
// upstream socket's send buffer stays under MAX_UPSTREAM_BUFFERED_WS_BYTES: an
// upstream that stops reading is terminated and the client closed, instead of
// unbounded buffering.

/**
 * Cap on bytes buffered client→upstream before the upstream socket opens. The
 * relay carries UNTRUSTED agent apps; a client flooding frames during the open
 * window would otherwise grow the heap without bound. On overflow we fail safe —
 * close both sockets — rather than buffer forever. ~1 MiB.
 */
const MAX_PENDING_WS_BYTES = 1024 * 1024;

/**
 * Cap on bytes queued on the open upstream socket (its `bufferedAmount` plus the frame
 * about to be sent). Past it the relay terminates the upstream and closes the client. 16 MiB.
 */
const MAX_UPSTREAM_BUFFERED_WS_BYTES = 16 * 1024 * 1024;

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
      const { devPort, path, protocols, origin } = ws.data;
      // The DOM constructor type lacks Bun's options form (headers).
      const options = {
        protocols: protocols.length > 0 ? protocols : undefined,
        headers: origin ? { Origin: origin } : undefined,
      } satisfies Bun.WebSocketOptions;
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(`ws://127.0.0.1:${devPort}${path}`, options as never);
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
        // An upstream that stopped reading would let its send buffer grow without bound.
        if (ctx.upstream.bufferedAmount + frameByteLength(frame) > MAX_UPSTREAM_BUFFERED_WS_BYTES)
          return dropStalledRelay(ctx, ws, ctx.upstream);
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

/**
 * Upstream send buffer over its cap: stop relaying, terminate the upstream and close the
 * client. Terminate, not close: a close frame would queue behind the bytes the upstream
 * isn't reading, keeping the socket and its buffer alive while the upstream stays stalled.
 */
function dropStalledRelay(ctx: RelayContext, ws: RelaySocket, upstream: WebSocket): void {
  ctx.closing = true;
  try {
    // Bun's client WebSocket has terminate() at runtime; its types omit it.
    (upstream as WebSocket & { terminate(): void }).terminate();
  } catch {
    /* best-effort: upstream already gone */
  }
  safeClose(ws);
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
    /* best-effort: peer gone */
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
    /* best-effort: peer gone */
  }
}
