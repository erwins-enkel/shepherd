import { readdirSync, readlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "./instrument";
import { jsonlPathFor } from "./usage";
import { eachJsonlObject } from "./jsonl";
import { makeDarwinProbes } from "./proc-probes-darwin";

// ── leftover detection ──────────────────────────────────────────────────────
// When a session is decommissioned we stop the Claude agent + remove its worktree,
// but anything the agent spun up out-of-band keeps running. Three classes:
//   1. children of the agent (run_in_background bash, stdio MCP) — die WITH the
//      agent, so we never touch them.
//   2. detached processes living in the worktree (Vite / `bun run dev`) — survive,
//      found by scanning /proc for a cwd under the worktree that also LISTENS on a
//      port (the listening-port test is what tells a persistent server apart from a
//      transient agent child; servers listen, one-shot children don't).
//   3. system side-effects (`tailscale serve --bg` — its own daemon, often root) —
//      survive, found by scanning the transcript for the launching command and
//      derived back to a counter-command. Only offered when the port still LISTENS,
//      so a server the user already killed by hand isn't falsely surfaced.

export type LeftoverKind = "process" | "system";

export interface Leftover {
  kind: LeftoverKind;
  /** display name, e.g. "vite", "tailscale serve" */
  name: string;
  /** listening port, when known */
  port: number | null;
  /** stable key for round-tripping a selection back to the server */
  key: string;
  /** present for kind "process": the pid to kill */
  pid?: number;
  /** present for kind "system": the counter-command to run */
  command?: { bin: string; args: string[] };
}

/** Low-level probes, injectable so the reaper is unit-testable without real /proc. */
export interface ReaperProbes {
  /** Every process with its cwd + comm (name). Cheap — no per-pid fd reads. */
  scanProcs(): { pid: number; cwd: string; comm: string }[];
  /** Listening TCP ports owned by a single pid (reads its fd table). */
  portsForPid(pid: number): number[];
  /**
   * All locally-listening TCP ports (for the class-3 counter-check). OPTIONAL:
   * the Linux backend reads the world-readable /proc/net/tcp (uid-agnostic, so it
   * sees a root-owned `tailscaled` listener); the darwin backend omits it because
   * a non-root `lsof` cannot. When absent, `scanSystemSideEffects` skips the
   * port-verification filter and offers NO class-3 leftovers (fail closed).
   */
  listeningPorts?(): Set<number>;
  /** Transcript text for a path; "" when missing/unreadable. */
  readTranscript(path: string): string;
  /** Terminate a pid (defaults to SIGTERM). */
  killPid(pid: number, signal?: NodeJS.Signals): void;
  /** Run a counter-command. */
  run(bin: string, args: string[]): void;
  /**
   * Build the full listening inode→port map from /proc/net/tcp[6].
   * Optional: used by `scanListeningPortsByWorktree` to build the map ONCE per sweep
   * rather than re-building it per-PID. Falls back to `portsForPid` when absent.
   */
  inodeToPortMap?(): Map<number, number>;
  /**
   * Return the socket inodes owned by a single pid (reads its fd table).
   * Optional: used alongside `inodeToPortMap` for the single-map batched scan.
   * Falls back to `portsForPid` when absent.
   */
  socketInodesForPid?(pid: number): number[];
  /**
   * Parent pid for a single process (the `PPid:` field of /proc/<pid>/status), or
   * null when unreadable. Used by the orphan sweeps to recognise a process the
   * kernel has reparented to PID 1 (its launching shell exited) — the load-bearing
   * "this is an orphan, not a live child" signal. Optional + read per-candidate so
   * the hot scanProcs() pollers never pay for it.
   */
  ppidForPid?(pid: number): number | null;
  /**
   * Every pid on the host, straight from /proc's numeric dirents. Deliberately NOT `scanProcs`:
   * that one silently `continue`s past any pid whose /proc/<pid>/cwd readlink fails, and the
   * runaway sweep must not depend on a readable cwd (it attributes by environ, not by directory).
   * Optional + fail-closed: absent ⇒ the sweep reaps nothing.
   */
  listPids?(): number[];
  /** A single process's comm (name), or "" when unreadable. */
  commForPid?(pid: number): string;
  /**
   * A single process's environment, parsed from the NUL-separated /proc/<pid>/environ, or null when
   * unreadable (process gone, or not ours). Read LAST in the sweep: unlike comm/stat this goes
   * through access_remote_vm and takes the TARGET's mmap lock, so it can block on a stalled process.
   */
  environForPid?(pid: number): Record<string, string> | null;
  /**
   * CPU accounting + start time from /proc/<pid>/stat, in USER_HZ ticks. Null when unreadable.
   * `cutime`/`cstime` are the CPU of already-REAPED children — load-bearing, see cpuBusyFraction.
   */
  cpuStatForPid?(pid: number): CpuStat | null;
  /** System uptime in seconds (/proc/uptime), or null when unreadable. */
  uptimeSeconds?(): number | null;
  /** A process's cwd, for the log line only — never a gate. Null when unreadable. */
  cwdForPid?(pid: number): string | null;
  // ── snapshot-cell backends (darwin) ────────────────────────────────────────
  /**
   * Rebuild the backing snapshot. No-op for the Linux backend and test fakes
   * (they read live /proc, so there is nothing to refresh). `force` bypasses the
   * coalescing window and chains behind any in-flight refresh, capped so it never
   * blocks a caller unboundedly. Absent ⇒ treated as an immediate no-op.
   */
  refresh?(opts?: { force?: boolean }): Promise<void>;
  /**
   * Freshness of the backing snapshot: `"none"` (never successfully refreshed),
   * `"stale"` (older than the negative-verdict bound), `"fresh"`. Absent ⇒
   * `"fresh"` (Linux/fakes read live /proc, so their data is never stale).
   */
  snapshotState?(): "none" | "stale" | "fresh";
  /**
   * Is anything currently driving refreshes of the backing snapshot? Absent ⇒ true
   * (Linux/fakes read live `/proc`, so they are never "undriven"). A snapshot
   * backend goes undriven on an idle host — the poller only refreshes when some
   * session has a worktree — which is expected, not a fault. Lets the Diagnose row
   * separate "nobody asked recently" from "asked, and it's lagging".
   */
  refreshAttemptedRecently?(): boolean;
  /**
   * Normalise a stored worktree root before comparing it against probe-reported
   * cwds. Absent ⇒ identity (Linux `/proc/<pid>/cwd` is already canonical). The
   * darwin backend realpaths, because lsof's `fcwd` is the kernel-resolved path
   * (`/tmp`→`/private/tmp`, `/var`→`/private/var`) while stored roots are not.
   */
  normalizeRoot?(path: string): string;
  /**
   * May this backend's data authorize a SIGTERM/SIGKILL? Absent ⇒ true (Linux
   * verifies pid→cwd→port at the instant of the signal via live /proc reads). The
   * darwin backend sets this false: its data is a snapshot, and macOS exposes no
   * cheap pid-recycle fingerprint, so `stopListenersOnPort` refuses instead.
   */
  canAuthorizeSignal?: boolean;
}

/** Raw CPU accounting for one process, in USER_HZ ticks (see {@link USER_HZ}). */
export interface CpuStat {
  utime: number;
  stime: number;
  /** CPU of reaped children — what makes a `wait()`-blocked supervisor shell visible. */
  cutime: number;
  cstime: number;
  /** Ticks since boot at which the process started. Doubles as a pid-recycle fingerprint. */
  starttime: number;
}

/**
 * The `sysconf(_SC_CLK_TCK)` unit that /proc/<pid>/stat reports its times in — NOT the kernel's
 * internal `HZ`. Universally 100 on Linux, and Node/Bun expose no `sysconf`, so it is hardcoded.
 */
export const USER_HZ = 100;

/**
 * Env var stamped on every agent spawn (issue #1144), inherited by every process the agent ever
 * spawns. `/proc/<pid>/environ` is fixed at exec, so the marker survives `cd`, backgrounding,
 * PID-1 reparenting and worktree deletion — which is what lets `reapMarkedOrphans` attribute an
 * orphan to a session EXACTLY, rather than guessing from its cwd.
 *
 * ID DOMAIN — load-bearing: the value MUST be a `sessions`-table id, because the reaper resolves it
 * against the store to decide whether the owning session is archived. The aux/satellite spawns
 * (review.ts, plan-gate.ts, doc-agent.ts, standalone-critic.ts — all via `resolveAuxSpawn`) pass a
 * critic/doc-agent id that is NOT a sessions row, so they are deliberately NOT marked: their leaks
 * stay unmarked and are therefore always spared. If they are ever marked, they must use
 * `descriptor.parentSessionId`, never their own id.
 */
export const SESSION_MARKER_ENV = "SHEPHERD_SESSION_ID";

// The agent itself runs `claude` with cwd == worktree; never offer to kill it.
// Exported so the darwin-only CI test can assert lsof's `c` field for a real
// `claude`-named process resolves into this set (the equivalence a fixture can't prove).
export const AGENT_COMMS = new Set(["claude", "codex"]);

/**
 * git spares. An agent's `git fetch` triggers a detached `git gc --auto` (gc.autoDetach defaults on)
 * which INHERITS the session marker, is non-listening, and runs at ~100% CPU from birth on a large
 * repo — it clears every other gate. SIGKILLing it strands a stale `gc.pid` lock, and the repo is
 * then never gc'd again.
 *
 * `/proc/<pid>/comm` is kernel-truncated to TASK_COMM_LEN-1 = 15 chars, so `git-pack-objects` (16)
 * surfaces as `git-pack-object` and can never match an exact entry — the `git-` PREFIX rule below is
 * what actually covers it. The exact set is kept for the names that do fit.
 */
const GIT_COMMS = new Set(["git", "git-gc", "git-repack", "git-maintenance"]);

function isGitComm(comm: string): boolean {
  return GIT_COMMS.has(comm) || comm.startsWith("git-");
}

// Path segment every shepherd session/review worktree lives under. The orphan
// sweeps refuse to act on any path lacking it, so a mistaken caller passing a repo
// root (or any non-worktree path) can never SIGKILL unrelated host processes.
// Exported so the tmp-sweep worktree reaper shares the exact same marker rather
// than forking the definition.
export const WORKTREE_MARKER = "/.shepherd-worktrees/";

// readlink(/proc/<pid>/cwd) appends this once the directory is unlinked; the kernel
// keeps the inode alive for the still-running process. A "(deleted)" cwd under the
// worktree marker is the unambiguous signal of an orphan whose worktree is already gone.
const DELETED_SUFFIX = " (deleted)";

/** Stable selection key — lets the client echo a choice back without trusting raw pids. */
export function leftoverKey(l: Pick<Leftover, "kind" | "name" | "port" | "pid">): string {
  return l.kind === "process" ? `process:${l.pid}` : `system:${l.name}:${l.port ?? ""}`;
}

/** Segment-aligned containment: `path` is `root` itself or lives under it. Exported
 *  so the tmp-sweep reaper reuses the same idiom (a `startsWith` without the `/`
 *  guard would treat `/a/bc` as under `/a/b`). */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/** Canonical worktree root for comparison against probe-reported cwds: trailing
 *  slashes stripped, then `probes.normalizeRoot` applied (identity on Linux;
 *  realpath on darwin, where lsof reports the kernel-resolved cwd). */
function normRoot(worktreePath: string, probes: ReaperProbes): string {
  const stripped = worktreePath.replace(/\/+$/, "");
  return probes.normalizeRoot ? probes.normalizeRoot(stripped) : stripped;
}

// ── class-3 transcript heuristic ────────────────────────────────────────────

/** Yield every Bash tool command recorded in a Claude JSONL transcript. */
function* bashCommands(text: string): Iterable<string> {
  for (const o of eachJsonlObject(text)) {
    const rec = o as { message?: { content?: unknown } } | undefined;
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (
        item?.type === "tool_use" &&
        item?.name === "Bash" &&
        typeof item?.input?.command === "string"
      ) {
        yield item.input.command as string;
      }
    }
  }
}

/**
 * Map a launching command to a system leftover + its counter-command. Only the
 * `tailscale serve --bg` proxy qualifies today: it backgrounds its own daemon
 * (no cwd in the worktree), so the cwd scan can't see it — but the transcript can,
 * and `tailscale serve --https=<port> off` reverses it.
 */
function systemLeftoverFor(cmd: string): Omit<Leftover, "key"> | null {
  if (!/\btailscale\s+serve\b/.test(cmd) || !/--bg\b/.test(cmd)) return null;
  const m = cmd.match(/--https[=\s]+(\d+)/);
  if (!m) return null;
  const port = Number(m[1]);
  return {
    kind: "system",
    name: "tailscale serve",
    port,
    command: { bin: "tailscale", args: ["serve", `--https=${port}`, "off"] },
  };
}

function scanTranscript(text: string): Leftover[] {
  const byKey = new Map<string, Leftover>();
  for (const cmd of bashCommands(text)) {
    const hit = systemLeftoverFor(cmd);
    if (!hit) continue;
    const key = leftoverKey(hit);
    if (!byKey.has(key)) byKey.set(key, { ...hit, key });
  }
  return [...byKey.values()];
}

// ── default probes (real /proc + child_process) ─────────────────────────────

/** Parse /proc/net/tcp[6] into a map of socket inode → listening local port. */
function listeningInodeToPort(): Map<number, number> {
  const map = new Map<number, number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue; // 0A == TCP_LISTEN
      const port = parseInt(f[1]!.split(":")[1] ?? "", 16);
      const inode = Number(f[9]);
      if (Number.isFinite(port) && Number.isFinite(inode)) map.set(inode, port);
    }
  }
  return map;
}

/** Read a process's parent pid from the `PPid:` line of /proc/<pid>/status. */
function readPpid(pid: number): number | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return null; // process gone, or not ours to inspect
  }
  const m = text.match(/^PPid:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

/** Every numeric dirent under /proc — i.e. every pid on the host. */
function readPids(): number[] {
  try {
    return readdirSync("/proc")
      .filter((e) => /^\d+$/.test(e))
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * Parse /proc/<pid>/stat.
 *
 * The comm field (2) is wrapped in parens AND may itself contain spaces and parens — e.g. a process
 * named `foo (bar)`. So the only safe split point is the LAST ')': everything after it is field 3
 * onward, whitespace-separated. Fields (1-indexed): 14 utime, 15 stime, 16 cutime, 17 cstime,
 * 22 starttime — which land at offsets 11, 12, 13, 14 and 19 of that remainder.
 */
function readCpuStat(pid: number): CpuStat | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // process gone, or not ours to inspect
  }
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const f = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const at = (i: number) => Number(f[i]);
  const stat = {
    utime: at(11),
    stime: at(12),
    cutime: at(13),
    cstime: at(14),
    starttime: at(19),
  };
  return Object.values(stat).every(Number.isFinite) ? stat : null;
}

/** Parse the NUL-separated /proc/<pid>/environ into a map. */
function readEnviron(pid: number): Record<string, string> | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return null; // process gone, or not ours to inspect
  }
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** System uptime in seconds — the first field of /proc/uptime. */
function readUptimeSeconds(): number | null {
  try {
    const n = Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Read the socket inodes held open by a single process from /proc/<pid>/fd. */
function readSocketInodes(pid: number): number[] {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const inodes: number[] = [];
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const m = target.match(/^socket:\[(\d+)\]$/);
    if (m) inodes.push(Number(m[1]));
  }
  return inodes;
}

const linuxProbes: ReaperProbes = {
  scanProcs() {
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
    const out: { pid: number; cwd: string; comm: string }[] = [];
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      const pid = Number(e);
      let cwd: string;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        continue; // process gone, or not ours to inspect
      }
      let comm = "";
      try {
        comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      } catch {
        /* keep empty */
      }
      out.push({ pid, cwd, comm });
    }
    return out;
  },
  portsForPid(pid) {
    const listen = listeningInodeToPort();
    const ports = readSocketInodes(pid)
      .map((inode) => listen.get(inode))
      .filter((p): p is number => p != null);
    return [...new Set(ports)].sort((a, b) => a - b);
  },
  listeningPorts() {
    return new Set(listeningInodeToPort().values());
  },
  inodeToPortMap() {
    return listeningInodeToPort();
  },
  socketInodesForPid(pid) {
    return readSocketInodes(pid);
  },
  ppidForPid(pid) {
    return readPpid(pid);
  },
  listPids() {
    return readPids();
  },
  commForPid(pid) {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      return "";
    }
  },
  environForPid(pid) {
    return readEnviron(pid);
  },
  cpuStatForPid(pid) {
    return readCpuStat(pid);
  },
  uptimeSeconds() {
    return readUptimeSeconds();
  },
  cwdForPid(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  readTranscript(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  },
  killPid(pid, signal) {
    process.kill(pid, signal);
  },
  run(bin, args) {
    execFileSync(bin, args, { stdio: "ignore" });
  },
};

/**
 * Probes for an unsupported platform (Windows, etc.): every read is empty AND
 * `snapshotState()` reports `"none"`, so the `| null`-returning scan helpers return
 * `null` ("unknown") rather than an all-`false` map. Without the `snapshotState`
 * declaration the "absent ⇒ fresh" default would apply, and the fail-open sweeps
 * (`reapStaleReviewWorktrees`, `reapAbandonedWorktrees`) would treat empty data as
 * "nothing alive" and delete worktrees / disable their live-cwd guard. `false`
 * `canAuthorizeSignal` keeps `stopListenersOnPort` a no-op there too.
 */
const nullProbes: ReaperProbes = {
  scanProcs: () => [],
  portsForPid: () => [],
  readTranscript: () => "",
  killPid: () => {},
  run: () => {},
  listPids: () => [],
  commForPid: () => "",
  cwdForPid: () => null,
  snapshotState: () => "none",
  canAuthorizeSignal: false,
  refresh: () => Promise.resolve(),
};

/**
 * Select the probe backend for a platform. Exported as a PURE selector so the
 * darwin/linux/win32 branches are assertable without touching the module-level
 * default (which is built once at import time, so `process.platform` can never be
 * re-read in a test). `linuxProbes` reads /proc live; `makeDarwinProbes()` runs an
 * `lsof`-backed snapshot cell; anything else gets `nullProbes`.
 */
export function makeDefaultProbes(platform: NodeJS.Platform = process.platform): ReaperProbes {
  if (platform === "linux") return linuxProbes;
  if (platform === "darwin") return makeDarwinProbes();
  return nullProbes;
}

/** The module default: dispatched once for this host. */
const defaultProbes: ReaperProbes = makeDefaultProbes();

/**
 * A snapshot of every same-uid process's current working directory (raw
 * `/proc/<pid>/cwd` readlink targets), reusing the existing synchronous
 * `scanProcs` /proc scan. `readlink` on another user's process yields `EACCES`
 * and is skipped by `scanProcs` — so this is a same-uid guarantee, not absolute.
 *
 * SYNCHRONOUS by design: the tmp-sweep worktree reaper's live-cwd refusal needs
 * this signal, but that module is all-async — so the caller (`fireTmpSweep`) takes
 * ONE deferred snapshot here and passes the resolved set in, keeping the sync
 * `/proc` walk out of the async module. A deleted cwd carries a `" (deleted)"`
 * suffix; that never resolves to an on-disk worktree, so it is harmless noise the
 * reaper's realpath step drops.
 *
 * Returns `null` when the snapshot backend cannot support a negative verdict
 * (`snapshotState()` is `"none"`/`"stale"`, i.e. darwin with no successful recent
 * `lsof`). The tmp-sweep live-cwd guard is FAIL-OPEN — an empty array refuses
 * nothing — so the caller MUST treat `null` as "unknown, skip the reap" rather
 * than defaulting to `[]`, or it would silently delete worktrees whose live cwd
 * it cannot see.
 */
export function liveProcCwds(probes: ReaperProbes = defaultProbes): string[] | null {
  if (probes.snapshotState && probes.snapshotState() !== "fresh") return null;
  return probes.scanProcs().map((p) => p.cwd);
}

export class ProcessReaper {
  constructor(private probes: ReaperProbes = defaultProbes) {}

  /** Detect surviving leftovers for a session (classes 2 + 3). */
  detect(s: {
    worktreePath: string;
    claudeSessionId: string;
    isolated: boolean;
    spawnAccountDir?: string | null;
  }): Leftover[] {
    // Non-isolated sessions never got a private worktree — their `worktreePath` IS
    // the shared repo root, where the shepherd server itself (and other unrelated
    // long-running servers) are rooted. A cwd scan there flags processes that merely
    // share the dir, not ones the session launched, so skip class 2 entirely.
    const procs = s.isolated ? this.scanWorktreeProcs(s.worktreePath) : [];
    return [...procs, ...this.scanSystemSideEffects(s)];
  }

  /** Class 2 — processes living in the worktree that listen on a port. */
  private scanWorktreeProcs(worktreePath: string): Leftover[] {
    // A backend that cannot authorize a signal (darwin) also cannot HONOUR one:
    // `reap()` calls `probes.killPid`, which is a no-op there. Offering class-2
    // leftovers anyway would list them under "Terminate & close", kill nothing, and
    // still report `reaped = hit.length` (SessionService.archive) as if it had —
    // strictly worse than the pre-#1912 behaviour, where an empty `scanProcs` meant
    // nothing was ever offered. So fail closed, exactly as class-3 does when
    // `listeningPorts` is absent. Re-enabling this is part of arming the kill path
    // (#1922), which needs a recycle fingerprint before it can signal safely.
    if (this.probes.canAuthorizeSignal === false) return [];
    const root = normRoot(worktreePath, this.probes);
    const out: Leftover[] = [];
    for (const p of this.probes.scanProcs()) {
      // Never offer to reap ourselves: the shepherd server runs in the worktree's
      // own repo and listens on a port, so without this it could surface itself.
      if (p.pid === process.pid) continue;
      if (!isUnder(p.cwd, root) || AGENT_COMMS.has(p.comm)) continue;
      const ports = this.probes.portsForPid(p.pid);
      if (ports.length === 0) continue; // no listener ⇒ a transient child, not a server
      out.push({
        kind: "process",
        name: p.comm || `pid ${p.pid}`,
        port: ports[0]!,
        pid: p.pid,
        key: leftoverKey({ kind: "process", name: p.comm, port: ports[0]!, pid: p.pid }),
      });
    }
    return out;
  }

  /** Class 3 — system side-effects scraped from the transcript, port-verified. */
  private scanSystemSideEffects(s: {
    worktreePath: string;
    claudeSessionId: string;
    spawnAccountDir?: string | null;
  }): Leftover[] {
    if (!s.claudeSessionId) return [];
    const text = this.probes.readTranscript(
      jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir),
    );
    if (!text) return [];
    // No `listeningPorts` probe (darwin) ⇒ class-3 detection is not implemented on
    // this backend. Fail closed: offer NO leftovers rather than surface a
    // `tailscale serve … off` counter-command for a mapping we cannot verify is
    // still live. Matches today's macOS behaviour (empty /proc → empty filter).
    if (!this.probes.listeningPorts) return [];
    const listening = this.probes.listeningPorts();
    // drop any whose port no longer listens — already stopped by hand
    return scanTranscript(text).filter((hit) => hit.port == null || listening.has(hit.port));
  }

  /**
   * Signal every process under `worktreePath` that is currently listening on
   * exactly `port`, to terminate it. Excludes the shepherd process itself and
   * the `claude` agent. Returns the count of processes signalled (a signals-SENT
   * count — NOT a death confirmation; a process may ignore the signal or take
   * time to exit). Used by preview stop (idle-stop sends SIGTERM then escalates
   * to SIGKILL; force-stop sends SIGKILL).
   *
   * SCOPE: only the process actually LISTENING on `port` is signalled — that is
   * the RAM-heavy bundler/server (Vite/Next/esbuild/node), so the bulk of memory
   * is reclaimed. A lightweight parent WRAPPER that merely spawned it (e.g.
   * `npm run dev` → vite) is not under this port and may linger holding its own
   * (small) footprint until the agent's shell reaps it. We deliberately don't
   * walk the process tree: the wrapper is often the agent's own backgrounded job,
   * and killing up the tree risks disrupting the agent's pane/job control — the
   * exact harm the opt-in, agent-idle-gated design avoids.
   *
   * Returns `{ signalled, unsupported }`. `unsupported` is true when the backend
   * cannot authorize a signal (`canAuthorizeSignal === false`, i.e. darwin): its
   * data is a snapshot and macOS has no cheap pid-recycle fingerprint, so a
   * SIGKILL could hit a recycled pid. In that case NOTHING is signalled and the
   * caller (idle-stop escalation) must not advance its ladder — see
   * `StatusPoller.escalateIdleStop`. The Linux backend never sets `unsupported`.
   */
  stopListenersOnPort(
    worktreePath: string,
    port: number,
    signal: NodeJS.Signals = "SIGTERM",
  ): { signalled: number; unsupported: boolean } {
    if (this.probes.canAuthorizeSignal === false) {
      return { signalled: 0, unsupported: true };
    }
    const root = normRoot(worktreePath, this.probes);
    let count = 0;
    for (const proc of this.probes.scanProcs()) {
      if (proc.pid === process.pid) continue;
      if (!isUnder(proc.cwd, root) || AGENT_COMMS.has(proc.comm)) continue;
      const ports = this.probes.portsForPid(proc.pid);
      if (!ports.includes(port)) continue;
      try {
        this.probes.killPid(proc.pid, signal);
        count++;
      } catch {
        /* best-effort: process may have already exited */
      }
    }
    return { signalled: count, unsupported: false };
  }

  /**
   * Rebuild the backing probe snapshot (darwin only; no-op otherwise). Exposed as
   * a method so it rides the already-injected `deps.reaper` seam — the poller,
   * server handlers and `SessionService` refresh through this rather than importing
   * a module-level default.
   */
  async refresh(opts?: { force?: boolean }): Promise<void> {
    await this.probes.refresh?.(opts);
  }

  /**
   * Can `detect` yield anything at all on this backend? False when BOTH leftover
   * classes are structurally short-circuited: class-2 when the backend cannot
   * authorize a signal (offering un-killable processes would report phantom
   * kills), class-3 when `listeningPorts` is absent (no uid-agnostic listener set
   * to verify against). Both hold on darwin today.
   *
   * Callers use this to skip the refresh-before-`detect` that would otherwise pay a
   * full-host `lsof` scan per session to feed a detector that cannot return a hit.
   * It is a capability question, not a freshness one — keeping it here means the
   * two short-circuit conditions stay in the one file that owns them, and the
   * refresh re-enables itself automatically when #1922 arms the kill path rather
   * than depending on someone remembering to restore it.
   */
  canDetectLeftovers(): boolean {
    const classTwo = this.probes.canAuthorizeSignal !== false;
    const classThree = this.probes.listeningPorts !== undefined;
    return classTwo || classThree;
  }

  /** Health of the backing snapshot, for the Diagnose `preview_probes` row and the
   *  preview-start affordance. A pure cell read — never spawns. `driven` is false
   *  when nothing has asked for a refresh recently (an idle host), which the
   *  Diagnose row treats as "not currently exercised" rather than a fault. */
  health(): { state: "none" | "stale" | "fresh"; driven: boolean } {
    return {
      state: this.probes.snapshotState?.() ?? "fresh",
      driven: this.probes.refreshAttemptedRecently?.() ?? true,
    };
  }

  /**
   * Layer A (worktree teardown): SIGKILL every orphaned (PPID-1) process whose cwd is
   * under `worktreePath`. This is the leak the port-based class-2 detector misses — a
   * detached busy-loop (`yes &`, a load generator) listens on nothing, so the
   * listening-port test never flags it, yet it pegs cores forever once its launching
   * shell exits and reparents it to PID 1 (issue #1133).
   *
   * The PPID-1 filter is the orphan signal: a live agent-managed process has its
   * herdr/PTY as parent, not 1, so this never touches a running child — making it safe
   * at the generic teardown chokepoint regardless of whether the agent was stopped
   * first. `claude`/`codex` and the shepherd server itself are always spared.
   *
   * Defensive precondition: refuses any path not under `/.shepherd-worktrees/`, so a
   * caller that mistakenly passes a repo root cannot sweep unrelated host processes.
   *
   * Returns the count of processes signalled (signals SENT, not deaths confirmed).
   */
  reapOrphansUnder(worktreePath: string): number {
    const root = normRoot(worktreePath, this.probes);
    if (!(root + "/").includes(WORKTREE_MARKER)) return 0;
    let count = 0;
    for (const p of this.probes.scanProcs()) {
      if (p.pid === process.pid || AGENT_COMMS.has(p.comm)) continue;
      if (!isUnder(p.cwd, root)) continue;
      if ((this.probes.ppidForPid?.(p.pid) ?? null) !== 1) continue;
      try {
        this.probes.killPid(p.pid, "SIGKILL");
        count++;
      } catch {
        /* best-effort: process may have already exited */
      }
    }
    return count;
  }

  /**
   * Best-effort terminate each leftover (kill pid / run counter-command).
   *
   * The pid branch is gated on signal authority independently of `detect`. Today
   * `scanWorktreeProcs` already returns [] on a no-authority backend, so a caller
   * that derives leftovers from `detect` (SessionService.archive) can't reach it —
   * but this method is what actually signals, and its keys round-trip through the
   * client, so it refuses on its own rather than trusting an upstream filter. The
   * counter-command branch is NOT gated: it runs `tailscale serve … off`, which
   * targets a port mapping rather than a pid and so has no recycle hazard.
   */
  reap(leftovers: Leftover[]): void {
    const canSignal = this.probes.canAuthorizeSignal !== false;
    for (const l of leftovers) {
      try {
        if (l.kind === "process" && l.pid != null) {
          if (canSignal) this.probes.killPid(l.pid);
        } else if (l.command) this.probes.run(l.command.bin, l.command.args);
      } catch {
        /* best-effort: a process may have already exited */
      }
    }
  }
}

/**
 * Layer B (boot + daily safety net): SIGKILL every orphaned (PPID-1) process whose cwd
 * resolves to an already-DELETED shepherd worktree (`…/.shepherd-worktrees/… (deleted)`).
 *
 * This catches leaks the teardown sweep (`reapOrphansUnder`) could not — anything that
 * leaked before this fix existed, or whose worktree was removed by a path that did not
 * run the teardown sweep. The "(deleted)" cwd + worktree marker + PPID-1 conjunction is
 * unambiguous, so this carries zero false-positive risk: it acts only on processes
 * whose working directory is a gone shepherd worktree and that the kernel has
 * reparented to PID 1. `claude`/`codex` and the shepherd server itself are spared.
 *
 * It deliberately does NOT touch orphans whose worktree still exists on disk (a quiet
 * but possibly-active session) — that needs liveness checks and is out of scope (#1133).
 *
 * Returns the count of processes signalled (signals SENT, not deaths confirmed).
 */
export function reapDeletedWorktreeOrphans(probes: ReaperProbes = defaultProbes): {
  reaped: number;
} {
  let reaped = 0;
  for (const p of probes.scanProcs()) {
    if (p.pid === process.pid || AGENT_COMMS.has(p.comm)) continue;
    if (!p.cwd.endsWith(DELETED_SUFFIX)) continue;
    const realCwd = p.cwd.slice(0, -DELETED_SUFFIX.length);
    if (!(realCwd + "/").includes(WORKTREE_MARKER)) continue;
    if ((probes.ppidForPid?.(p.pid) ?? null) !== 1) continue;
    try {
      probes.killPid(p.pid, "SIGKILL");
      reaped++;
    } catch {
      /* best-effort: process may have already exited */
    }
  }
  return { reaped };
}

// ── #1144: resource-gated reaper for MARKED orphans ──────────────────────────

/** What the store knows about the session a marked process claims to belong to. */
export type SessionTerminality =
  /** row present, `status === 'archived'` — the agent is definitively done. */
  | "archived"
  /** row present, any other status (running/idle/blocked/done, husk, mid-respawn). */
  | "live"
  /** no such row in THIS instance's store. */
  | "absent";

/** A process that cleared every gate (or, in `observe` mode, would have). */
export interface RunawayCandidate {
  pid: number;
  comm: string;
  sessionId: string;
  cwd: string | null;
  /** Lifetime-average fraction of ONE core, incl. reaped children. */
  cpuFraction: number;
  ageSeconds: number;
  /** Recorded for the log only — see the note on PPID below. */
  ppid: number | null;
}

export interface ReapMarkedOptions {
  /**
   * Resolve a marker's session id against the store. MUST THROW (not return "absent") when the
   * store is unavailable — "absent" is a positive claim that no such session exists here, and the
   * sweep treats an unavailable store as a reason to reap NOTHING.
   */
  sessionStatus(id: string): SessionTerminality;
  /**
   * When given, only reap marked processes whose session id is in this set (the teardown call
   * scopes to the just-archived ids). Omitted ⇒ any archived session qualifies (boot/hourly).
   */
  ids?: ReadonlySet<string>;
  mode: "armed" | "observe" | "off";
  /** Lifetime-average fraction of one core (config.reapRunawayMinCpu). */
  minCpu: number;
  /** Minimum process age in seconds (config.reapRunawayMinAgeS). */
  minAgeS: number;
  probes?: ReaperProbes;
}

/**
 * SIGKILL processes an agent left burning a core after its session was archived (issue #1144).
 *
 * WHAT MAKES THIS SAFE is the conjunction of two gates, and ONLY those two:
 *
 *  - PROVENANCE — the process carries {@link SESSION_MARKER_ENV} in its environ, so an *agent*
 *    spawned it. Attribution is exact, not a guess from its cwd: the marker is inherited by every
 *    descendant and survives `cd`, backgrounding, PID-1 reparenting and worktree deletion. An
 *    operator's own `nohup cargo bench &`, their editor's `rust-analyzer`, a stray `ffmpeg` — none
 *    of them carry it, so none of them can EVER be a candidate. Unmarked ⇒ spared. Unreadable ⇒ spared.
 *  - TERMINALITY — the session that owns the marker is PRESENT in the store and `archived`, so its
 *    agent is definitively finished. This is what spares an agent's in-flight `cargo build &`: a
 *    one-shot Bash tool call reparents its background job to PID 1 the moment the call's shell exits,
 *    while the agent is still working. PPID-1 means signal-unmanageable, NOT abandoned.
 *    "absent" ⇒ SPARED: SHEPHERD_DB/SHEPHERD_PORT make a second Shepherd on one host a supported
 *    setup, and reaping on absent would let instance A SIGKILL instance B's LIVE session's work.
 *
 * The CPU + age pair is NOT a safety floor — it is a PERFORMANCE PREFILTER. Reading environ goes
 * through access_remote_vm and takes the target's mmap lock; without a cheap gate in front, an
 * hourly host-wide sweep would take that lock hundreds of times on the event loop, any one of which
 * can block on a stalled process. So the gates run cheapest-first and environ is read LAST, for the
 * handful of hot, old, non-agent, non-git, non-listening survivors. Semantics are unaffected (every
 * gate is conjunctive); only the cost is. It does mean the threshold silently costs coverage (a
 * late-onset spin, or a leak at 60% of a core, is missed) — an accepted trade, see #1144.
 *
 * PPID is deliberately NOT a gate. It is redundant here (an archived session's agent is dead, so a
 * survivor IS an orphan), it would cost coverage (a marked child of a still-live marked wrapper has
 * PPID != 1), and requiring it would make this a no-op in a container where Shepherd is PID 1 and
 * every process reads as PPID-1. It is recorded on the candidate for the log only.
 *
 * LOAD-BEARING TIMING CONSTRAINT — an orphan must be SWEPT BEFORE ITS SESSION ROW IS PRUNED.
 *
 * `archived` is the only status that authorises a kill, and `absent` spares. So a marked orphan is
 * reapable only during the window between its session being archived and its row being deleted.
 * `pruneArchivedSessions` (store.ts) hard-deletes archived rows — the very rows this sweep depends
 * on — so once it runs, that session's surviving orphans are unreapable FOREVER. (An earlier
 * version of this note claimed the invariant was "never hard-delete a row without archiving it
 * first", and cited the prune as satisfying it. That was backwards: the prune deletes only archived
 * rows, so it satisfies that phrasing exactly while causing the failure the note meant to exclude.)
 *
 * What actually guarantees the ordering is CADENCE, not a rule about deletion:
 *   - the sweep runs at teardown (SessionService.archive, synchronously after store.archive), then
 *     hourly;
 *   - the prune runs at most DAILY (runDailySweep) and only past a retention window
 *     (SESSION_RETENTION_DAYS = 30, SESSION_RETENTION_KEEP = 250).
 * So an orphan gets a teardown sweep plus ~24 hourly sweeps before its row is even eligible to be
 * pruned. The margin is enormous, but it is a MARGIN, not a proof — anything that shortens
 * retention toward the sweep interval, or lengthens the sweep interval toward retention, erodes it.
 * Keep the sweep strictly more frequent than the prune.
 *
 * Fails closed throughout: any missing probe, an unreadable environ/stat, or a throwing
 * `sessionStatus` reaps nothing.
 */
/** Everything the per-pid gate chain needs, resolved once per sweep. */
interface SweepContext extends Required<
  Pick<ReapMarkedOptions, "sessionStatus" | "minCpu" | "minAgeS">
> {
  ids: ReadonlySet<string> | undefined;
  probes: ReaperProbes;
  /** System uptime (s), for deriving each process's age from its starttime. */
  uptime: number;
  /** True when the pid holds any listening socket. Builds its inode→port map at most once. */
  isListening(pid: number): boolean;
}

/** A candidate plus the `starttime` that fingerprints it, for the pre-kill recycle check. */
interface Scanned {
  candidate: RunawayCandidate;
  starttime: number;
}

/**
 * The gate chain for ONE pid, cheapest-first — see {@link reapMarkedOrphans} for why the order
 * matters and why provenance + terminality (and NOT the CPU gate, and NOT PPID) are what make this
 * safe. Returns null the moment any gate rejects, so the expensive reads are never reached for the
 * overwhelming majority of pids.
 */
function scanPid(pid: number, ctx: SweepContext): Scanned | null {
  const { probes, uptime, minAgeS, minCpu, ids } = ctx;
  if (pid === process.pid) return null; // never reap the server itself

  // ── cheap gates first: one comm read, one stat read ────────────────────────
  const comm = probes.commForPid!(pid);
  if (AGENT_COMMS.has(comm) || isGitComm(comm)) return null;

  const stat = probes.cpuStatForPid!(pid);
  if (!stat) return null;

  const ageSeconds = uptime - stat.starttime / USER_HZ;
  if (!(ageSeconds >= minAgeS)) return null; // NaN-safe

  // cutime/cstime (the CPU of already-REAPED children) are load-bearing: a
  // `while true; do <work>; done &` supervisor sits blocked in wait() with its own utime/stime at
  // ~0, while each child burns a core and dies under the age floor. Without these columns the
  // shell falls below the threshold, every child is too young, and the leak is never reaped.
  const cpuSeconds = (stat.utime + stat.stime + stat.cutime + stat.cstime) / USER_HZ;
  const cpuFraction = cpuSeconds / ageSeconds;
  if (!(cpuFraction >= minCpu)) return null;

  // A busy-loop listens on nothing (#1133), so this costs zero coverage on the target class while
  // sparing a marked dev server an agent started (`bun run dev &`).
  if (ctx.isListening(pid)) return null;

  // ── expensive gates last: reading environ takes the TARGET's mmap lock ─────
  const sessionId = probes.environForPid!(pid)?.[SESSION_MARKER_ENV];
  if (!sessionId) return null; // unmarked, or unreadable ⇒ not ours ⇒ spared
  if (ids && !ids.has(sessionId)) return null;

  let terminality: SessionTerminality;
  try {
    terminality = ctx.sessionStatus(sessionId);
  } catch {
    return null; // store unavailable ⇒ terminality unprovable ⇒ spare
  }
  if (terminality !== "archived") return null;

  return {
    starttime: stat.starttime,
    candidate: {
      pid,
      comm,
      sessionId,
      cwd: probes.cwdForPid?.(pid) ?? null,
      cpuFraction,
      ageSeconds,
      ppid: probes.ppidForPid?.(pid) ?? null,
    },
  };
}

export function reapMarkedOrphans(opts: ReapMarkedOptions): {
  reaped: number;
  /** Everything that cleared every gate — in `observe` mode, what WOULD have been killed. */
  observed: RunawayCandidate[];
  /**
   * The subset actually SIGKILLed. Strictly ⊆ `observed`, and smaller whenever the pid-recycle
   * guard fired or `killPid` threw — so callers must log from THIS, not from `observed`, or their
   * per-candidate lines will claim kills that never happened and contradict `reaped`.
   */
  killed: RunawayCandidate[];
} {
  const { sessionStatus, ids, mode, minCpu, minAgeS, probes = defaultProbes } = opts;
  const none = { reaped: 0, observed: [] as RunawayCandidate[], killed: [] as RunawayCandidate[] };
  if (mode === "off") return none;

  // Fail closed: without every probe the gates can't be established, so reap nothing.
  const { listPids, commForPid, environForPid, cpuStatForPid, uptimeSeconds } = probes;
  if (!listPids || !commForPid || !environForPid || !cpuStatForPid || !uptimeSeconds) return none;
  const uptime = uptimeSeconds();
  if (uptime === null) return none;

  // Built at most once per sweep, and only if some pid actually reaches the listening gate.
  let inodeMap: Map<number, number> | null = null;
  const batched =
    typeof probes.inodeToPortMap === "function" && typeof probes.socketInodesForPid === "function";
  const ctx: SweepContext = {
    sessionStatus,
    ids,
    minCpu,
    minAgeS,
    probes,
    uptime,
    isListening: (pid) => {
      if (!batched) return probes.portsForPid(pid).length > 0;
      inodeMap ??= probes.inodeToPortMap!();
      return probes.socketInodesForPid!(pid).some((inode) => inodeMap!.has(inode));
    },
  };

  const observed: RunawayCandidate[] = [];
  const killed: RunawayCandidate[] = [];

  for (const pid of listPids()) {
    const hit = scanPid(pid, ctx);
    if (!hit) continue;
    observed.push(hit.candidate);
    if (mode !== "armed") continue;

    // Pid-recycle guard: between the scan above and the kill below, the pid may have been recycled
    // onto an unrelated process. starttime is the kernel's own fingerprint for "still the same one".
    const recheck = cpuStatForPid(pid);
    if (!recheck || recheck.starttime !== hit.starttime) continue;

    try {
      probes.killPid(pid, "SIGKILL");
      killed.push(hit.candidate);
    } catch {
      /* best-effort: the process may have exited between the re-check and here */
    }
  }

  return { reaped: killed.length, observed, killed };
}

// ── batched port scan ─────────────────────────────────────────────────────────

/** Find the first worktree path whose normalised root contains `cwd`, or null. */
function matchWorktreePath(cwd: string, roots: string[], paths: string[]): string | null {
  for (let i = 0; i < roots.length; i++) {
    if (isUnder(cwd, roots[i]!)) return paths[i]!;
  }
  return null;
}

/**
 * Resolve listening ports for a single PID.
 * Uses the batched path (inode→port map + socketInodesForPid) when `inodeMap`
 * is non-null; otherwise falls back to `probes.portsForPid`.
 * Supply both `inodeToPortMap` + `socketInodesForPid` or neither.
 */
function portsForProcBatched(
  pid: number,
  inodeMap: Map<number, number> | null,
  probes: ReaperProbes,
): number[] {
  if (inodeMap !== null) {
    return probes.socketInodesForPid!(pid)
      .map((inode) => inodeMap.get(inode))
      .filter((p): p is number => p != null);
  }
  return probes.portsForPid(pid);
}

/**
 * Which of the given worktrees currently host a live `claude` agent process
 * (comm == "claude", cwd under the worktree). A single scanProcs() pass with no
 * per-pid fd reads — cheap enough for a frequent poller sweep. This is the
 * husk detector herdr's `agent list` can't provide: a claude that exited to a
 * bare shell keeps its agent listed as idle, but its process is gone from /proc.
 * Sessions sharing a cwd (non-isolated, same repo) share one verdict — any
 * claude in the dir counts for all of them.
 *
 * Returns a Map with every supplied worktreePath as a key (false when no claude),
 * or `null` when the snapshot backend cannot support a negative verdict
 * (`snapshotState()` is `"none"`/`"stale"` — darwin with no recent `lsof`). A false
 * here DRIVES husk/stranded classification and auto-revive, so the caller MUST NOT
 * coerce `null` to an all-false map: it means "unknown", not "everything is dead".
 */
export function scanClaudeAliveByWorktree(
  worktreePaths: string[],
  probes: ReaperProbes = defaultProbes,
): Map<string, boolean> | null {
  if (probes.snapshotState && probes.snapshotState() !== "fresh") return null;
  const result = new Map<string, boolean>(worktreePaths.map((p) => [p, false]));
  if (worktreePaths.length === 0) return result;
  const roots = worktreePaths.map((p) => normRoot(p, probes));
  for (const proc of probes.scanProcs()) {
    if (!AGENT_COMMS.has(proc.comm)) continue;
    const matchedPath = matchWorktreePath(proc.cwd, roots, worktreePaths);
    if (matchedPath !== null) result.set(matchedPath, true);
  }
  return result;
}

/**
 * Scan listening ports for a set of worktree paths in a single pass.
 *
 * Builds the listening inode→port map EXACTLY ONCE, then resolves each
 * candidate PID's socket inodes against it — never rebuilds per-PID.
 * Excludes `claude` agent processes and the current process (process.pid).
 *
 * Returns a Map from worktreePath → sorted unique listening port numbers (every
 * supplied worktreePath appears as a key, empty array when no ports found), or
 * `null` when the snapshot backend cannot support a negative verdict
 * (`snapshotState()` is `"none"`/`"stale"`). An empty map here would drive
 * `converge` to tear down every bound preview, so `null` must be treated as
 * "unknown, leave listeners bound", not as "no ports".
 */
export function scanListeningPortsByWorktree(
  worktreePaths: string[],
  probes: ReaperProbes = defaultProbes,
): Map<string, number[]> | null {
  if (probes.snapshotState && probes.snapshotState() !== "fresh") return null;
  const result = new Map<string, number[]>(worktreePaths.map((p) => [p, []]));
  if (worktreePaths.length === 0) return result;

  const roots = worktreePaths.map((p) => normRoot(p, probes));

  // Build the inode→port map exactly once for all PIDs.
  // Both inodeToPortMap + socketInodesForPid must be supplied together;
  // a partial pair falls back to portsForPid for the whole scan.
  const inodeMap =
    typeof probes.inodeToPortMap === "function" && typeof probes.socketInodesForPid === "function"
      ? probes.inodeToPortMap()
      : null;

  const portSets = new Map<string, Set<number>>(worktreePaths.map((p) => [p, new Set()]));

  for (const proc of probes.scanProcs()) {
    if (proc.pid === process.pid || AGENT_COMMS.has(proc.comm)) continue;
    const matchedPath = matchWorktreePath(proc.cwd, roots, worktreePaths);
    if (matchedPath === null) continue;
    const ports = portsForProcBatched(proc.pid, inodeMap, probes);
    const set = portSets.get(matchedPath)!;
    for (const port of ports) set.add(port);
  }

  for (const [path, set] of portSets) {
    result.set(
      path,
      [...set].sort((a, b) => a - b),
    );
  }
  return result;
}
