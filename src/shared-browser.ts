/**
 * Shared Browser lifecycle (see docs/adr/0001-brokered-cdp-for-shared-browser.md, CONTEXT.md).
 *
 * One Chromium per repo, launched on demand with a persistent per-repo Browser Profile and
 * `--remote-debugging-pipe` (fd3 in / fd4 out — no TCP debug port). Every Browser Attach goes
 * through that repo's `CdpPipe`. A browser with no attached client is stopped after `idleMs`;
 * at most `maxBrowsers` run at once (launching another evicts the longest-idle unattached one,
 * or refuses).
 *
 * The server is one Bun event loop: nothing here does sync fs/exec, and teardown (`stop`,
 * `stopAll`) is synchronous — it signals the child and never awaits it, so it is safe from
 * `process.on("exit")`.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe, type CdpClient, type CdpPipeClient } from "./cdp-pipe";

export type SharedBrowserErrorCode = "missing-binary" | "cap" | "launch-failed";

export class SharedBrowserError extends Error {
  readonly code: SharedBrowserErrorCode;
  constructor(code: SharedBrowserErrorCode, message: string) {
    super(message);
    this.name = "SharedBrowserError";
    this.code = code;
  }
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SharedBrowserDeps {
  /** Where per-repo Browser Profiles live (`config.browserProfileRoot`). */
  profileRoot: string;
  spawn?: SpawnFn;
  /** Resolves a binary name (PATH lookup) or path (executable check); null when absent. */
  which?: (bin: string) => Promise<string | null>;
  /** Display detection + `SHEPHERD_CHROMIUM_BIN`; also the child's environment. */
  env?: NodeJS.ProcessEnv;
  /** Binary override (`config.chromiumBin`); wins over `env.SHEPHERD_CHROMIUM_BIN`. */
  chromiumBin?: string | null;
  /** Stop a browser this long after its last client detached. Default 15 min. */
  idleMs?: number;
  /** Global cap on concurrently running browsers. Default 3. */
  maxBrowsers?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BROWSERS = 3;
const KILL_GRACE_MS = 5000;
/** How long a graceful `Browser.close` gets before falling back to SIGTERM. */
const GRACEFUL_CLOSE_MS = 5000;
const OPEN_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 8 * 1024;
const STDERR_TAIL_LINES = 20;
export const BINARY_CANDIDATES = [
  "chromium",
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
];

/** Async PATH lookup (or executable check for a path). Never sync — it runs on the server loop. */
export async function whichAsync(
  bin: string,
  pathEnv: string | undefined = process.env.PATH,
): Promise<string | null> {
  const isExecutable = (p: string) =>
    access(p, constants.X_OK).then(
      () => true,
      () => false,
    );
  if (bin.includes("/")) return isAbsolute(bin) && (await isExecutable(bin)) ? bin : null;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return s || "repo";
}

/** Stable per-repo profile dir: `<basename-slug>-<sha256(repoPath)[:12]>` under `profileRoot`. */
export function browserProfileDir(profileRoot: string, repoPath: string): string {
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  return join(profileRoot, `${slug(basename(repoPath))}-${hash}`);
}

/** Chromium argv: pipe transport, persistent profile, headful only when a display exists. */
function chromiumArgs(profileDir: string, env: NodeJS.ProcessEnv): string[] {
  const headful = Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    headful ? "--ozone-platform-hint=auto" : "--headless=new",
    "about:blank",
  ];
}

/**
 * The child's environment: display/session plumbing only. The server env carries operator
 * secrets (auth token, plugin keys) that a browser agents can drive has no business holding.
 */
const CHROMIUM_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LANGUAGE",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
];

export function chromiumEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && (CHROMIUM_ENV_KEYS.includes(k) || k.startsWith("LC_"))) out[k] = v;
  return out;
}

/** Chromium's "Continue where you left off" startup pref value. */
const RESTORE_LAST_SESSION = 1;

type Prefs = Record<string, unknown>;

/** Pref groups pinned on every launch: `group → { key: value }`. */
function pinnedPrefs(downloadDir: string): Record<string, Prefs> {
  return {
    // Session cookies (no Max-Age) survive a restart only with "continue where you left off",
    // and a Handoff Login must survive the idle stop.
    session: { restore_on_startup: RESTORE_LAST_SESSION },
    // Page-triggered downloads land in the profile, never the operator's ~/Downloads.
    download: { default_directory: downloadDir, prompt_for_download: false },
    savefile: { default_directory: downloadDir },
  };
}

async function readPrefs(file: string): Promise<Prefs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Prefs;
  } catch {
    // missing or unreadable: start from an empty pref set
  }
  return {};
}

/** Merges `pinned` into `prefs` in place; true when anything changed. */
function mergePinned(prefs: Prefs, pinned: Record<string, Prefs>): boolean {
  let changed = false;
  for (const [group, values] of Object.entries(pinned)) {
    const current = prefs[group];
    const merged: Prefs =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Prefs) }
        : {};
    for (const [key, value] of Object.entries(values)) {
      if (merged[key] === value) continue;
      merged[key] = value;
      changed = true;
    }
    prefs[group] = merged;
  }
  return changed;
}

/** Where a profile's page-triggered downloads land (inside the profile dir). */
export function browserDownloadDir(profileDir: string): string {
  return join(profileDir, "Downloads");
}

/**
 * Pin the profile prefs Shepherd depends on before launch: session restore (logins survive
 * the idle stop) and a download dir inside the profile (agents can't drop files into the
 * operator's ~/Downloads). Chromium rewrites Preferences itself, so merge, never replace.
 */
export async function pinProfilePrefs(profileDir: string): Promise<void> {
  const downloadDir = browserDownloadDir(profileDir);
  await mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const dir = join(profileDir, "Default");
  const file = join(dir, "Preferences");
  const prefs = await readPrefs(file);
  if (!mergePinned(prefs, pinnedPrefs(downloadDir))) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(prefs), { mode: 0o600 });
}

interface Entry {
  readonly repoPath: string;
  readonly child: ChildProcess;
  readonly pipe: CdpPipe;
  readonly attached: Set<object>;
  lastActivity: number;
  idleTimer: unknown;
  stopping: boolean;
  stderrTail: string;
}

interface Starting {
  promise: Promise<Entry>;
  cancelled: boolean;
}

export class SharedBrowserManager {
  readonly #profileRoot: string;
  readonly #spawn: SpawnFn;
  readonly #which: (bin: string) => Promise<string | null>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #chromiumBin: string | null;
  readonly #idleMs: number;
  readonly #maxBrowsers: number;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #log: (msg: string) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #starting = new Map<string, Starting>();
  #disposed = false;

  constructor(deps: SharedBrowserDeps) {
    this.#profileRoot = deps.profileRoot;
    this.#spawn = deps.spawn ?? nodeSpawn;
    this.#env = deps.env ?? process.env;
    this.#chromiumBin = deps.chromiumBin || this.#env.SHEPHERD_CHROMIUM_BIN || null;
    this.#which = deps.which ?? ((bin) => whichAsync(bin, this.#env.PATH));
    this.#idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.#maxBrowsers = deps.maxBrowsers ?? DEFAULT_MAX_BROWSERS;
    this.#now = deps.now ?? Date.now;
    this.#setTimeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout =
      deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#log = deps.log ?? ((msg) => console.warn(`[shared-browser] ${msg}`));
  }

  get runningCount(): number {
    return this.#entries.size;
  }

  isRunning(repoPath: string): boolean {
    return this.#entries.has(repoPath);
  }

  /** Browser Attach: launch the repo's browser if needed and multiplex `sink` onto it. */
  async attach(repoPath: string, sink: CdpClient): Promise<CdpPipeClient> {
    const entry = await this.#ensure(repoPath);
    const token = {};
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      entry.attached.delete(token);
      entry.lastActivity = this.#now();
      if (entry.attached.size === 0) this.#armIdle(entry);
    };
    const inner = entry.pipe.addClient({
      send: (text) => sink.send(text),
      close: (code, reason) => {
        release();
        sink.close(code, reason);
      },
    });
    if (!done) {
      entry.attached.add(token);
      entry.lastActivity = this.#now();
      this.#cancelIdle(entry);
    }
    return {
      receive: (text) => inner.receive(text),
      detach: () => {
        inner.detach();
        release();
      },
      ready: inner.ready,
    };
  }

  /** Operator "Open": a new tab at `url`. Counts as activity, not as an attach. */
  async open(repoPath: string, url: string): Promise<void> {
    const entry = await this.#ensure(repoPath);
    entry.lastActivity = this.#now();
    this.#cancelIdle(entry);
    try {
      await this.#createTarget(entry, url);
    } finally {
      entry.lastActivity = this.#now();
      if (this.#entries.get(repoPath) === entry && entry.attached.size === 0) this.#armIdle(entry);
    }
  }

  /**
   * Synchronous; closes every attached client. Graceful (default): `Browser.close` over the pipe
   * so Chromium flushes cookies, SIGTERM only if it is still up after a grace period. Not
   * graceful (process exit): SIGTERM now. SIGKILL follows SIGTERM after another grace period.
   */
  stop(repoPath: string, opts: { graceful?: boolean } = {}): void {
    const starting = this.#starting.get(repoPath);
    if (starting) starting.cancelled = true;
    const entry = this.#entries.get(repoPath);
    if (!entry) return;
    this.#entries.delete(repoPath);
    this.#cancelIdle(entry);
    entry.stopping = true;
    const graceful = opts.graceful ?? true;
    if (graceful) entry.pipe.closeBrowser();
    entry.pipe.close("browser stopped");
    const { child } = entry;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const alive = () => child.exitCode === null && child.signalCode === null;
    const signal = (sig: NodeJS.Signals) => {
      if (!alive()) return;
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    };
    const timers: unknown[] = [];
    const later = (ms: number, fn: () => void) => {
      const t = this.#setTimeout(fn, ms);
      (t as { unref?: () => void } | null)?.unref?.();
      timers.push(t);
    };
    const terminate = () => {
      signal("SIGTERM");
      later(KILL_GRACE_MS, () => signal("SIGKILL"));
    };
    if (graceful) later(GRACEFUL_CLOSE_MS, terminate);
    else terminate();
    child.once("exit", () => {
      for (const t of timers) this.#clearTimeout(t);
    });
  }

  /** Synchronous teardown for process exit / SIGTERM. Idempotent; refuses later launches. */
  stopAll(): void {
    this.#disposed = true;
    for (const starting of this.#starting.values()) starting.cancelled = true;
    for (const repoPath of [...this.#entries.keys()]) this.stop(repoPath, { graceful: false });
  }

  #ensure(repoPath: string): Promise<Entry> {
    const existing = this.#entries.get(repoPath);
    if (existing) return Promise.resolve(existing);
    const pending = this.#starting.get(repoPath);
    if (pending) return pending.promise;
    if (this.#disposed)
      return Promise.reject(new SharedBrowserError("launch-failed", "shutting down"));
    // Cap check is synchronous, before any await, so concurrent launches can't overshoot.
    if (this.#entries.size + this.#starting.size >= this.#maxBrowsers) {
      const victim = this.#evictionCandidate();
      if (!victim)
        return Promise.reject(
          new SharedBrowserError(
            "cap",
            `${this.#maxBrowsers} shared browsers already running, all attached`,
          ),
        );
      this.#log(`cap reached: stopping idle browser for ${victim.repoPath}`);
      this.stop(victim.repoPath);
    }
    const starting: Starting = { promise: Promise.resolve(null as never), cancelled: false };
    starting.promise = this.#launch(repoPath, starting).finally(() => {
      if (this.#starting.get(repoPath) === starting) this.#starting.delete(repoPath);
    });
    this.#starting.set(repoPath, starting);
    return starting.promise;
  }

  #evictionCandidate(): Entry | null {
    let best: Entry | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.attached.size > 0) continue;
      if (!best || entry.lastActivity < best.lastActivity) best = entry;
    }
    return best;
  }

  async #resolveBinary(): Promise<string> {
    const override = this.#chromiumBin;
    if (override) {
      const found = await this.#which(override);
      if (found) return found;
      throw new SharedBrowserError(
        "missing-binary",
        `SHEPHERD_CHROMIUM_BIN=${override} is not an executable`,
      );
    }
    for (const bin of BINARY_CANDIDATES) {
      const found = await this.#which(bin);
      if (found) return found;
    }
    throw new SharedBrowserError(
      "missing-binary",
      `no Chromium found on PATH (tried ${BINARY_CANDIDATES.join(", ")}); set SHEPHERD_CHROMIUM_BIN`,
    );
  }

  async #launch(repoPath: string, starting: Starting): Promise<Entry> {
    const bin = await this.#resolveBinary();
    const profileDir = browserProfileDir(this.#profileRoot, repoPath);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await pinProfilePrefs(profileDir);
    if (starting.cancelled || this.#disposed)
      throw new SharedBrowserError("launch-failed", "browser stopped while launching");
    let child: ChildProcess;
    try {
      child = this.#spawn(bin, chromiumArgs(profileDir, this.#env), {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        detached: false,
        env: chromiumEnv(this.#env),
      });
    } catch (err) {
      throw new SharedBrowserError("launch-failed", `spawn ${bin} failed: ${String(err)}`);
    }
    const input = child.stdio[3] as Writable | null | undefined;
    const output = child.stdio[4] as Readable | null | undefined;
    if (child.pid === undefined || !input || !output) {
      try {
        child.kill("SIGKILL");
      } catch {
        // never started
      }
      throw new SharedBrowserError("launch-failed", `could not start ${bin}`);
    }
    const entry: Entry = {
      repoPath,
      child,
      pipe: new CdpPipe({
        write: (data) => {
          try {
            if (input.writable) input.write(data);
          } catch {
            // EPIPE etc.: the exit handler tears the entry down.
          }
        },
      }),
      attached: new Set(),
      lastActivity: this.#now(),
      idleTimer: null,
      stopping: false,
      stderrTail: "",
    };
    input.on("error", () => {});
    output.on("error", () => {});
    output.on("data", (chunk: Uint8Array) => entry.pipe.feed(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      entry.stderrTail = (entry.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.stderr?.on("error", () => {});
    child.on("error", (err) => this.#onGone(entry, `error: ${err.message}`));
    child.on("exit", (code, signal) => this.#onGone(entry, `exit code=${code} signal=${signal}`));
    this.#entries.set(repoPath, entry);
    this.#log(`launched ${bin} (pid ${child.pid}) for ${repoPath}`);
    return entry;
  }

  #onGone(entry: Entry, why: string): void {
    if (this.#entries.get(entry.repoPath) === entry) this.#entries.delete(entry.repoPath);
    this.#cancelIdle(entry);
    entry.pipe.close("browser exited");
    if (entry.stopping) return;
    entry.stopping = true;
    const tail = entry.stderrTail.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
    this.#log(
      `browser for ${entry.repoPath} exited unexpectedly (${why})${tail ? `\n${tail}` : ""}`,
    );
  }

  #armIdle(entry: Entry): void {
    this.#cancelIdle(entry);
    if (this.#entries.get(entry.repoPath) !== entry) return;
    entry.idleTimer = this.#setTimeout(() => {
      entry.idleTimer = null;
      if (this.#entries.get(entry.repoPath) !== entry || entry.attached.size > 0) return;
      this.#log(`stopping idle browser for ${entry.repoPath}`);
      this.stop(entry.repoPath);
    }, this.#idleMs);
  }

  #cancelIdle(entry: Entry): void {
    if (entry.idleTimer === null) return;
    this.#clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  /** `Target.createTarget` through a short-lived internal client (never counted as attached). */
  async #createTarget(entry: Entry, url: string): Promise<void> {
    let settle!: { resolve: () => void; reject: (err: Error) => void };
    const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const client = entry.pipe.addClient({
      send: (text) => {
        let msg: { id?: unknown; error?: { message?: unknown } };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          return;
        }
        if (msg.id !== 1) return;
        if (msg.error) settle.reject(new Error(`Target.createTarget failed: ${msg.error.message}`));
        else settle.resolve();
      },
      close: (_code, reason) => settle.reject(new Error(reason ?? "browser closed")),
    });
    const timer = this.#setTimeout(
      () => settle.reject(new Error("Target.createTarget timed out")),
      OPEN_TIMEOUT_MS,
    );
    try {
      client.receive(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }));
      await done;
    } finally {
      this.#clearTimeout(timer);
      client.detach();
    }
  }
}

export interface ReapDeps {
  procRoot?: string;
  platform?: NodeJS.Platform;
  selfPid?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

async function readPpid(procRoot: string, pid: number): Promise<number | null> {
  try {
    const stat = await readFile(join(procRoot, String(pid), "stat"), "utf8");
    // "pid (comm) state ppid ..." — comm may contain spaces/parens, so split after the last ')'.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

async function hasProfileFlag(procRoot: string, pid: number, marker: string): Promise<boolean> {
  try {
    const cmdline = await readFile(join(procRoot, String(pid), "cmdline"), "utf8");
    return cmdline.split("\0").some((arg) => arg.startsWith(marker));
  } catch {
    return false;
  }
}

/** Walks `pid`'s ancestry (bounded) looking for `ancestor`. */
async function descendsFrom(
  ppidOf: (pid: number) => Promise<number | null>,
  start: number | null,
  ancestor: number,
): Promise<boolean> {
  let cursor = start;
  for (let depth = 0; cursor !== null && cursor > 1 && depth < 64; depth++) {
    if (cursor === ancestor) return true;
    cursor = await ppidOf(cursor);
  }
  return false;
}

/**
 * Boot safety net: SIGTERM Chromium processes left running on one of our Browser Profiles by a
 * previous (crashed / SIGKILLed) server. Linux only; matches `--user-data-dir=<profileRoot>/`
 * in `/proc/<pid>/cmdline`, kills only the browser root (children follow it) and never touches
 * a process descended from this server. Returns the number of processes signalled.
 */
export async function reapOrphanBrowsers(
  profileRoot: string,
  deps: ReapDeps = {},
): Promise<number> {
  if ((deps.platform ?? process.platform) !== "linux") return 0;
  const procRoot = deps.procRoot ?? "/proc";
  const selfPid = deps.selfPid ?? process.pid;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const marker = `--user-data-dir=${profileRoot.replace(/\/+$/, "")}/`;
  const pids = (await readdir(procRoot)).filter((n) => /^\d+$/.test(n)).map(Number);
  const flagged = await Promise.all(pids.map((pid) => hasProfileFlag(procRoot, pid, marker)));
  const candidates = new Set(pids.filter((pid, i) => flagged[i] && pid !== selfPid));
  const ppidCache = new Map<number, Promise<number | null>>();
  const ppidOf = (pid: number) => {
    let cached = ppidCache.get(pid);
    if (!cached) ppidCache.set(pid, (cached = readPpid(procRoot, pid)));
    return cached;
  };
  let killed = 0;
  for (const pid of candidates) {
    const parent = await ppidOf(pid);
    if (parent !== null && candidates.has(parent)) continue; // its browser root gets the signal
    if (await descendsFrom(ppidOf, parent, selfPid)) continue;
    try {
      kill(pid, "SIGTERM");
      killed++;
    } catch {
      // exited meanwhile
    }
  }
  return killed;
}
