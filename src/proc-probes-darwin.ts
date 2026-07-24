import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { config } from "./config";
import type { ReaperProbes } from "./process-reaper";

// ── darwin probe backend ─────────────────────────────────────────────────────
//
// The Linux `ReaperProbes` default reads /proc directly; on macOS none of those
// paths exist, so every read fails into a `catch { continue }` and detection
// silently returns nothing (issue #1912). This module implements the same probe
// interface on top of a single `lsof` invocation, memoised into a per-instance
// snapshot cell so the synchronous per-pid probe methods never spawn.
//
// SCOPE — this backend implements exactly what detection needs
// (`scanProcs`/`portsForPid`/`cwdForPid`/`listPids`/`commForPid`) plus the refresh
// seam. It deliberately omits `ppidForPid` (keeps the orphan reaps no-op on
// darwin), `environForPid`/`cpuStatForPid`/`uptimeSeconds` (keeps the #1144
// runaway reaper fail-closed), `listeningPorts` (class-3 `tailscale serve`
// detection needs a uid-agnostic listener set the non-root `lsof` can't give;
// its absence makes `scanSystemSideEffects` return [] — fail closed, matching
// today), and it sets `canAuthorizeSignal: false` so `stopListenersOnPort` never
// SIGKILLs a pid resolved from cell data on a platform with no recycle
// fingerprint.

/** The one `lsof` invocation the backend runs. `-d cwd` and `-iTCP` are different
 *  selection types, so lsof ORs them: one call yields, per process, its command,
 *  cwd, and every listening TCP socket. `+c 0` disables comm truncation; `-nP`
 *  keeps addresses/ports numeric; `-w` suppresses warnings; `-F pcfn` emits the
 *  parseable field format (pid, command, fd, name). */
export const LSOF_ARGV = [
  "-nP",
  "-w",
  "+c",
  "0",
  "-F",
  "pcfn",
  "-d",
  "cwd",
  "-iTCP",
  "-sTCP:LISTEN",
] as const;

/** Hard timeout on the async `lsof` spawn — a `-d cwd` walk touches every process
 *  on the host, so an unbounded call could hang on a stalled mount and leave the
 *  cell permanently stale. Mirrors the diagnostics-probe discipline. */
const REFRESH_TIMEOUT_MS = 3000;

/** Poller tick granularity (StatusPoller's `intervalMs` default), a term in the
 *  worst-case healthy-cell age below. Kept as a named constant, not read from the
 *  poller, so the two stay legibly in sync. */
const POLLER_TICK_MS = 1000;

/** Hard cap on how long any forced refresh may block its caller. A forced refresh
 *  chains (await any in-flight refresh, then issue one more) so its data provably
 *  post-dates the call — but that is ~2×REFRESH_TIMEOUT_MS worst case, which would
 *  block HTTP handlers. Past this budget the caller returns and proceeds against
 *  the existing cell (`snapshotState()` still gates every verdict downstream); the
 *  background refresh keeps running and updates the cell when it lands. */
const FORCE_WAIT_BUDGET_MS = REFRESH_TIMEOUT_MS;

/** Minimum gap between "lsof refresh failed" warns. A host with no usable `lsof`
 *  fails every refresh forever, so the log line is throttled well below the retry
 *  cadence; the operator's durable signal is the `preview_probes` Diagnose row. */
const FAIL_WARN_INTERVAL_MS = 60_000;

/** One process as parsed from `lsof -F pcfn`. */
export interface LsofProc {
  pid: number;
  comm: string;
  cwd: string;
  /** Listening TCP ports held open by this process (sorted, deduped). */
  ports: number[];
}

/**
 * Parse `lsof -nP -F pcfn -d cwd -iTCP -sTCP:LISTEN` output.
 *
 * The `-F` format is one field per line: a leading char names the field, the rest
 * is the value. `p<pid>` opens a process block; `c<comm>` its command; `f<fd>`
 * sets the current file descriptor (either `fcwd` or a numeric socket fd); `n<name>`
 * gives the current fd's name — a filesystem path when the fd is `cwd`, an address
 * like `*:5173` / `127.0.0.1:8384` / `[::1]:3000` when it is a listening socket.
 *
 * Pure and total: any malformed / truncated line is skipped rather than throwing,
 * so a non-zero `lsof` exit that still printed valid blocks parses fine.
 */
export function parseLsofFields(text: string): LsofProc[] {
  const st: ParseState = { out: [], cur: null, fdIsCwd: false };
  for (const line of text.split("\n")) {
    if (line.length > 0) feedLine(st, line);
  }
  if (st.cur) st.out.push(finishProc(st.cur));
  return st.out;
}

/** Accumulator threaded through {@link feedLine}. */
interface ParseState {
  out: LsofProc[];
  /** The process block currently being filled, or null before the first `p`. */
  cur: PendingProc | null;
  /** Whether the current `f` context is the cwd fd (so the next `n` is a path). */
  fdIsCwd: boolean;
}

/** Apply one `-F` field line to the parse state. Each field kind returns early, so
 *  the branches stay flat rather than nesting inside the caller's loop. */
function feedLine(st: ParseState, line: string): void {
  const tag = line[0];
  const val = line.slice(1);
  // `p` opens a new process block, flushing the previous one.
  if (tag === "p") {
    if (st.cur) st.out.push(finishProc(st.cur));
    st.cur = startProc(val);
    st.fdIsCwd = false;
    return;
  }
  // `f` only switches which fd subsequent `n` lines describe.
  if (tag === "f") {
    st.fdIsCwd = val === "cwd";
    return;
  }
  if (!st.cur) return; // a field before any `p` — ignore
  if (tag === "c") st.cur.comm = val;
  else if (tag === "n") applyName(st.cur, val, st.fdIsCwd);
}

/** Open a process block from a `p<pid>` value, or null when the pid is unparseable. */
function startProc(val: string): PendingProc | null {
  const pid = Number(val);
  return Number.isFinite(pid) ? { pid, comm: "", cwd: "", ports: new Set<number>() } : null;
}

/** A process block still being accumulated by {@link parseLsofFields}. */
interface PendingProc {
  pid: number;
  comm: string;
  cwd: string;
  ports: Set<number>;
}

/** Attach an `n<name>` field to the block: a path when the current fd is `cwd`,
 *  otherwise a listening address whose port we extract. */
function applyName(cur: PendingProc, val: string, fdIsCwd: boolean): void {
  if (fdIsCwd) {
    cur.cwd = val;
    return;
  }
  const port = parseListenPort(val);
  if (port !== null) cur.ports.add(port);
}

/** Freeze an accumulated block into its public shape (ports sorted + deduped). */
function finishProc(cur: PendingProc): LsofProc {
  return {
    pid: cur.pid,
    comm: cur.comm,
    cwd: cur.cwd,
    ports: [...cur.ports].sort((a, b) => a - b),
  };
}

/** Extract the port from an lsof listening-address name: `*:5173`,
 *  `127.0.0.1:8384`, `[::1]:3000`. Returns null when no valid port is present. */
function parseListenPort(name: string): number | null {
  const colon = name.lastIndexOf(":");
  if (colon === -1) return null;
  const port = Number(name.slice(colon + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** Async runner for the `lsof` spawn. Resolves stdout even on a non-zero exit that
 *  still produced output (lsof exits 1 when a search term matches nothing); rejects
 *  only on a spawn error or the hard timeout. Injectable so tests never spawn. */
export type LsofRunner = () => Promise<string>;

const defaultRunner: LsofRunner = () =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "lsof",
      [...LSOF_ARGV],
      { timeout: REFRESH_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        // A non-zero exit WITH stdout is a normal lsof outcome, not a failure.
        if (stdout && stdout.length > 0) return resolve(stdout);
        if (err) return reject(err);
        resolve(stdout ?? "");
      },
    );
  });

export interface DarwinProbeOptions {
  /** Injectable `lsof` runner (default: real spawn). */
  run?: LsofRunner;
  /** Injectable clock for the snapshot cell (default: Date.now). */
  now?: () => number;
  /** Forced-refresh wait budget (default: FORCE_WAIT_BUDGET_MS); injectable so the
   *  cap is testable without a multi-second wait. */
  budgetMs?: number;
}

interface Cell {
  /** Last successfully parsed snapshot, keyed by pid. `null` until the first
   *  success; a failed refresh never overwrites it. */
  procs: Map<number, LsofProc> | null;
  /** Instant the last SUCCESSFUL refresh STARTED (when `lsof` began sampling), not
   *  its completion — completion-stamping would report ~0 age for sample-duration-
   *  old data. `null` until the first success. */
  successAt: number | null;
  /** Instant of the last attempt either way; rate-limits retries + the failure warn. */
  attemptAt: number;
}

/** Age past which the cell may no longer support a NEGATIVE verdict ("nothing is
 *  there"): the worst-case age of a HEALTHY cell at read time — two sweep cadences
 *  of margin, plus a full refresh timeout, plus one poller tick. */
function maxNegativeAgeMs(): number {
  return 2 * config.previewSweepMs + REFRESH_TIMEOUT_MS + POLLER_TICK_MS;
}

/** Coalescing window — how long before issuing another (non-forced) refresh is
 *  worth it. A spawn-rate control only; never a correctness gate. */
function refreshTtlMs(): number {
  return Math.max(250, Math.floor(config.previewSweepMs / 2));
}

let warnedClampOnce = false;

/** The darwin backend always supplies the snapshot-cell members, so callers (and
 *  tests) can use them without optional-chaining, unlike the base interface where
 *  they are optional for the Linux/live-`/proc` backends. */
export type DarwinProbes = ReaperProbes &
  Required<Pick<ReaperProbes, "refresh" | "snapshotState" | "normalizeRoot">>;

/**
 * Construct a darwin `ReaperProbes` backend over a single memoised `lsof` snapshot.
 *
 * The cell is PER-INSTANCE (closure state), never a module global, so two backends
 * never share state — the integration test constructs one explicitly. The
 * synchronous probe methods (`scanProcs`, `portsForPid`, …) only ever read the
 * cell; only `refresh()` spawns, asynchronously.
 */
export function makeDarwinProbes(opts: DarwinProbeOptions = {}): DarwinProbes {
  const run = opts.run ?? defaultRunner;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? FORCE_WAIT_BUDGET_MS;
  const rootCache = new Map<string, string>();

  // `attemptAt: -Infinity` (not 0) so the FIRST refresh always passes the coalescing
  // window regardless of the clock's magnitude — an injected test clock starting at
  // a small value would otherwise fall inside `now() - 0 < refreshTtlMs`.
  const cell: Cell = { procs: null, successAt: null, attemptAt: -Infinity };
  let inFlight: Promise<void> | null = null;
  let forcedInFlight: Promise<void> | null = null;
  let lastFailWarnAt = -Infinity;

  if (!warnedClampOnce && !(refreshTtlMs() < maxNegativeAgeMs())) {
    warnedClampOnce = true;
    console.warn(
      `[proc-probes-darwin] refreshTtlMs (${refreshTtlMs()}ms) is not below ` +
        `maxNegativeAgeMs (${maxNegativeAgeMs()}ms) — snapshots may be reused across ` +
        `sweeps; lower SHEPHERD_PREVIEW_SWEEP_MS is set unusually high.`,
    );
  }

  function snapshotState(): "none" | "stale" | "fresh" {
    if (cell.procs === null || cell.successAt === null) return "none";
    return now() - cell.successAt > maxNegativeAgeMs() ? "stale" : "fresh";
  }

  /** Run one refresh cycle: spawn `lsof`, parse, write the cell on success. A
   *  failure (throw/timeout) touches neither `procs` nor `successAt`. */
  async function doRefresh(): Promise<void> {
    const startedAt = now();
    cell.attemptAt = startedAt;
    let stdout: string;
    try {
      stdout = await run();
    } catch (err) {
      // Throttled: on a host with a permanently missing/broken `lsof` every sweep
      // retries, so an unthrottled warn would flood the log forever.
      if (startedAt - lastFailWarnAt >= FAIL_WARN_INTERVAL_MS) {
        lastFailWarnAt = startedAt;
        console.warn(`[proc-probes-darwin] lsof refresh failed: ${String(err)}`);
      }
      return;
    }
    const procs = new Map<number, LsofProc>();
    for (const p of parseLsofFields(stdout)) procs.set(p.pid, p);
    cell.procs = procs;
    cell.successAt = startedAt; // START stamp — see Cell.successAt
    rootCache.clear();
  }

  /** Non-forced refresh: coalesce on the TTL, single-flight on the in-flight promise.
   *  The TTL gates on the last ATTEMPT (not the last success), so a host whose `lsof`
   *  always fails retries at most once per window rather than spawning every tick. */
  function coalescedRefresh(): Promise<void> {
    if (inFlight) return inFlight;
    if (now() - cell.attemptAt < refreshTtlMs()) {
      return Promise.resolve();
    }
    const p = doRefresh().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  }

  /** Forced refresh: chain behind any in-flight refresh, then issue one more, so
   *  the data provably post-dates the call — but cap the caller's wait at
   *  `budgetMs`, falling back to the existing cell if the chain runs long. The
   *  background chain still updates the cell when it lands. Concurrent forced
   *  callers SHARE one chained run (`forcedInFlight`), so N overlapping forced
   *  calls issue exactly one extra spawn, not N. */
  function forcedRefresh(): Promise<void> {
    if (!forcedInFlight) {
      forcedInFlight = (async () => {
        if (inFlight) {
          try {
            await inFlight;
          } catch {
            /* previous cycle's failure is already logged; issue a fresh one */
          }
        }
        const p = doRefresh().finally(() => {
          if (inFlight === p) inFlight = null;
        });
        inFlight = p;
        await p;
      })().finally(() => {
        forcedInFlight = null;
      });
    }
    const chain = forcedInFlight;
    let timer: ReturnType<typeof setTimeout>;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    });
    return Promise.race([chain, budget]).then(() => {
      clearTimeout(timer);
    });
  }

  return {
    scanProcs() {
      if (cell.procs === null) return [];
      return [...cell.procs.values()].map((p) => ({ pid: p.pid, cwd: p.cwd, comm: p.comm }));
    },
    portsForPid(pid) {
      return cell.procs?.get(pid)?.ports ?? [];
    },
    // `listeningPorts` deliberately OMITTED — see the module header. Its absence
    // makes `ProcessReaper.scanSystemSideEffects` skip class-3 detection (returns []).
    readTranscript() {
      // Class-3 transcript scanning depends on `listeningPorts`, which darwin omits,
      // so no caller reads this on darwin. Return "" to keep the interface total.
      return "";
    },
    killPid() {
      // Never reached: `canAuthorizeSignal` is false, so `stopListenersOnPort`
      // refuses before signalling and the orphan reaps are no-ops (no `ppidForPid`).
    },
    run() {
      // Counter-commands are class-3 only; unreachable on darwin (see readTranscript).
    },
    listPids() {
      return cell.procs === null ? [] : [...cell.procs.keys()];
    },
    commForPid(pid) {
      return cell.procs?.get(pid)?.comm ?? "";
    },
    cwdForPid(pid) {
      return cell.procs?.get(pid)?.cwd ?? null;
    },
    normalizeRoot(path) {
      const cached = rootCache.get(path);
      if (cached !== undefined) return cached;
      let resolved: string;
      try {
        // Resolve /tmp→/private/tmp, /var→/private/var so a stored worktree root
        // compares equal to lsof's kernel-resolved `fcwd` path.
        resolved = realpathSync(path);
      } catch {
        resolved = path; // a gone path can't match a live process's cwd anyway
      }
      rootCache.set(path, resolved);
      return resolved;
    },
    canAuthorizeSignal: false,
    snapshotState,
    refresh(o) {
      return o?.force ? forcedRefresh() : coalescedRefresh();
    },
  };
}

/** Basename an `lsof`/`ps` command field so it matches the Linux `/proc/<pid>/comm`
 *  basename semantics `AGENT_COMMS`/`isGitComm` are written around. Exported for the
 *  darwin-only CI equivalence assertion. */
export function commBasename(comm: string): string {
  return comm.includes("/") ? basename(comm) : comm;
}
