import { test, expect } from "bun:test";
import {
  parseLsofFields,
  makeDarwinProbes,
  commBasename,
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
