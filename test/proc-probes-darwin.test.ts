import { test, expect } from "bun:test";
import {
  parseLsofFields,
  makeDarwinProbes,
  commBasename,
  lsofOutcome,
  type LsofRunner,
} from "../src/proc-probes-darwin";
import { makeDefaultProbes } from "../src/process-reaper";

// A captured real `lsof -nP -w +c 0 -F pcfn -d cwd -iTCP -sTCP:LISTEN` block: a
// process (syncthing) contributing BOTH its cwd (fcwd) and two listening sockets
// from ONE invocation — the join the whole design rests on.
const REAL_FIXTURE = `p1258
crunsvc.sh
fcwd
n/home/patrick/Work/flowagent-runner
p1553
csyncthing
fcwd
n/home/patrick
f14
n*:22000
f22
n127.0.0.1:8384
p3365
cuvicorn
fcwd
n/home/ubuntu/faster-whisper-server
f6
n*:8300
`;

// ── parseLsofFields ───────────────────────────────────────────────────────────

test("parseLsofFields: joins cwd + listening ports per process in one pass", () => {
  const procs = parseLsofFields(REAL_FIXTURE);
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  // A process with a cwd but no listening socket.
  expect(byPid.get(1258)).toEqual({
    pid: 1258,
    comm: "runsvc.sh",
    cwd: "/home/patrick/Work/flowagent-runner",
    ports: [],
  });
  // The join: one process, its cwd AND both listening ports, sorted.
  expect(byPid.get(1553)).toEqual({
    pid: 1553,
    comm: "syncthing",
    cwd: "/home/patrick",
    ports: [8384, 22000],
  });
  expect(byPid.get(3365)?.ports).toEqual([8300]);
});

test("parseLsofFields: parses *:PORT, 127.0.0.1:PORT and [::1]:PORT", () => {
  const procs = parseLsofFields(`p10
cnode
fcwd
n/wt/app
f3
n*:5173
f4
n127.0.0.1:9229
f5
n[::1]:3000
`);
  expect(procs[0]!.ports).toEqual([3000, 5173, 9229]);
});

test("parseLsofFields: a process with no cwd record has an empty cwd, not a crash", () => {
  const procs = parseLsofFields(`p10
cnode
f3
n*:5173
`);
  expect(procs[0]).toEqual({ pid: 10, comm: "node", cwd: "", ports: [5173] });
});

test("parseLsofFields: truncated / malformed lines are skipped, not thrown", () => {
  // A stray field before any `p`, a non-numeric pid, and a truncated final block.
  const procs = parseLsofFields(`n/orphan
pxyz
cbad
p10
cnode
fcwd
n/wt/app
p11
c`);
  const pids = procs.map((p) => p.pid);
  expect(pids).toEqual([10, 11]);
  expect(procs.find((p) => p.pid === 10)!.cwd).toBe("/wt/app");
  expect(procs.find((p) => p.pid === 11)!.comm).toBe("");
});

test("parseLsofFields: empty input → no processes", () => {
  expect(parseLsofFields("")).toEqual([]);
});

// ── lsofOutcome: truncated output must never be treated as complete ──────────

test("lsofOutcome: a clean run resolves its stdout", () => {
  expect(lsofOutcome(null, REAL_FIXTURE)).toEqual({ ok: true, stdout: REAL_FIXTURE });
});

test("lsofOutcome: a plain non-zero exit WITH output is complete (lsof exits 1 on no match)", () => {
  const err = Object.assign(new Error("exit 1"), { code: 1 });
  expect(lsofOutcome(err, REAL_FIXTURE)).toEqual({ ok: true, stdout: REAL_FIXTURE });
});

test("lsofOutcome: a TIMEOUT-killed run is rejected even though it printed output", () => {
  // The regression: Node sets killed/signal when the 3s timeout fires. Resolving
  // this partial output would stamp the cell fresh over an INCOMPLETE process list,
  // turning every missing process into a false negative (husk/stranded, torn-down
  // previews, a weakened fail-open live-cwd guard).
  const err = Object.assign(new Error("timeout"), { killed: true, signal: "SIGKILL" });
  expect(lsofOutcome(err, REAL_FIXTURE)).toEqual({ ok: false, reason: "truncated" });
});

test("lsofOutcome: a maxBuffer overflow is rejected (output cut mid-stream)", () => {
  const err = Object.assign(new Error("maxBuffer"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
  expect(lsofOutcome(err, REAL_FIXTURE)).toEqual({ ok: false, reason: "truncated" });
});

test("lsofOutcome: a spawn failure with no output is rejected", () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  expect(lsofOutcome(err, "")).toEqual({ ok: false, reason: "failed" });
});

test("darwin probes: a truncated run leaves the cell untouched, never stamping it fresh", async () => {
  let clock = 1_000_000;
  let mode: "ok" | "truncate" = "ok";
  const probes = makeDarwinProbes({
    run: async () => {
      if (mode === "truncate") {
        // What the real runner now does for a killed/over-buffered run.
        throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGKILL" });
      }
      return REAL_FIXTURE;
    },
    now: () => clock,
  });
  await probes.refresh();
  const good = probes.scanProcs().length;
  expect(good).toBeGreaterThan(0);

  mode = "truncate";
  clock += 5000;
  await probes.refresh({ force: true });
  // The last good snapshot is retained in full — not narrowed to the partial read.
  expect(probes.scanProcs().length).toBe(good);
  // And the success stamp did NOT advance, so the cell ages honestly into "stale"
  // rather than presenting a truncated list as authoritative.
  clock = 1_000_000 + 12_001;
  expect(probes.snapshotState()).toBe("stale");
});

test("darwin probes: a run parsing to ZERO processes is not stamped fresh", async () => {
  // `-d cwd` selects every visible process, so an empty parse means the run wasn't
  // usable — not "nothing is running". Stamping it would assert a negative verdict
  // about every process on the host: all sessions dead, all port sets empty, and
  // `liveProcCwds` returning [] into a FAIL-OPEN guard.
  const probes = makeDarwinProbes({ run: async () => "", now: () => 1_000_000 });
  await probes.refresh();
  expect(probes.snapshotState()).toBe("none");
  expect(probes.scanProcs()).toEqual([]); // empty because UNKNOWN, not because fresh-and-empty
});

test("darwin probes: an empty parse never overwrites a good snapshot", async () => {
  let clock = 1_000_000;
  let mode: "ok" | "empty" = "ok";
  const probes = makeDarwinProbes({
    run: async () => (mode === "empty" ? "" : REAL_FIXTURE),
    now: () => clock,
  });
  await probes.refresh();
  const good = probes.scanProcs().length;
  expect(good).toBeGreaterThan(0);

  mode = "empty";
  clock += 5000;
  await probes.refresh({ force: true });
  expect(probes.scanProcs().length).toBe(good); // last good snapshot retained
  clock = 1_000_000 + 12_001;
  expect(probes.snapshotState()).toBe("stale"); // aged honestly, not re-stamped
});

// ── makeDarwinProbes: cell + snapshotState ───────────────────────────────────

/** A runner returning a fixed snapshot, tracking call count. */
function countingRunner(text: string): { run: LsofRunner; calls: () => number } {
  let n = 0;
  return {
    run: async () => {
      n++;
      return text;
    },
    calls: () => n,
  };
}

test("darwin probes: snapshotState is 'none' before any successful refresh", () => {
  const probes = makeDarwinProbes({ run: async () => "" });
  expect(probes.snapshotState!()).toBe("none");
  expect(probes.scanProcs()).toEqual([]);
  expect(probes.listPids!()).toEqual([]);
});

test("darwin probes: after a successful refresh, scanProcs/portsForPid read the cell", async () => {
  const probes = makeDarwinProbes({ run: async () => REAL_FIXTURE, now: () => 1000 });
  await probes.refresh!();
  expect(probes.snapshotState!()).toBe("fresh");
  const procs = probes.scanProcs();
  expect(procs.find((p) => p.pid === 1553)).toEqual({
    pid: 1553,
    cwd: "/home/patrick",
    comm: "syncthing",
  });
  expect(probes.portsForPid(1553)).toEqual([8384, 22000]);
  expect(probes.commForPid!(1553)).toBe("syncthing");
  expect(probes.cwdForPid!(1553)).toBe("/home/patrick");
});

test("darwin probes: canAuthorizeSignal is false and listeningPorts is omitted", () => {
  const probes = makeDarwinProbes({ run: async () => "" });
  expect(probes.canAuthorizeSignal).toBe(false);
  expect(probes.listeningPorts).toBeUndefined();
});

test("darwin probes: snapshotState goes 'stale' past maxNegativeAgeMs, keeping last data", async () => {
  let clock = 1000;
  const probes = makeDarwinProbes({ run: async () => REAL_FIXTURE, now: () => clock });
  await probes.refresh!();
  expect(probes.snapshotState!()).toBe("fresh");
  // Default previewSweepMs=4000 ⇒ maxNegativeAgeMs = 2*4000 + 3000 + 1000 = 12000.
  clock = 1000 + 12001;
  expect(probes.snapshotState!()).toBe("stale");
  // Data is retained (not emptied) even while stale.
  expect(probes.portsForPid(1553)).toEqual([8384, 22000]);
});

// ── failure semantics ─────────────────────────────────────────────────────────

test("darwin probes: a failed refresh preserves data and never stamps success", async () => {
  let clock = 1000;
  let mode: "ok" | "throw" = "ok";
  const probes = makeDarwinProbes({
    run: async () => {
      if (mode === "throw") throw new Error("lsof gone");
      return REAL_FIXTURE;
    },
    now: () => clock,
  });
  await probes.refresh!();
  expect(probes.snapshotState!()).toBe("fresh");

  clock = 2000;
  mode = "throw";
  await probes.refresh!({ force: true });
  // Data unchanged; success stamp NOT advanced (age is measured from 1000, not 2000),
  // so a later read still sees the old snapshot as fresh-until-12s-from-1000.
  expect(probes.scanProcs().length).toBeGreaterThan(0);
  clock = 1000 + 12001;
  expect(probes.snapshotState!()).toBe("stale");
});

// ── coalescing + single-flight + forced/budget ───────────────────────────────

test("darwin probes: overlapping non-forced refreshes spawn the runner exactly once", async () => {
  const { run, calls } = countingRunner(REAL_FIXTURE);
  const probes = makeDarwinProbes({ run });
  await Promise.all([probes.refresh!(), probes.refresh!(), probes.refresh!()]);
  expect(calls()).toBe(1);
});

test("darwin probes: a non-forced refresh within the TTL is a no-op (coalesced)", async () => {
  const { run, calls } = countingRunner(REAL_FIXTURE);
  let clock = 1000;
  const probes = makeDarwinProbes({ run, now: () => clock });
  await probes.refresh!();
  expect(calls()).toBe(1);
  // refreshTtlMs = max(250, 4000/2) = 2000; within it, no new spawn.
  clock = 1500;
  await probes.refresh!();
  expect(calls()).toBe(1);
});

test("darwin probes: an ALWAYS-failing runner is still rate-limited by the TTL", async () => {
  // Regression: the coalescing window must gate on the last ATTEMPT, not the last
  // success — otherwise a host whose `lsof` always fails would spawn every tick
  // (the poller ticks at 1s) instead of once per window.
  const { run, calls } = (() => {
    let n = 0;
    return {
      run: (async () => {
        n++;
        throw new Error("no lsof");
      }) as LsofRunner,
      calls: () => n,
    };
  })();
  let clock = 1_000_000;
  const probes = makeDarwinProbes({ run, now: () => clock });
  await probes.refresh();
  expect(calls()).toBe(1);
  clock += 500; // well inside refreshTtlMs (2000)
  await probes.refresh();
  clock += 500;
  await probes.refresh();
  expect(calls()).toBe(1); // no extra spawns despite never succeeding
  clock += 2000; // past the window
  await probes.refresh();
  expect(calls()).toBe(2);
  // Still never successfully refreshed ⇒ verdicts stay "unknown".
  expect(probes.snapshotState()).toBe("none");
});

test("darwin probes: a forced refresh mid-flight adds exactly one more run", async () => {
  let n = 0;
  let releaseFirst: (() => void) | null = null;
  const run: LsofRunner = () => {
    n++;
    if (n === 1) {
      return new Promise<string>((resolve) => {
        releaseFirst = () => resolve(REAL_FIXTURE);
      });
    }
    return Promise.resolve(REAL_FIXTURE);
  };
  const probes = makeDarwinProbes({ run });
  const first = probes.refresh!(); // starts run #1, hangs
  const forcedA = probes.refresh!({ force: true });
  const forcedB = probes.refresh!({ force: true });
  releaseFirst!();
  await Promise.all([first, forcedA, forcedB]);
  // run #1 (the in-flight) + exactly ONE more chained run shared by both forced callers.
  expect(n).toBe(2);
});

test("darwin probes: a forced refresh returns within budget when the runner never resolves", async () => {
  const probes = makeDarwinProbes({
    run: () => new Promise<string>(() => {}), // never resolves
    budgetMs: 30,
  });
  const start = Date.now();
  await probes.refresh!({ force: true }); // must not hang past the budget
  expect(Date.now() - start).toBeLessThan(2000);
  // Cell never got data — still "none", so downstream verdicts stay unknown.
  expect(probes.snapshotState!()).toBe("none");
});

// ── normalizeRoot ─────────────────────────────────────────────────────────────

test("darwin probes: normalizeRoot resolves symlinks and memoises per refresh", async () => {
  // The current working directory realpaths to itself; a non-existent path falls
  // back to its input. Both are stable, which is enough to exercise the seam.
  const probes = makeDarwinProbes({ run: async () => "" });
  const missing = "/no/such/worktree/root";
  expect(probes.normalizeRoot!(missing)).toBe(missing);
  // Memoised: a second call returns the cached value.
  expect(probes.normalizeRoot!(missing)).toBe(missing);
});

// ── platform dispatch (pure selector) ────────────────────────────────────────

test("makeDefaultProbes: darwin selects a snapshot backend; win32 fails closed", () => {
  const darwin = makeDefaultProbes("darwin");
  expect(darwin.canAuthorizeSignal).toBe(false);
  expect(darwin.snapshotState!()).toBe("none"); // cold cell
  expect(darwin.listeningPorts).toBeUndefined();

  const win = makeDefaultProbes("win32");
  // The load-bearing line: win32 reports "none" (not the absent⇒fresh default), so
  // the `| null`-returning scan helpers report "unknown" and the fail-open sweeps skip.
  expect(win.snapshotState!()).toBe("none");
  expect(win.canAuthorizeSignal).toBe(false);
  expect(win.scanProcs()).toEqual([]);

  const linux = makeDefaultProbes("linux");
  // Linux reads live /proc: no snapshotState (absent ⇒ fresh), signals authorized.
  expect(linux.snapshotState).toBeUndefined();
  expect(linux.canAuthorizeSignal).toBeUndefined();
});

test("commBasename: basenames a path-form comm, leaves a bare name untouched", () => {
  expect(commBasename("/usr/local/bin/claude")).toBe("claude");
  expect(commBasename("claude")).toBe("claude");
});

// ── #1922: the signal window ─────────────────────────────────────────────────
//
// The kill-age bound is deliberately NOT `maxNegativeAgeMs` (which scales with
// `config.previewSweepMs`): a negative verdict merely delays a teardown when wrong,
// a signal is a SIGKILL. These pin that it is its own, tighter clock.

test("signalWindowOpen: false on a cold cell — no snapshot can authorize a signal", () => {
  const probes = makeDarwinProbes({ run: async () => REAL_FIXTURE, now: () => 1000 });
  expect(probes.signalWindowOpen()).toBe(false);
});

test("signalWindowOpen: false when the only refresh FAILED (cell never stamped)", async () => {
  const probes = makeDarwinProbes({
    run: async () => {
      throw new Error("no lsof");
    },
    now: () => 1000,
  });
  await probes.refresh();
  expect(probes.signalWindowOpen()).toBe(false);
});

test("signalWindowOpen: true inside the bound, false once past it", async () => {
  let clock = 1_000_000;
  const probes = makeDarwinProbes({ run: async () => REAL_FIXTURE, now: () => clock });
  await probes.refresh();
  // Default bound is 10s and the fixture run took 0ms of injected time.
  clock += 9_999;
  expect(probes.signalWindowOpen()).toBe(true);
  clock += 2;
  expect(probes.signalWindowOpen()).toBe(false);
});

test("signalWindowOpen: a slow lsof sample widens the bound by its own duration", async () => {
  // `successAt` is a START stamp, so a run that itself took 5s reports 5s of age the
  // instant it lands. Without the sample-duration term a slow sampler could never
  // authorize a signal at all.
  let clock = 1_000_000;
  const probes = makeDarwinProbes({
    run: async () => {
      clock += 5_000; // the run itself burns 5s
      return REAL_FIXTURE;
    },
    now: () => clock,
  });
  await probes.refresh();
  expect(clock - 1_000_000).toBe(5_000); // sanity: the sample really was slow
  // 5s of apparent age already; 10s bound + 5s sample = 15s of headroom from the START.
  clock = 1_000_000 + 14_999;
  expect(probes.signalWindowOpen()).toBe(true);
  clock = 1_000_000 + 15_001;
  expect(probes.signalWindowOpen()).toBe(false);
});

// ── #1922: liveProcForPid (per-pid re-verification) ──────────────────────────

/** `lsof -F pcfn -a -p <pid> -d cwd` output for one process. */
const cwdRun = (pid: number, comm: string, cwd: string) => `p${pid}\nc${comm}\nfcwd\nn${cwd}\n`;
/** `lsof -F pcfn -a -p <pid> -iTCP -sTCP:LISTEN` output for one process. */
const portRun = (pid: number, comm: string, ports: number[]) =>
  `p${pid}\nc${comm}\n` + ports.map((p, i) => `f${i + 3}\nn*:${p}\n`).join("");

/** Route the two verification runs by which selectors they carry. */
function verifyRouter(cwdOut: string | null, portOut: string | null) {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): string | null => {
    calls.push([...args]);
    return args.includes("-d") ? cwdOut : portOut;
  };
  return { runner, calls };
}

test("liveProcForPid: returns live cwd/comm/ports, joined from the two targeted runs", () => {
  const { runner, calls } = verifyRouter(
    cwdRun(4242, "/usr/local/bin/node", "/wt/x"),
    portRun(4242, "/usr/local/bin/node", [5173]),
  );
  const probes = makeDarwinProbes({ run: async () => "", verifyRun: runner });
  expect(probes.liveProcForPid(4242)).toEqual({
    cwd: "/wt/x",
    comm: "node", // basenamed, matching /proc/<pid>/comm semantics
    ports: [5173],
  });
  // Two spawns, both ANDed onto -p with -a; `-a` ANDs ALL selectors, which is exactly
  // why `-d cwd` and `-iTCP` cannot share one run.
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(["-nP", "-w", "+c", "0", "-F", "pcfn", "-a", "-p", "4242", "-d", "cwd"]);
  expect(calls[1]).toEqual([
    "-nP",
    "-w",
    "+c",
    "0",
    "-F",
    "pcfn",
    "-a",
    "-p",
    "4242",
    "-iTCP",
    "-sTCP:LISTEN",
  ]);
});

test("liveProcForPid: does NOT read the snapshot cell — a pid absent from it still verifies", async () => {
  // The whole point: the cell proposes candidates, live data authorizes them.
  const { runner } = verifyRouter(cwdRun(9999, "node", "/wt/x"), portRun(9999, "node", [5173]));
  const probes = makeDarwinProbes({ run: async () => REAL_FIXTURE, verifyRun: runner });
  await probes.refresh();
  expect(probes.cwdForPid!(9999)).toBeNull(); // not in the fixture
  expect(probes.liveProcForPid(9999)?.cwd).toBe("/wt/x");
});

test("liveProcForPid: null when the cwd run fails (spawn error / timeout / no match)", () => {
  const { runner } = verifyRouter(null, portRun(4242, "node", [5173]));
  const probes = makeDarwinProbes({ run: async () => "", verifyRun: runner });
  expect(probes.liveProcForPid(4242)).toBeNull();
});

test("liveProcForPid: null when the port run fails — a pid with no listener is not our server", () => {
  const { runner } = verifyRouter(cwdRun(4242, "node", "/wt/x"), null);
  const probes = makeDarwinProbes({ run: async () => "", verifyRun: runner });
  expect(probes.liveProcForPid(4242)).toBeNull();
});

test("liveProcForPid: null on empty output, and on output for a DIFFERENT pid", () => {
  const empty = makeDarwinProbes({ run: async () => "", verifyRun: () => "" });
  expect(empty.liveProcForPid(4242)).toBeNull();

  // Defensive: never accept a block lsof reported for some other process.
  const { runner } = verifyRouter(cwdRun(1111, "node", "/wt/x"), portRun(1111, "node", [5173]));
  const wrongPid = makeDarwinProbes({ run: async () => "", verifyRun: runner });
  expect(wrongPid.liveProcForPid(4242)).toBeNull();
});

test("liveProcForPid: null when the pid listens on nothing (empty port set)", () => {
  const { runner } = verifyRouter(cwdRun(4242, "node", "/wt/x"), portRun(4242, "node", []));
  const probes = makeDarwinProbes({ run: async () => "", verifyRun: runner });
  expect(probes.liveProcForPid(4242)).toBeNull();
});

test("liveProcForPid: refuses a non-integer / non-positive pid without spawning", () => {
  const calls: string[][] = [];
  const probes = makeDarwinProbes({
    run: async () => "",
    verifyRun: (args) => {
      calls.push([...args]);
      return cwdRun(1, "init", "/");
    },
  });
  for (const bad of [0, -1, 1, 1.5, NaN]) {
    expect(probes.liveProcForPid(bad)).toBeNull();
  }
  expect(calls).toEqual([]); // nothing ever reached `-p`
});
