import { test, expect } from "bun:test";
import {
  ProcessReaper,
  scanClaudeAliveByWorktree,
  scanListeningPortsByWorktree,
  liveProcCwds,
  makeDefaultProbes,
  reapMarkedOrphans,
  type ReaperProbes,
} from "../src/process-reaper";

// Behaviour of the reaper + batched scans when driven by a darwin-shaped backend
// (a snapshot cell that reports `snapshotState`, omits `listeningPorts`, and sets
// `canAuthorizeSignal: false`). These are the platform-parity guarantees the plan
// pins; the real darwin backend is exercised separately against `lsof`.

/** A fake darwin backend: a controllable snapshot state + a fixed process list,
 *  no `listeningPorts`, `canAuthorizeSignal: false`. */
function darwinFake(
  over: Partial<ReaperProbes> & { state?: "none" | "stale" | "fresh" } = {},
): ReaperProbes {
  const { state = "fresh", ...rest } = over;
  return {
    scanProcs: () => [],
    portsForPid: () => [],
    readTranscript: () => "",
    killPid: () => {},
    run: () => {},
    listPids: () => [],
    commForPid: () => "",
    cwdForPid: () => null,
    snapshotState: () => state,
    canAuthorizeSignal: false,
    refresh: () => Promise.resolve(),
    ...rest,
  };
}

// ── stopListenersOnPort: never signals on a no-authority backend ─────────────

test("stopListenersOnPort: darwin backend reports unsupported and never calls killPid", () => {
  const killed: number[] = [];
  const probes = darwinFake({
    scanProcs: () => [{ pid: 4242, cwd: "/wt/x", comm: "vite" }],
    portsForPid: () => [5173],
    killPid: (pid) => killed.push(pid),
  });
  const r = new ProcessReaper(probes).stopListenersOnPort("/wt/x", 5173, "SIGKILL");
  expect(r).toEqual({ signalled: 0, unsupported: true });
  expect(killed).toEqual([]);
});

// ── class-3: fail closed when listeningPorts is absent ───────────────────────

test("scanSystemSideEffects: no listeningPorts probe ⇒ offers zero class-3 leftovers", () => {
  // A transcript that WOULD yield a `tailscale serve` class-3 hit on Linux.
  const transcript = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "tailscale serve --bg --https=8443 localhost:8443" },
        },
      ],
    },
  });
  const probes = darwinFake({ readTranscript: () => transcript });
  expect(probes.listeningPorts).toBeUndefined();
  const leftovers = new ProcessReaper(probes).detect({
    worktreePath: "/wt/x",
    claudeSessionId: "sess-1",
    isolated: true,
  });
  // Fail closed: no class-2 (empty scan) and no class-3 (no listener probe).
  expect(leftovers).toEqual([]);
});

// ── class-2: fail closed too, so `reap()` can't report phantom kills ─────────

test("scanWorktreeProcs: no signal authority ⇒ offers zero class-2 leftovers", () => {
  // A worktree process that WOULD be a class-2 leftover on Linux: right cwd, real
  // listening port, non-agent comm.
  const killed: number[] = [];
  const probes = darwinFake({
    scanProcs: () => [{ pid: 4242, cwd: "/wt/x", comm: "vite" }],
    portsForPid: () => [5173],
    killPid: (pid) => killed.push(pid),
  });
  const reaper = new ProcessReaper(probes);
  const leftovers = reaper.detect({
    worktreePath: "/wt/x",
    claudeSessionId: "sess-1",
    isolated: true,
  });
  // Offering it would put it in the "Terminate & close" list, kill nothing (killPid
  // is inert without signal authority), and still count as reaped — strictly worse
  // than pre-#1912, where an empty scan meant nothing was ever offered.
  expect(leftovers).toEqual([]);
  // And the belt-and-braces: even if a stale key were replayed, nothing is signalled.
  reaper.reap([{ kind: "process", name: "vite", port: 5173, pid: 4242, key: "process:4242" }]);
  expect(killed).toEqual([]);
});

test("scanWorktreeProcs: WITH signal authority the same process is still offered", () => {
  // Guards the fix from over-reaching: the suppression must key on signal
  // authority, not on the presence of a snapshot backend.
  const probes = darwinFake({
    canAuthorizeSignal: true,
    scanProcs: () => [{ pid: 4242, cwd: "/wt/x", comm: "vite" }],
    portsForPid: () => [5173],
  });
  const leftovers = new ProcessReaper(probes).detect({
    worktreePath: "/wt/x",
    claudeSessionId: "sess-1",
    isolated: true,
  });
  expect(leftovers).toHaveLength(1);
  expect(leftovers[0]).toMatchObject({ kind: "process", pid: 4242, port: 5173 });
});

// ── canDetectLeftovers: the gate that stops dead refresh cost ────────────────

test("canDetectLeftovers: false when BOTH leftover classes short-circuit (darwin)", () => {
  // No signal authority ⇒ class-2 suppressed; no listeningPorts ⇒ class-3 suppressed.
  // `detect` therefore cannot return a hit, so callers must skip the refresh that
  // would otherwise cost a full-host lsof scan per session at teardown.
  expect(new ProcessReaper(darwinFake()).canDetectLeftovers()).toBe(false);
});

test("canDetectLeftovers: true as soon as EITHER class becomes possible", () => {
  // class-2 re-armed (what #1922 will do)…
  expect(new ProcessReaper(darwinFake({ canAuthorizeSignal: true })).canDetectLeftovers()).toBe(
    true,
  );
  // …or a uid-agnostic listener set appears, re-enabling class-3.
  expect(
    new ProcessReaper(darwinFake({ listeningPorts: () => new Set([443]) })).canDetectLeftovers(),
  ).toBe(true);
});

test("canDetectLeftovers: true for the Linux backend (live /proc, both classes live)", () => {
  expect(new ProcessReaper(makeDefaultProbes("linux")).canDetectLeftovers()).toBe(true);
});

// ── the | null scan helpers ──────────────────────────────────────────────────

test("scan helpers return null on a stale/none cell, not an all-false / empty map", () => {
  for (const state of ["none", "stale"] as const) {
    const probes = darwinFake({ state });
    expect(scanClaudeAliveByWorktree(["/wt/x"], probes)).toBeNull();
    expect(scanListeningPortsByWorktree(["/wt/x"], probes)).toBeNull();
    expect(liveProcCwds(probes)).toBeNull();
  }
});

test("scan helpers return a real map on a fresh cell", () => {
  const probes = darwinFake({
    state: "fresh",
    scanProcs: () => [{ pid: 1, cwd: "/wt/x", comm: "claude" }],
  });
  expect(scanClaudeAliveByWorktree(["/wt/x"], probes)!.get("/wt/x")).toBe(true);
  expect(liveProcCwds(probes)).toEqual(["/wt/x"]);
});

// ── nullProbes (unsupported platform) ────────────────────────────────────────

test("makeDefaultProbes(win32): scan helpers return null so fail-open sweeps skip", () => {
  const probes = makeDefaultProbes("win32");
  expect(scanClaudeAliveByWorktree(["/wt/x"], probes)).toBeNull();
  expect(liveProcCwds(probes)).toBeNull();
  // And it authorizes no signals.
  expect(new ProcessReaper(probes).stopListenersOnPort("/wt/x", 5173)).toEqual({
    signalled: 0,
    unsupported: true,
  });
});

// ── #1144 runaway reaper stays fail-closed on darwin (no environ probe) ───────

test("reapMarkedOrphans: darwin backend (no environForPid) reaps nothing", () => {
  const probes = darwinFake({
    listPids: () => [4242],
    commForPid: () => "node",
    // no environForPid / cpuStatForPid / uptimeSeconds ⇒ fail closed
  });
  const r = reapMarkedOrphans({
    sessionStatus: () => "archived",
    mode: "armed",
    minCpu: 0,
    minAgeS: 0,
    probes,
  });
  expect(r.reaped).toBe(0);
});

// ── normalizeRoot is applied at attribution sites ────────────────────────────

test("scanClaudeAliveByWorktree: applies normalizeRoot to the stored root", () => {
  // A backend whose normalizeRoot rewrites the query root to match the process cwd.
  const probes = darwinFake({
    scanProcs: () => [{ pid: 1, cwd: "/private/var/wt/x", comm: "claude" }],
    normalizeRoot: (p) => (p === "/var/wt/x" ? "/private/var/wt/x" : p),
  });
  const map = scanClaudeAliveByWorktree(["/var/wt/x"], probes);
  // Without normalizeRoot the stored /var/wt/x would never match /private/var/wt/x.
  expect(map!.get("/var/wt/x")).toBe(true);
});
