import { test, expect } from "bun:test";
import { ProcessReaper, leftoverKey, type ReaperProbes } from "../src/process-reaper";
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

test("leftoverKey is stable per kind", () => {
  expect(leftoverKey({ kind: "process", name: "vite", port: 5174, pid: 7 })).toBe("process:7");
  expect(leftoverKey({ kind: "system", name: "tailscale serve", port: 5174 })).toBe(
    "system:tailscale serve:5174",
  );
});
