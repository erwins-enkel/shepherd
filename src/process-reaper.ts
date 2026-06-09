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
  /** Terminate a pid (SIGTERM). */
  killPid(pid: number): void;
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
}

// The agent itself runs `claude` with cwd == worktree; never offer to kill it.
// fallow-ignore-next-line unused-export
export const AGENT_COMMS = new Set(["claude"]);

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
    const content = o?.message?.content;
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
  readTranscript(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  },
  killPid(pid) {
    process.kill(pid);
  },
  run(bin, args) {
    execFileSync(bin, args, { stdio: "ignore" });
  },
};

export class ProcessReaper {
  constructor(private probes: ReaperProbes = defaultProbes) {}

  /** Detect surviving leftovers for a session (classes 2 + 3). */
  detect(s: { worktreePath: string; claudeSessionId: string; isolated: boolean }): Leftover[] {
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
  private scanSystemSideEffects(s: { worktreePath: string; claudeSessionId: string }): Leftover[] {
    if (!s.claudeSessionId) return [];
    const text = this.probes.readTranscript(jsonlPathFor(s.worktreePath, s.claudeSessionId));
    if (!text) return [];
    const listening = this.probes.listeningPorts();
    // drop any whose port no longer listens — already stopped by hand
    return scanTranscript(text).filter((hit) => hit.port == null || listening.has(hit.port));
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
