import { test, expect } from "bun:test";
import {
  ProcessReaper,
  leftoverKey,
  scanClaudeAliveByWorktree,
  reapDeletedWorktreeOrphans,
  reapMarkedOrphans,
  USER_HZ,
  type CpuStat,
  type ReaperProbes,
  type ReapMarkedOptions,
} from "../src/process-reaper";
import { jsonlPathFor } from "../src/usage";

// Build a transcript line carrying one Bash tool command (the shape the reaper scans).
function bashLine(command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });
}

function makeProbes(over: Partial<ReaperProbes> = {}): ReaperProbes {
  return {
    scanProcs: () => [],
    portsForPid: () => [],
    listeningPorts: () => new Set(),
    readTranscript: () => "",
    killPid: () => {},
    run: () => {},
    ...over,
  };
}

const session = { worktreePath: "/wt/repo-x", claudeSessionId: "sess-1", isolated: true };

test("class 2: a listening process under the worktree is detected", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 4242, cwd: "/wt/repo-x", comm: "vite" }],
      portsForPid: (pid) => (pid === 4242 ? [5174] : []),
    }),
  );
  const out = reaper.detect(session);
  expect(out).toEqual([
    { kind: "process", name: "vite", port: 5174, pid: 4242, key: "process:4242" },
  ]);
});

test("class 2: the claude agent itself is never offered", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 1, cwd: "/wt/repo-x", comm: "claude" }],
      portsForPid: () => [9999], // even if it somehow listened, it's excluded by name
    }),
  );
  expect(reaper.detect(session)).toEqual([]);
});

test("class 2: a non-listening child (no port) is treated as transient, not offered", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 50, cwd: "/wt/repo-x", comm: "bash" }],
      portsForPid: () => [],
    }),
  );
  expect(reaper.detect(session)).toEqual([]);
});

test("class 2: processes outside the worktree are ignored", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 7, cwd: "/wt/other-repo", comm: "vite" }],
      portsForPid: () => [3000],
    }),
  );
  expect(reaper.detect(session)).toEqual([]);
});

test("class 2: a non-isolated session (worktreePath == repo root) never cwd-scans — the shepherd server isn't reaped", () => {
  // Non-isolated sessions share the repo root as their "worktree"; the shepherd
  // server's own cwd IS that root and it listens on a port. Scanning by cwd would
  // flag the server itself. The scan must be skipped entirely when !isolated.
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 7330, cwd: "/repo", comm: "bun" }],
      portsForPid: () => [7330],
    }),
  );
  expect(
    reaper.detect({ worktreePath: "/repo", claudeSessionId: "sess-1", isolated: false }),
  ).toEqual([]);
});

test("class 2: the reaper never offers its own process (self-pid)", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: process.pid, cwd: "/wt/repo-x", comm: "bun" }],
      portsForPid: () => [7330], // even listening, the server must not reap itself
    }),
  );
  expect(reaper.detect(session)).toEqual([]);
});

test("class 3: tailscale serve --bg is scraped from the transcript when its port still listens", () => {
  let askedPath = "";
  const reaper = new ProcessReaper(
    makeProbes({
      readTranscript: (p) => {
        askedPath = p;
        return bashLine("tailscale serve --bg --https 5174 http://localhost:5174");
      },
      listeningPorts: () => new Set([5174]),
    }),
  );
  const out = reaper.detect(session);
  expect(askedPath).toBe(jsonlPathFor(session.worktreePath, session.claudeSessionId));
  expect(out).toEqual([
    {
      kind: "system",
      name: "tailscale serve",
      port: 5174,
      command: { bin: "tailscale", args: ["serve", "--https=5174", "off"] },
      key: "system:tailscale serve:5174",
    },
  ]);
});

test("class 3: a tailscale serve whose port no longer listens is NOT offered (gegenprüfung)", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      readTranscript: () => bashLine("tailscale serve --bg --https=5174 http://localhost:5174"),
      listeningPorts: () => new Set(), // server already stopped by hand
    }),
  );
  expect(reaper.detect(session)).toEqual([]);
});

test("class 3: dedupes repeated launches of the same proxy", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      readTranscript: () =>
        [
          bashLine("tailscale serve --bg --https 5174 http://localhost:5174"),
          bashLine("tailscale serve --bg --https 5174 http://localhost:5174"),
        ].join("\n"),
      listeningPorts: () => new Set([5174]),
    }),
  );
  expect(reaper.detect(session)).toHaveLength(1);
});

test("detect surfaces both a worktree server and its tailscale proxy on the same port", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 4242, cwd: "/wt/repo-x", comm: "vite" }],
      portsForPid: () => [5174],
      readTranscript: () => bashLine("tailscale serve --bg --https 5174 http://localhost:5174"),
      listeningPorts: () => new Set([5174]),
    }),
  );
  const out = reaper.detect(session);
  expect(out.map((l) => l.key)).toEqual(["process:4242", "system:tailscale serve:5174"]);
});

test("reap kills process pids and runs counter-commands; survives a throw", () => {
  const killed: number[] = [];
  const ran: { bin: string; args: string[] }[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      killPid: (pid) => {
        if (pid === 999) throw new Error("ESRCH"); // already gone — must not abort the rest
        killed.push(pid);
      },
      run: (bin, args) => ran.push({ bin, args }),
    }),
  );
  reaper.reap([
    { kind: "process", name: "gone", port: null, pid: 999, key: "process:999" },
    { kind: "process", name: "vite", port: 5174, pid: 4242, key: "process:4242" },
    {
      kind: "system",
      name: "tailscale serve",
      port: 5174,
      command: { bin: "tailscale", args: ["serve", "--https=5174", "off"] },
      key: "system:tailscale serve:5174",
    },
  ]);
  expect(killed).toEqual([4242]);
  expect(ran).toEqual([{ bin: "tailscale", args: ["serve", "--https=5174", "off"] }]);
});

// ── stopListenersOnPort ───────────────────────────────────────────────────────

test("stopListenersOnPort: signals matching proc and returns correct count", () => {
  const killed: { pid: number; signal: NodeJS.Signals | undefined }[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [
        { pid: 4242, cwd: "/wt/repo-x", comm: "vite" },
        { pid: 4243, cwd: "/wt/repo-x", comm: "bun" },
      ],
      portsForPid: (pid) => {
        if (pid === 4242) return [5174];
        if (pid === 4243) return [5174];
        return [];
      },
      killPid: (pid, signal) => {
        killed.push({ pid, signal });
      },
    }),
  );
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled;
  expect(count).toBe(2);
  expect(killed.map((k) => k.pid).sort()).toEqual([4242, 4243]);
});

test("stopListenersOnPort: excludes current process (self-pid)", () => {
  const killed: number[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [
        { pid: process.pid, cwd: "/wt/repo-x", comm: "bun" },
        { pid: 4242, cwd: "/wt/repo-x", comm: "vite" },
      ],
      portsForPid: (pid) => (pid === process.pid || pid === 4242 ? [5174] : []),
      killPid: (pid) => {
        killed.push(pid);
      },
    }),
  );
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled;
  expect(count).toBe(1);
  expect(killed).toEqual([4242]);
});

test("stopListenersOnPort: excludes claude-comm processes", () => {
  const killed: number[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [
        { pid: 1, cwd: "/wt/repo-x", comm: "claude" },
        { pid: 4242, cwd: "/wt/repo-x", comm: "vite" },
      ],
      portsForPid: () => [5174],
      killPid: (pid) => {
        killed.push(pid);
      },
    }),
  );
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled;
  expect(count).toBe(1);
  expect(killed).toEqual([4242]);
});

test("stopListenersOnPort: ignores processes on a different port (returns 0)", () => {
  const killed: number[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 4242, cwd: "/wt/repo-x", comm: "vite" }],
      portsForPid: () => [3000],
      killPid: (pid) => {
        killed.push(pid);
      },
    }),
  );
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled;
  expect(count).toBe(0);
  expect(killed).toEqual([]);
});

test("stopListenersOnPort: passes the given signal through to killPid", () => {
  const received: { pid: number; signal: NodeJS.Signals | undefined }[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 4242, cwd: "/wt/repo-x", comm: "vite" }],
      portsForPid: () => [5174],
      killPid: (pid, signal) => {
        received.push({ pid, signal });
      },
    }),
  );
  reaper.stopListenersOnPort("/wt/repo-x", 5174, "SIGKILL");
  expect(received).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
});

test("stopListenersOnPort: default signal is SIGTERM", () => {
  const received: { pid: number; signal: NodeJS.Signals | undefined }[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 4242, cwd: "/wt/repo-x", comm: "vite" }],
      portsForPid: () => [5174],
      killPid: (pid, signal) => {
        received.push({ pid, signal });
      },
    }),
  );
  reaper.stopListenersOnPort("/wt/repo-x", 5174);
  expect(received).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
});

test("stopListenersOnPort: a throwing killPid is not counted", () => {
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 4242, cwd: "/wt/repo-x", comm: "vite" }],
      portsForPid: () => [5174],
      killPid: () => {
        throw new Error("ESRCH");
      },
    }),
  );
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled;
  expect(count).toBe(0);
});

test("stopListenersOnPort: returns 0 when no process matches", () => {
  const reaper = new ProcessReaper(makeProbes());
  expect(reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled).toBe(0);
});

test("stopListenersOnPort: ignores processes outside the worktree", () => {
  const killed: number[] = [];
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 9000, cwd: "/wt/other-repo", comm: "vite" }],
      portsForPid: () => [5174],
      killPid: (pid) => {
        killed.push(pid);
      },
    }),
  );
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174).signalled;
  expect(count).toBe(0);
  expect(killed).toEqual([]);
});

test("leftoverKey is stable per kind", () => {
  expect(leftoverKey({ kind: "process", name: "vite", port: 5174, pid: 7 })).toBe("process:7");
  expect(leftoverKey({ kind: "system", name: "tailscale serve", port: 5174 })).toBe(
    "system:tailscale serve:5174",
  );
});

// ── scanClaudeAliveByWorktree ───────────────────────────────────────────────

test("claude-alive: a claude process rooted in the worktree marks it alive", () => {
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x", "/wt/repo-y"],
    makeProbes({
      scanProcs: () => [
        { pid: 1, cwd: "/wt/repo-x", comm: "claude" },
        { pid: 2, cwd: "/wt/repo-y", comm: "bash" }, // husk shell — not claude
      ],
    }),
  );
  expect(out!.get("/wt/repo-x")).toBe(true);
  expect(out!.get("/wt/repo-y")).toBe(false);
});

test("claude-alive: a claude in an unrelated cwd counts for no worktree", () => {
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x"],
    makeProbes({ scanProcs: () => [{ pid: 1, cwd: "/elsewhere", comm: "claude" }] }),
  );
  expect(out!.get("/wt/repo-x")).toBe(false);
});

test("claude-alive: a claude in a subdir of the worktree still counts", () => {
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x"],
    makeProbes({ scanProcs: () => [{ pid: 1, cwd: "/wt/repo-x/sub", comm: "claude" }] }),
  );
  expect(out!.get("/wt/repo-x")).toBe(true);
});

test("claude-alive: every supplied worktree appears as a key; empty input is fine", () => {
  expect(scanClaudeAliveByWorktree([], makeProbes())!.size).toBe(0);
  const out = scanClaudeAliveByWorktree(["/wt/a"], makeProbes());
  expect(out!.get("/wt/a")).toBe(false);
});

// #1891 Phase-0 regression: a SANDBOXED agent runs as `bwrap [membrane] -- env … claude …`. Empirical
// capture (bwrap 0.11.1, faithful membrane flags) showed the inner `claude` IS host-visible with
// `comm=claude` and `/proc/<pid>/cwd` resolving under the worktree — `--unshare-pid` does not hide a
// descendant from the host, and the worktree is bind-mounted at the same path. So the host-wide scan
// already marks a live sandboxed agent alive; there is no husk false-positive to fix. These lock that.
test("claude-alive: a live sandboxed agent (claude under bwrap, worktree cwd) is alive", () => {
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x"],
    makeProbes({
      scanProcs: () => [
        { pid: 100, cwd: "/wt/repo-x", comm: "bwrap" }, // outer monitor (ignored — not an agent comm)
        { pid: 101, cwd: "/wt/repo-x", comm: "bwrap" }, // sandbox init (ignored)
        { pid: 102, cwd: "/wt/repo-x", comm: "claude" }, // inner agent — host-visible, worktree cwd
      ],
    }),
  );
  expect(out!.get("/wt/repo-x")).toBe(true);
});

test("claude-alive: a dead sandboxed agent leaves no worktree-cwd claude → husk", () => {
  // Phase-0 Step B: killing the inner `claude` makes the `bwrap` monitors reap it and exit, so no
  // worktree-cwd process survives. The scan reads false → the husk is still caught.
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x"],
    makeProbes({ scanProcs: () => [{ pid: 200, cwd: "/wt/repo-x", comm: "zsh" }] }),
  );
  expect(out!.get("/wt/repo-x")).toBe(false);
});

// ── #1133: orphan reaping (PPID-1 busy-loops the port-based detector misses) ──

const WT = "/home/u/Work/.shepherd-worktrees/repo-x"; // a real worktree path (has the marker)

// A synthetic orphan PID guaranteed to differ from the test runner's own process.pid.
// The reapers spare `p.pid === process.pid` (don't SIGKILL self); a hardcoded literal can
// collide with the runner's PID in CI containers (which hand out small PIDs — a literal like
// 808 once matched), sparing the orphan and flipping a "reaps 1" assertion to 0. Deriving it
// from process.pid can never collide.
const ORPHAN_PID = process.pid + 1;

// killPid spy: record (pid, signal) so tests can assert SIGKILL + exactly-who.
function killSpy() {
  const killed: { pid: number; signal?: NodeJS.Signals }[] = [];
  return {
    killed,
    killPid: (pid: number, signal?: NodeJS.Signals) => killed.push({ pid, signal }),
  };
}

test("reapOrphansUnder: SIGKILLs a PPID-1 non-agent orphan whose cwd is under the worktree", () => {
  const k = killSpy();
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: ORPHAN_PID, cwd: WT, comm: "yes" }],
      ppidForPid: () => 1,
      killPid: k.killPid,
    }),
  );
  expect(reaper.reapOrphansUnder(WT)).toBe(1);
  expect(k.killed).toEqual([{ pid: ORPHAN_PID, signal: "SIGKILL" }]);
});

test("reapOrphansUnder: spares self, agent comm, non-orphan (PPID!=1), and out-of-worktree procs", () => {
  const k = killSpy();
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [
        { pid: process.pid, cwd: WT, comm: "bun" }, // self
        { pid: 11, cwd: WT, comm: "claude" }, // agent comm
        { pid: 12, cwd: WT, comm: "node" }, // PPID != 1 → live child, not orphan
        { pid: 13, cwd: "/home/u/Work/.shepherd-worktrees/other", comm: "yes" }, // other worktree
      ],
      ppidForPid: (pid) => (pid === 12 ? 9000 : 1),
      killPid: k.killPid,
    }),
  );
  expect(reaper.reapOrphansUnder(WT)).toBe(0);
  expect(k.killed).toEqual([]);
});

test("reapOrphansUnder: refuses a non-worktree path (no /.shepherd-worktrees/) and kills nothing", () => {
  const k = killSpy();
  const reaper = new ProcessReaper(
    makeProbes({
      // A matching PPID-1 orphan is present, but the target path is a repo root.
      scanProcs: () => [{ pid: 999, cwd: "/home/u/Work/repo", comm: "yes" }],
      ppidForPid: () => 1,
      killPid: k.killPid,
    }),
  );
  expect(reaper.reapOrphansUnder("/home/u/Work/repo")).toBe(0);
  expect(k.killed).toEqual([]);
});

test("reapOrphansUnder: when ppidForPid is absent it can't confirm orphanhood, so it kills nothing", () => {
  const k = killSpy();
  const reaper = new ProcessReaper(
    makeProbes({
      scanProcs: () => [{ pid: 5, cwd: WT, comm: "yes" }],
      killPid: k.killPid, // makeProbes omits ppidForPid
    }),
  );
  expect(reaper.reapOrphansUnder(WT)).toBe(0);
  expect(k.killed).toEqual([]);
});

test("reapDeletedWorktreeOrphans: SIGKILLs a PPID-1 orphan whose cwd is a deleted shepherd worktree", () => {
  const k = killSpy();
  const { reaped } = reapDeletedWorktreeOrphans(
    makeProbes({
      scanProcs: () => [{ pid: ORPHAN_PID, cwd: `${WT} (deleted)`, comm: "yes" }],
      ppidForPid: () => 1,
      killPid: k.killPid,
    }),
  );
  expect(reaped).toBe(1);
  expect(k.killed).toEqual([{ pid: ORPHAN_PID, signal: "SIGKILL" }]);
});

test("reapDeletedWorktreeOrphans: spares a live (non-deleted) cwd, even under the worktree marker", () => {
  const k = killSpy();
  const { reaped } = reapDeletedWorktreeOrphans(
    makeProbes({
      scanProcs: () => [{ pid: 809, cwd: WT, comm: "yes" }], // still-existing worktree → out of scope
      ppidForPid: () => 1,
      killPid: k.killPid,
    }),
  );
  expect(reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

test("reapDeletedWorktreeOrphans: spares a deleted cwd that isn't a shepherd worktree, the agent, PPID!=1, and self", () => {
  const k = killSpy();
  const { reaped } = reapDeletedWorktreeOrphans(
    makeProbes({
      scanProcs: () => [
        { pid: 20, cwd: "/tmp/scratch (deleted)", comm: "yes" }, // deleted but not a worktree
        { pid: 21, cwd: `${WT} (deleted)`, comm: "claude" }, // agent comm
        { pid: 22, cwd: `${WT} (deleted)`, comm: "node" }, // PPID != 1
        { pid: process.pid, cwd: `${WT} (deleted)`, comm: "bun" }, // self
      ],
      ppidForPid: (pid) => (pid === 22 ? 5000 : 1),
      killPid: k.killPid,
    }),
  );
  expect(reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

// ── #1144: resource-gated reaper for MARKED orphans ──────────────────────────
//
// Safety here is provenance ∧ terminality. The regressions below are the ones that bit during
// design review: an agent's in-flight `cargo build &` is PPID-1 but NOT abandoned; a second
// Shepherd instance's live session must not be reaped; a `while true` supervisor hides its burn in
// cutime/cstime. Each has a named test.

const MARKED = "sess-archived";
const HZ = USER_HZ;

/** A /proc/<pid>/stat sample: `cpu` = fraction of one core burned over `ageS`, split as asked. */
function cpuStat(
  over: {
    ageS?: number;
    cpu?: number;
    childCpu?: number;
    starttime?: number;
    uptime?: number;
  } = {},
): CpuStat {
  const ageS = over.ageS ?? 600; // 10 min — comfortably past the 5-min floor
  const uptime = over.uptime ?? 100_000;
  const own = (over.cpu ?? 1) * ageS * HZ; // ticks of own CPU
  const child = (over.childCpu ?? 0) * ageS * HZ; // ticks accrued from reaped children
  return {
    utime: own,
    stime: 0,
    cutime: child,
    cstime: 0,
    starttime: over.starttime ?? (uptime - ageS) * HZ,
  };
}

/** Probes for a single hot, marked, non-listening orphan at ORPHAN_PID. Override as needed. */
function markedProbes(over: Partial<ReaperProbes> = {}): ReaperProbes {
  return makeProbes({
    listPids: () => [ORPHAN_PID],
    commForPid: () => "yes",
    environForPid: () => ({ SHEPHERD_SESSION_ID: MARKED }),
    cpuStatForPid: () => cpuStat(),
    uptimeSeconds: () => 100_000,
    ppidForPid: () => 1,
    portsForPid: () => [],
    ...over,
  });
}

const reapOpts = (over: Partial<ReapMarkedOptions> = {}): ReapMarkedOptions => ({
  sessionStatus: () => "archived",
  mode: "armed",
  minCpu: 0.8,
  minAgeS: 300,
  ...over,
});

test("#1144 gap 2: a marked orphan of an ARCHIVED session is SIGKILLed", () => {
  const k = killSpy();
  const r = reapMarkedOrphans(reapOpts({ probes: markedProbes({ killPid: k.killPid }) }));
  expect(r.reaped).toBe(1);
  expect(k.killed).toEqual([{ pid: ORPHAN_PID, signal: "SIGKILL" }]);
  expect(r.observed[0]!.sessionId).toBe(MARKED);
});

test("#1144 gap 1: cwd is irrelevant — an orphan that chdir'd out to $HOME is still reaped", () => {
  // The whole point of provenance: the marker survives `cd`. A cwd-based sweep could never see this.
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({ cwdForPid: () => "/home/u", killPid: k.killPid }),
    }),
  );
  expect(r.reaped).toBe(1);
  expect(r.observed[0]!.cwd).toBe("/home/u");
});

test("#1144: an UNMARKED hot process (operator's rust-analyzer / nohup bench) is NEVER a candidate", () => {
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        commForPid: () => "rust-analyzer",
        environForPid: () => ({ PATH: "/usr/bin" }), // no marker
        killPid: k.killPid,
      }),
    }),
  );
  expect(r.reaped).toBe(0);
  expect(r.observed).toEqual([]);
  expect(k.killed).toEqual([]);
});

test("#1144: an unreadable environ is spared (fail closed)", () => {
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({ probes: markedProbes({ environForPid: () => null, killPid: k.killPid }) }),
  );
  expect(r.reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

// ── terminality: the in-flight-build regressions ─────────────────────────────

test("#1144 REGRESSION: an agent's in-flight `cargo build &` (live session) is SPARED", () => {
  // PPID-1 but NOT abandoned: a one-shot Bash tool call reparents its background job to PID 1 the
  // moment that call's shell exits, while the agent is still working and tailing the log.
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({
      sessionStatus: () => "live",
      probes: markedProbes({ commForPid: () => "cargo", killPid: k.killPid }),
    }),
  );
  expect(r.reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

test("#1144 REGRESSION: a second instance's session (row ABSENT here) is SPARED", () => {
  // SHEPHERD_DB/SHEPHERD_PORT make two Shepherds on one host supported. Reaping on "absent" would
  // let instance A SIGKILL instance B's LIVE session's work.
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({ sessionStatus: () => "absent", probes: markedProbes({ killPid: k.killPid }) }),
  );
  expect(r.reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

test("#1144: a throwing sessionStatus (store unavailable) kills nothing", () => {
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({
      sessionStatus: () => {
        throw new Error("store closed");
      },
      probes: markedProbes({ killPid: k.killPid }),
    }),
  );
  expect(r.reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

test("#1144: `ids` scopes the sweep — a marked orphan outside the set is spared", () => {
  const k = killSpy();
  const inSet = reapMarkedOrphans(
    reapOpts({ ids: new Set([MARKED]), probes: markedProbes({ killPid: k.killPid }) }),
  );
  expect(inSet.reaped).toBe(1);
  const outOfSet = reapMarkedOrphans(
    reapOpts({ ids: new Set(["other"]), probes: markedProbes({ killPid: k.killPid }) }),
  );
  expect(outOfSet.reaped).toBe(0);
});

// ── the supervisor busy-loop (cutime/cstime) ─────────────────────────────────

test("#1144 REGRESSION: a `while true` supervisor shell is reaped via cutime/cstime", () => {
  // The shell sits blocked in wait(): its OWN utime/stime are ~0 while each short-lived child burns
  // a core and dies under the age floor. Only the reaped-children columns reveal the burn.
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        commForPid: () => "bash",
        cpuStatForPid: () => cpuStat({ cpu: 0.01, childCpu: 0.99 }),
        killPid: k.killPid,
      }),
    }),
  );
  expect(r.reaped).toBe(1);
  expect(k.killed).toEqual([{ pid: ORPHAN_PID, signal: "SIGKILL" }]);
});

test("#1144: that same supervisor would be MISSED if cutime/cstime were dropped (guards the fix)", () => {
  // Same process, but with the children's CPU erased — proving the columns are load-bearing and a
  // future "simplification" that drops them silently reintroduces the leak.
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        commForPid: () => "bash",
        cpuStatForPid: () => ({ ...cpuStat({ cpu: 0.01, childCpu: 0.99 }), cutime: 0, cstime: 0 }),
      }),
    }),
  );
  expect(r.reaped).toBe(0);
});

// ── spares ───────────────────────────────────────────────────────────────────

test("#1144: git-family comms are spared, incl. the 15-char-truncated `git-pack-object`", () => {
  // /proc/<pid>/comm truncates at TASK_COMM_LEN-1 = 15, so `git-pack-objects` (16) can never match
  // an exact entry — the `git-` prefix rule is what covers it. `git gc --auto` is detached by
  // gc.autoDetach, INHERITS the marker, is non-listening and pegs a core from birth; SIGKILLing it
  // strands a stale gc.pid lock and the repo is then never gc'd.
  for (const comm of ["git", "git-gc", "git-repack", "git-maintenance", "git-pack-object"]) {
    const k = killSpy();
    const r = reapMarkedOrphans(
      reapOpts({ probes: markedProbes({ commForPid: () => comm, killPid: k.killPid }) }),
    );
    expect({ comm, reaped: r.reaped }).toEqual({ comm, reaped: 0 });
    expect(k.killed).toEqual([]);
  }
});

test("#1144: a LISTENING marked process (an agent-started dev server) is spared", () => {
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        commForPid: () => "vite",
        portsForPid: () => [5174],
        killPid: k.killPid,
      }),
    }),
  );
  expect(r.reaped).toBe(0);
  expect(k.killed).toEqual([]);
});

test("#1144: below the CPU threshold, and under the age floor even at 100%, are spared", () => {
  const quiet = reapMarkedOrphans(
    reapOpts({ probes: markedProbes({ cpuStatForPid: () => cpuStat({ cpu: 0.2 }) }) }),
  );
  expect(quiet.reaped).toBe(0);
  const young = reapMarkedOrphans(
    reapOpts({ probes: markedProbes({ cpuStatForPid: () => cpuStat({ ageS: 60, cpu: 1 }) }) }),
  );
  expect(young.reaped).toBe(0);
});

test("#1144: the agent itself, and the shepherd server's own pid, are spared", () => {
  for (const comm of ["claude", "codex"]) {
    const r = reapMarkedOrphans(reapOpts({ probes: markedProbes({ commForPid: () => comm }) }));
    expect(r.reaped).toBe(0);
  }
  const self = reapMarkedOrphans(
    reapOpts({ probes: markedProbes({ listPids: () => [process.pid] }) }),
  );
  expect(self.reaped).toBe(0);
});

test("#1144: a missing probe reaps nothing (fail closed)", () => {
  // makeProbes() omits every #1144 probe.
  const r = reapMarkedOrphans(reapOpts({ probes: makeProbes() }));
  expect(r.reaped).toBe(0);
});

test("#1144: mode `observe` logs the candidate but never kills; `off` does nothing at all", () => {
  const k = killSpy();
  const obs = reapMarkedOrphans(
    reapOpts({ mode: "observe", probes: markedProbes({ killPid: k.killPid }) }),
  );
  expect(obs.reaped).toBe(0);
  expect(obs.observed).toHaveLength(1); // still surfaced for the log
  expect(k.killed).toEqual([]);

  const off = reapMarkedOrphans(
    reapOpts({ mode: "off", probes: markedProbes({ killPid: k.killPid }) }),
  );
  expect(off.observed).toEqual([]);
  expect(k.killed).toEqual([]);
});

test("#1144: a pid recycled between scan and kill is NOT killed (starttime fingerprint)", () => {
  const k = killSpy();
  let call = 0;
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        // 1st read: the candidate. 2nd (pre-kill re-check): a different process on the same pid.
        cpuStatForPid: () => (++call === 1 ? cpuStat() : cpuStat({ starttime: 999 })),
        killPid: k.killPid,
      }),
    }),
  );
  expect(r.reaped).toBe(0);
  expect(k.killed).toEqual([]);
  // It WAS a candidate — it just wasn't killed. Callers must log from `killed`, not `observed`,
  // or the per-candidate lines would claim a kill that never happened and contradict `reaped`.
  expect(r.observed).toHaveLength(1);
  expect(r.killed).toEqual([]);
});

test("#1144: `killed` excludes a candidate whose killPid throws (it must not be logged as killed)", () => {
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        killPid: () => {
          throw new Error("ESRCH"); // already exited between the re-check and the kill
        },
      }),
    }),
  );
  expect(r.observed).toHaveLength(1);
  expect(r.killed).toEqual([]);
  expect(r.reaped).toBe(0);
});

// ── enumeration + gate ordering ──────────────────────────────────────────────

test("#1144: a candidate whose cwd is UNREADABLE is still found (no cwd dependency)", () => {
  // scanProcs() silently drops such pids; this sweep enumerates /proc directly, so it must not.
  const k = killSpy();
  const r = reapMarkedOrphans(
    reapOpts({ probes: markedProbes({ cwdForPid: () => null, killPid: k.killPid }) }),
  );
  expect(r.reaped).toBe(1);
  expect(r.observed[0]!.cwd).toBeNull();
});

test("#1144: environ is read LAST — an idle process never has its mmap lock taken", () => {
  // Reading environ goes through access_remote_vm and takes the TARGET's mmap lock, so it can block
  // on a stalled process. On a host of mostly-idle pids it must never be reached.
  const environReads: number[] = [];
  const IDLE = ORPHAN_PID + 1;
  const r = reapMarkedOrphans(
    reapOpts({
      probes: markedProbes({
        listPids: () => [ORPHAN_PID, IDLE],
        commForPid: (pid) => (pid === IDLE ? "chrome" : "yes"),
        cpuStatForPid: (pid) => (pid === IDLE ? cpuStat({ cpu: 0 }) : cpuStat()),
        environForPid: (pid) => {
          environReads.push(pid);
          return { SHEPHERD_SESSION_ID: MARKED };
        },
      }),
    }),
  );
  expect(r.reaped).toBe(1);
  expect(environReads).toEqual([ORPHAN_PID]); // the idle chrome was never touched
});
