import { test, expect } from "bun:test";
import {
  ProcessReaper,
  leftoverKey,
  scanClaudeAliveByWorktree,
  reapDeletedWorktreeOrphans,
  type ReaperProbes,
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
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174);
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
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174);
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
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174);
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
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174);
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
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174);
  expect(count).toBe(0);
});

test("stopListenersOnPort: returns 0 when no process matches", () => {
  const reaper = new ProcessReaper(makeProbes());
  expect(reaper.stopListenersOnPort("/wt/repo-x", 5174)).toBe(0);
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
  const count = reaper.stopListenersOnPort("/wt/repo-x", 5174);
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
  expect(out.get("/wt/repo-x")).toBe(true);
  expect(out.get("/wt/repo-y")).toBe(false);
});

test("claude-alive: a claude in an unrelated cwd counts for no worktree", () => {
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x"],
    makeProbes({ scanProcs: () => [{ pid: 1, cwd: "/elsewhere", comm: "claude" }] }),
  );
  expect(out.get("/wt/repo-x")).toBe(false);
});

test("claude-alive: a claude in a subdir of the worktree still counts", () => {
  const out = scanClaudeAliveByWorktree(
    ["/wt/repo-x"],
    makeProbes({ scanProcs: () => [{ pid: 1, cwd: "/wt/repo-x/sub", comm: "claude" }] }),
  );
  expect(out.get("/wt/repo-x")).toBe(true);
});

test("claude-alive: every supplied worktree appears as a key; empty input is fine", () => {
  expect(scanClaudeAliveByWorktree([], makeProbes()).size).toBe(0);
  const out = scanClaudeAliveByWorktree(["/wt/a"], makeProbes());
  expect(out.get("/wt/a")).toBe(false);
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
