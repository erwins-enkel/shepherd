import { readdirSync, readlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "./instrument";
import { jsonlPathFor } from "./usage";
import { eachJsonlObject } from "./jsonl";

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
  /** All locally-listening TCP ports (for the class-3 counter-check). */
  listeningPorts(): Set<number>;
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
const AGENT_COMMS = new Set(["claude", "codex"]);

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
const WORKTREE_MARKER = "/.shepherd-worktrees/";

// readlink(/proc/<pid>/cwd) appends this once the directory is unlinked; the kernel
// keeps the inode alive for the still-running process. A "(deleted)" cwd under the
// worktree marker is the unambiguous signal of an orphan whose worktree is already gone.
const DELETED_SUFFIX = " (deleted)";

/** Stable selection key — lets the client echo a choice back without trusting raw pids. */
export function leftoverKey(l: Pick<Leftover, "kind" | "name" | "port" | "pid">): string {
  return l.kind === "process" ? `process:${l.pid}` : `system:${l.name}:${l.port ?? ""}`;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
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

const defaultProbes: ReaperProbes = {
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
    const root = worktreePath.replace(/\/+$/, "");
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
   */
  stopListenersOnPort(
    worktreePath: string,
    port: number,
    signal: NodeJS.Signals = "SIGTERM",
  ): number {
    const root = worktreePath.replace(/\/+$/, "");
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
    return count;
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
    const root = worktreePath.replace(/\/+$/, "");
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

  /** Best-effort terminate each leftover (kill pid / run counter-command). */
  reap(leftovers: Leftover[]): void {
    for (const l of leftovers) {
      try {
        if (l.kind === "process" && l.pid != null) this.probes.killPid(l.pid);
        else if (l.command) this.probes.run(l.command.bin, l.command.args);
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
 * LOAD-BEARING INVARIANT: no code path may hard-delete a `sessions` row without archiving it first.
 * Because absent ⇒ spare, a hard-deleted session's marked orphans become permanently unreapable.
 * This holds today — the only `DELETE FROM sessions` (store.ts, pruneArchivedSessions) is scoped to
 * `status = 'archived'`.
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
  observed: RunawayCandidate[];
} {
  const { sessionStatus, ids, mode, minCpu, minAgeS, probes = defaultProbes } = opts;
  const none = { reaped: 0, observed: [] as RunawayCandidate[] };
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
  let reaped = 0;

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
      reaped++;
    } catch {
      /* best-effort: the process may have exited between the re-check and here */
    }
  }

  return { reaped, observed };
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
 * Returns a Map with every supplied worktreePath as a key (false when no claude).
 */
export function scanClaudeAliveByWorktree(
  worktreePaths: string[],
  probes: ReaperProbes = defaultProbes,
): Map<string, boolean> {
  const result = new Map<string, boolean>(worktreePaths.map((p) => [p, false]));
  if (worktreePaths.length === 0) return result;
  const roots = worktreePaths.map((p) => p.replace(/\/+$/, ""));
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
 * Returns a Map from worktreePath → sorted unique listening port numbers.
 * Every supplied worktreePath appears as a key (empty array when no ports found).
 */
export function scanListeningPortsByWorktree(
  worktreePaths: string[],
  probes: ReaperProbes = defaultProbes,
): Map<string, number[]> {
  const result = new Map<string, number[]>(worktreePaths.map((p) => [p, []]));
  if (worktreePaths.length === 0) return result;

  const roots = worktreePaths.map((p) => p.replace(/\/+$/, ""));

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
