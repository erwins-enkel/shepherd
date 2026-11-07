import { describe, expect, test } from "bun:test";
import {
  CURRENT,
  type CalSample,
  budgetFor,
  capFor,
  episodes,
  labelUnhealthy,
  linearFit,
  meminfoBytes,
  metrics,
  percentile,
  psiValue,
  replay,
  select,
  statIds,
  statusRss,
  toTicks,
  treePids,
  vmstatOomKill,
  type Tick,
  type Trace,
} from "../scripts/pressure-calibration/core";

// The pure core of the pressure-brake calibration harness (#3589): parsers, labelling, replay and
// the selection rule that turns measured traces into brake defaults.

const GIB = 1024 ** 3;
const MEM = 16 * GIB;

function sample(t: number, over: Partial<CalSample> = {}): CalSample {
  return {
    t,
    phase: "ramp",
    memTotal: MEM,
    memAvailable: 10 * GIB,
    swapTotal: 0,
    swapFree: 0,
    memSome10: 0,
    memFull10: 0,
    memSome60: 0,
    memFull60: 0,
    cpuSome10: 0,
    ioFull10: 0,
    oomKill: 0,
    lanes: 1,
    loadRss: 0,
    probeMs: Array(10).fill(2),
    ...over,
  };
}

describe("parsers", () => {
  test("meminfo, PSI and vmstat", () => {
    const meminfo = "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\nSwapFree: 0 kB\n";
    expect(meminfoBytes(meminfo, "MemTotal")).toBe(16384000 * 1024);
    expect(meminfoBytes(meminfo, "SwapFree")).toBe(0);
    expect(meminfoBytes(meminfo, "SwapTotal")).toBeNull();
    const psi =
      "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=4.25 avg60=1.10 avg300=0.00 total=2\n";
    expect(psiValue(psi, "some", "avg10")).toBe(12.5);
    expect(psiValue(psi, "full", "avg60")).toBe(1.1);
    expect(psiValue("some avg10=1.00 avg60=0 avg300=0 total=0\n", "full", "avg10")).toBeNull();
    expect(vmstatOomKill("pgfault 1\noom_kill 3\n")).toBe(3);
    expect(vmstatOomKill("pgfault 1\n")).toBeNull();
  });

  test("stat ids survive a comm with spaces and parens", () => {
    expect(statIds("42 (Web (Content) x) S 7 42 42 0 -1")).toEqual({ ppid: 7, pgrp: 42 });
    expect(statIds("garbage")).toBeNull();
    expect(statusRss("Name:\tx\nVmRSS:\t  2048 kB\n")).toBe(2048 * 1024);
    expect(statusRss("Name:\tkthreadd\n")).toBe(0);
  });

  test("treePids follows children and orphans that kept the group", () => {
    const procs = new Map([
      [10, { ppid: 1, pgrp: 10 }],
      [11, { ppid: 10, pgrp: 10 }],
      [12, { ppid: 11, pgrp: 99 }],
      [13, { ppid: 1, pgrp: 10 }],
      [20, { ppid: 1, pgrp: 20 }],
    ]);
    expect([...treePids(procs, [10])].toSorted()).toEqual([10, 11, 12, 13]);
    expect([...treePids(procs, [404])]).toEqual([]);
  });
});

describe("labelling", () => {
  test("percentile is nearest-rank", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });

  test("slow probes count only while memory stalls; an OOM kill always counts", () => {
    const slow = Array(10).fill(400);
    const s = [
      sample(0),
      sample(1000, { probeMs: slow, memSome10: 2 }),
      sample(2000, { probeMs: slow, memSome10: 15 }),
      sample(3000, { oomKill: 1 }),
      sample(4000, { oomKill: 1 }),
    ];
    expect(labelUnhealthy(s)).toEqual([false, false, true, true, false]);
  });

  test("the window looks back 10 s", () => {
    const s = [sample(0, { probeMs: Array(10).fill(900) })];
    for (let t = 1000; t <= 20_000; t += 1000) s.push(sample(t, { memSome10: 20 }));
    const flags = labelUnhealthy(s);
    expect(flags[5]).toBe(true);
    expect(flags[10]).toBe(false);
  });

  test("episodes merge gaps under 30 s", () => {
    const s = [0, 1000, 20_000, 60_000].map((t) => sample(t));
    expect(episodes(s, [true, true, true, true])).toEqual([
      { start: 0, end: 20_000 },
      { start: 60_000, end: 60_000 },
    ]);
  });
});

function trace(ticks: Tick[], over: Partial<Trace> = {}): Trace {
  return {
    label: "t",
    cpus: 4,
    memTotalBytes: MEM,
    ticks,
    episodes: [],
    starts: [],
    ...over,
  };
}

function tick(t: number, availableBytes: number, psiFullAvg10 = 0): Tick {
  return { t, availableBytes, psiFullAvg10, unhealthy: false, laneStarts: 0 };
}

describe("ticks and replay", () => {
  test("toTicks takes the latest sample per 5 s and ORs unhealthy seconds", () => {
    const s = [0, 1000, 2000, 3000, 4000, 5000, 6000, 10_000].map((t, i) =>
      sample(t, { memAvailable: i * GIB }),
    );
    const ticks = toTicks(s, [false, false, true, false, false, false, false, false], [3500]);
    expect(ticks.map((k) => [k.t, k.availableBytes, k.unhealthy, k.laneStarts])).toEqual([
      [0, 0, false, 0],
      [5000, 5 * GIB, true, 1],
      [10_000, 7 * GIB, false, 0],
    ]);
  });

  test("replay engages below the floor and lets go after the hold", () => {
    const b = budgetFor(CURRENT, MEM, 4 * GIB);
    expect(b.minAvailableBytes).toBe(Math.floor(MEM * 0.15));
    const ticks = [0, 5000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000].map((t) =>
      tick(t, t === 5000 ? GIB : 8 * GIB),
    );
    expect(replay(ticks, b)).toEqual([false, true, true, true, true, true, true, true, false]);
  });

  test("metrics: coverage, harmless starts blocked, flaps", () => {
    const ticks = [
      tick(0, 8 * GIB),
      tick(5000, GIB),
      tick(10_000, 8 * GIB),
      tick(15_000, 8 * GIB),
      tick(20_000, GIB),
      tick(25_000, GIB),
    ];
    const tr = trace(ticks, {
      episodes: [{ start: 24_000, end: 30_000 }],
      starts: [2000, 6000, 26_000],
    });
    const engaged = [false, true, false, false, true, true];
    expect(metrics(tr, engaged)).toEqual({ episodes: 1, covered: 1, blocked: 1, flaps: 1 });
  });
});

describe("selection", () => {
  // A ramp where memory falls 1 GiB per tick from 6 GiB; an episode starts once it is below 2 GiB.
  function rampTrace(): Trace {
    const ticks: Tick[] = [];
    for (let k = 0; k < 12; k++) ticks.push(tick(k * 5000, Math.max(0.5, 6 - k * 0.5) * GIB));
    for (let k = 12; k < 40; k++) ticks.push(tick(k * 5000, 8 * GIB));
    return trace(ticks, {
      episodes: [{ start: 40_000, end: 55_000 }],
      starts: [1000, 11_000, 21_000, 31_000],
    });
  }

  test("keeps current when it covers every episode without flapping", () => {
    const sel = select([rampTrace()]);
    expect(sel.current.covered).toBe(1);
    expect(sel.current.flaps).toBe(0);
    expect(sel.keptCurrent).toBe(true);
    expect(sel.chosen).toMatchObject(CURRENT);
  });

  test("adopts a higher floor when current misses the onset", () => {
    const tr = rampTrace();
    tr.episodes = [{ start: 25_000, end: 55_000 }];
    const sel = select([tr]);
    expect(sel.current.covered).toBe(0);
    expect(sel.keptCurrent).toBe(false);
    expect(sel.chosen.covered).toBe(1);
    expect(sel.chosen.fraction).toBeGreaterThan(CURRENT.fraction);
  });
});

describe("cap", () => {
  test("keeps 4 GiB up to it and steps by 0.5 GiB above", () => {
    expect(capFor(3 * GIB)).toBe(4 * GIB);
    expect(capFor(4 * GIB)).toBe(4 * GIB);
    expect(capFor(4.2 * GIB)).toBe(4.5 * GIB);
    expect(capFor(4.5 * GIB)).toBe(5 * GIB);
  });

  test("linearFit", () => {
    expect(linearFit([{ x: 1, y: 3 }])).toBeNull();
    expect(
      linearFit([
        { x: 1, y: 3 },
        { x: 2, y: 5 },
        { x: 4, y: 9 },
      ]),
    ).toEqual({ slope: 2, intercept: 1 });
  });
});
