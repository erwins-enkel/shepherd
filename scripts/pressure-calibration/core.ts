// Pressure-brake calibration (#3589) — the pure core shared by run.ts (measurement) and analyze.ts
// (evaluation): /proc parsers, the record shapes both sides agree on, unhealthy-second labelling,
// 5 s downsampling, replay of a trace through the real brake (`nextBrake`) and the selection rule
// documented in docs/verification/pressure-brake-3589.md. No I/O.

import {
  BRAKE_OFF,
  nextBrake,
  type BrakeState,
  type HeavySlotBudget,
} from "../../src/heavy-slot-core";

const GIB = 1024 ** 3;

// ── Records ───────────────────────────────────────────────────────────────────────────────────

/** One sampler row, written once per second by run.ts. Times are ms since the run started. */
export interface CalSample {
  t: number;
  phase: Phase;
  memTotal: number | null;
  memAvailable: number | null;
  swapTotal: number | null;
  swapFree: number | null;
  memSome10: number | null;
  memFull10: number | null;
  memSome60: number | null;
  memFull60: number | null;
  cpuSome10: number | null;
  ioFull10: number | null;
  oomKill: number | null;
  /** Lanes holding a running load lane (ramp phase), 0 elsewhere. */
  lanes: number;
  /** Summed process-tree RSS of every running command, bytes. */
  loadRss: number;
  /** Probe round trips completed during this second, ms (a timeout counts as PROBE_TIMEOUT_MS). */
  probeMs: number[];
}

export type Phase = "prepare" | "baseline" | "sweep" | "settle" | "ramp" | "cooldown";

export type CalEvent =
  | {
      t: number;
      kind: "meta";
      cpus: number;
      memTotal: number;
      kernel: string;
      config: Record<string, unknown>;
    }
  | { t: number; kind: "phase"; phase: Phase }
  | { t: number; kind: "lane_start" | "lane_stop"; lane: number }
  | { t: number; kind: "lane_skip"; lane: number; reason: string }
  | {
      t: number;
      kind: "cmd_end";
      phase: Phase;
      lane: number | null;
      workload: string;
      workers: number | null;
      startT: number;
      durationMs: number;
      exitCode: number | null;
      peakRss: number;
    };

export const PROBE_TIMEOUT_MS = 5_000;

// ── /proc parsers ─────────────────────────────────────────────────────────────────────────────

/** A `/proc/meminfo` field (kB) in bytes, or null. */
export function meminfoBytes(meminfo: string, field: string): number | null {
  const m = meminfo.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m"));
  return m ? Number(m[1]) * 1024 : null;
}

/** `avg10`/`avg60` of a `/proc/pressure/<res>` line, or null when absent. */
export function psiValue(
  psi: string,
  line: "some" | "full",
  key: "avg10" | "avg60",
): number | null {
  const row = psi.split("\n").find((l) => l.startsWith(`${line} `));
  const m = row?.match(new RegExp(`${key}=(\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : null;
}

/** The `oom_kill` counter of `/proc/vmstat`, or null. */
export function vmstatOomKill(vmstat: string): number | null {
  const m = vmstat.match(/^oom_kill (\d+)$/m);
  return m ? Number(m[1]) : null;
}

/** ppid and process group of a `/proc/<pid>/stat` line (comm may contain spaces and parens). */
export function statIds(stat: string): { ppid: number; pgrp: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat.slice(close + 2).split(" ");
  const ppid = Number(f[1]);
  const pgrp = Number(f[2]);
  return Number.isInteger(ppid) && Number.isInteger(pgrp) ? { ppid, pgrp } : null;
}

/** `VmRSS` of a `/proc/<pid>/status` file in bytes; 0 for kernel threads and unreadable files. */
export function statusRss(status: string): number {
  const m = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return m ? Number(m[1]) * 1024 : 0;
}

/** Every pid in `roots`' trees: descendants by ppid plus members of the roots' process groups
 *  (an orphan reparented to init keeps its group). */
export function treePids(
  procs: ReadonlyMap<number, { ppid: number; pgrp: number }>,
  roots: readonly number[],
): Set<number> {
  const out = new Set<number>(roots.filter((r) => procs.has(r)));
  const groups = new Set(roots);
  for (const [pid, p] of procs) if (groups.has(p.pgrp)) out.add(pid);
  const children = new Map<number, number[]>();
  for (const [pid, p] of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
  const stack = [...out];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      stack.push(c);
    }
  }
  return out;
}

// ── Labelling ─────────────────────────────────────────────────────────────────────────────────

export const UNHEALTHY_P95_MS = 250;
export const UNHEALTHY_WINDOW_MS = 10_000;
export const UNHEALTHY_MEM_SOME = 10;
export const EPISODE_MERGE_MS = 30_000;

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}

/**
 * Unhealthy seconds: probe p95 over the trailing 10 s window above 250 ms while memory PSI `some
 * avg10` ≥ 10 (memory is part of the stall, not just CPU), or an OOM kill since the last sample.
 */
export function labelUnhealthy(samples: readonly CalSample[]): boolean[] {
  const out: boolean[] = [];
  let lo = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    while (samples[lo]!.t <= s.t - UNHEALTHY_WINDOW_MS) lo++;
    const window = samples.slice(lo, i + 1).flatMap((x) => x.probeMs);
    const p95 = percentile(window, 95);
    const prevOom = i > 0 ? samples[i - 1]!.oomKill : null;
    const oom = s.oomKill !== null && prevOom !== null && s.oomKill > prevOom;
    const slow = p95 !== null && p95 > UNHEALTHY_P95_MS && (s.memSome10 ?? 0) >= UNHEALTHY_MEM_SOME;
    out.push(oom || slow);
  }
  return out;
}

export interface Episode {
  start: number;
  end: number;
}

/** Maximal runs of unhealthy seconds, runs separated by less than 30 s merged. */
export function episodes(samples: readonly CalSample[], unhealthy: readonly boolean[]): Episode[] {
  const out: Episode[] = [];
  samples.forEach((s, i) => {
    if (!unhealthy[i]) return;
    const last = out.at(-1);
    if (last && s.t - last.end < EPISODE_MERGE_MS) last.end = s.t;
    else out.push({ start: s.t, end: s.t });
  });
  return out;
}

// ── Ticks and replay ──────────────────────────────────────────────────────────────────────────

/** The service's sweep interval (`TICK_MS` in src/heavy-slot.ts): the brake sees one sample per tick. */
export const TICK_MS = 5_000;

export interface Tick {
  t: number;
  availableBytes: number | null;
  psiFullAvg10: number | null;
  unhealthy: boolean;
  laneStarts: number;
}

export interface Trace {
  label: string;
  cpus: number;
  memTotalBytes: number;
  ticks: Tick[];
  episodes: Episode[];
  /** Times of actual ramp lane starts. */
  starts: number[];
  /** Every ramp job: each lane loops its workloads, and the brake gates each job's start. `end` is
   *  null for a job still running when the trace ends. */
  jobs: Job[];
}

export interface Job {
  start: number;
  end: number | null;
}

/** One tick per 5 s from the first sample: the latest sample at or before the tick, any unhealthy
 *  second and every lane start since the previous tick. */
export function toTicks(
  samples: readonly CalSample[],
  unhealthy: readonly boolean[],
  starts: readonly number[],
): Tick[] {
  if (samples.length === 0) return [];
  const ticks: Tick[] = [];
  let i = 0;
  for (let T = samples[0]!.t; T <= samples.at(-1)!.t; T += TICK_MS) {
    let bad = false;
    while (i + 1 < samples.length && samples[i + 1]!.t <= T) {
      i++;
      if (unhealthy[i]) bad = true;
    }
    if (ticks.length === 0) bad = unhealthy[0] ?? false;
    const s = samples[i]!;
    ticks.push({
      t: T,
      availableBytes: s.memAvailable,
      psiFullAvg10: s.memFull10,
      unhealthy: bad,
      laneStarts: starts.filter((x) => x > T - TICK_MS && x <= T).length,
    });
  }
  return ticks;
}

/** The brake state after each tick, folded through the real `nextBrake`. */
export function replay(ticks: readonly Tick[], budget: HeavySlotBudget): boolean[] {
  let brake: BrakeState = BRAKE_OFF;
  return ticks.map((k) => {
    brake = nextBrake(
      brake,
      { availableBytes: k.availableBytes, psiFullAvg10: k.psiFullAvg10 },
      budget,
      k.t,
    );
    return brake.engaged;
  });
}

export const FLAP_WINDOW_MS = 60_000;

export interface ReplayMetrics {
  episodes: number;
  /** Episodes whose onset tick finds the brake engaged. */
  covered: number;
  /** Job starts the brake would have held back that ran into an unhealthy episode. */
  held: number;
  /** Job starts the brake would have held back that never overlapped an episode. */
  blocked: number;
  /** Re-engagements within 60 s of a release. */
  flaps: number;
}

export function metrics(trace: Trace, engaged: readonly boolean[]): ReplayMetrics {
  const tickAt = (t: number) => {
    let k = -1;
    while (k + 1 < trace.ticks.length && trace.ticks[k + 1]!.t <= t) k++;
    return k;
  };
  let covered = 0;
  for (const e of trace.episodes) {
    const k = trace.ticks.findIndex((x) => x.t >= e.start);
    if (k >= 0 && engaged[k]) covered++;
  }
  let held = 0;
  let blocked = 0;
  for (const j of trace.jobs) {
    const k = tickAt(j.start);
    if (k < 0 || !engaged[k]) continue;
    const end = j.end ?? Infinity;
    if (trace.episodes.some((e) => j.start < e.end && end > e.start)) held++;
    else blocked++;
  }
  let flaps = 0;
  let releasedAt: number | null = null;
  engaged.forEach((on, k) => {
    const t = trace.ticks[k]!.t;
    if (k > 0 && engaged[k - 1] && !on) releasedAt = t;
    if (k > 0 && !engaged[k - 1] && on && releasedAt !== null && t - releasedAt < FLAP_WINDOW_MS)
      flaps++;
  });
  return { episodes: trace.episodes.length, covered, held, blocked, flaps };
}

// ── Candidates and selection ──────────────────────────────────────────────────────────────────

export interface Candidate {
  /** minAvailable as a fraction of RAM (before the absolute cap). */
  fraction: number;
  psiFullMax: number;
  releaseHoldMs: number;
}

/** The pre-calibration defaults (#3589): the baseline the selection compares against. */
export const CURRENT: Candidate = { fraction: 0.15, psiFullMax: 20, releaseHoldMs: 30_000 };
export const CURRENT_CAP_BYTES = 4 * GIB;

export const GRID: readonly Candidate[] = [0.05, 0.075, 0.1, 0.125, 0.15, 0.2, 0.25].flatMap(
  (fraction) =>
    [5, 10, 15, 20, 30, 40].flatMap((psiFullMax) =>
      [15_000, 30_000, 60_000, 90_000].map((releaseHoldMs) => ({
        fraction,
        psiFullMax,
        releaseHoldMs,
      })),
    ),
);

export function budgetFor(c: Candidate, memTotalBytes: number, capBytes: number): HeavySlotBudget {
  return {
    slots: 1,
    minAvailableBytes: Math.min(capBytes, Math.floor(memTotalBytes * c.fraction)),
    psiFullMax: c.psiFullMax,
    releaseHoldMs: c.releaseHoldMs,
  };
}

export interface Scored extends Candidate {
  covered: number;
  episodes: number;
  held: number;
  blocked: number;
  flaps: number;
}

/** A candidate's metrics summed over every trace. */
export function score(c: Candidate, traces: readonly Trace[], capBytes: number): Scored {
  const total: Scored = { ...c, covered: 0, episodes: 0, held: 0, blocked: 0, flaps: 0 };
  for (const tr of traces) {
    const m = metrics(tr, replay(tr.ticks, budgetFor(c, tr.memTotalBytes, capBytes)));
    total.covered += m.covered;
    total.episodes += m.episodes;
    total.held += m.held;
    total.blocked += m.blocked;
    total.flaps += m.flaps;
  }
  return total;
}

function sameCandidate(a: Candidate, b: Candidate): boolean {
  return (
    a.fraction === b.fraction &&
    a.psiFullMax === b.psiFullMax &&
    a.releaseHoldMs === b.releaseHoldMs
  );
}

function distance(c: Candidate): number {
  return (
    Math.abs(c.fraction - CURRENT.fraction) / CURRENT.fraction +
    Math.abs(c.psiFullMax - CURRENT.psiFullMax) / CURRENT.psiFullMax +
    Math.abs(c.releaseHoldMs - CURRENT.releaseHoldMs) / CURRENT.releaseHoldMs
  );
}

export interface Selection {
  chosen: Scored;
  current: Scored;
  keptCurrent: boolean;
  /** Every candidate, best first. */
  ranked: Scored[];
}

/**
 * The selection rule, safety first: maximal coverage (ideally every episode), then the most job
 * starts held back that would have run into an episode, then fewest flaps, then fewest harmless
 * starts held back, ties to the candidate closest to current. The current values are kept when
 * they reach the same coverage and hold back at most one harmful start fewer than the best.
 */
export function select(traces: readonly Trace[], capBytes = CURRENT_CAP_BYTES): Selection {
  const grid = GRID.some((c) => sameCandidate(c, CURRENT)) ? GRID : [...GRID, CURRENT];
  const all = grid.map((c) => score(c, traces, capBytes));
  const ranked = all.toSorted(
    (a, b) =>
      b.covered - a.covered ||
      b.held - a.held ||
      a.flaps - b.flaps ||
      a.blocked - b.blocked ||
      distance(a) - distance(b),
  );
  const best = ranked[0]!;
  const current = all.find((s) => sameCandidate(s, CURRENT))!;
  const keptCurrent = current.covered === best.covered && current.held >= best.held - 1;
  return { chosen: keptCurrent ? current : best, current, keptCurrent, ranked };
}

// ── The absolute cap ──────────────────────────────────────────────────────────────────────────

export const CAP_REFERENCE_WORKERS = 16;
const HALF_GIB = GIB / 2;

/** The cap: 4 GiB while the largest single-job peak at the reference worker count fits under it,
 *  else the next 0.5 GiB step above that peak. */
export function capFor(peakAtReference: number): number {
  if (peakAtReference <= CURRENT_CAP_BYTES) return CURRENT_CAP_BYTES;
  return (Math.floor(peakAtReference / HALF_GIB) + 1) * HALF_GIB;
}

/** Least-squares slope and intercept of peak RSS over worker count; null for under two points. */
export function linearFit(
  points: readonly { x: number; y: number }[],
): { slope: number; intercept: number } | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const slope = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  return { slope, intercept: my - slope * mx };
}

// ── Trace assembly ────────────────────────────────────────────────────────────────────────────

/** The replayable trace of one run: its settle + ramp + cooldown samples, rebased to t = 0. */
export function buildTrace(
  label: string,
  samples: readonly CalSample[],
  events: readonly CalEvent[],
): Trace {
  const meta = events.find((e) => e.kind === "meta");
  const window = samples.filter(
    (s) => s.phase === "settle" || s.phase === "ramp" || s.phase === "cooldown",
  );
  const t0 = window[0]?.t ?? 0;
  const rebased = window.map((s) => ({ ...s, t: s.t - t0 }));
  const starts = events.filter((e) => e.kind === "lane_start" && e.t >= t0).map((e) => e.t - t0);
  const jobs = rampJobs(events).map((j) => ({
    start: j.start - t0,
    end: j.end === null ? null : j.end - t0,
  }));
  const unhealthy = labelUnhealthy(rebased);
  return {
    label,
    cpus: meta?.kind === "meta" ? meta.cpus : 0,
    memTotalBytes: meta?.kind === "meta" ? meta.memTotal : (rebased[0]?.memTotal ?? 0),
    ticks: toTicks(rebased, unhealthy, starts),
    episodes: episodes(rebased, unhealthy),
    starts,
    jobs,
  };
}

/** Ramp jobs from their `cmd_end` events (a stopped lane's killed job included), plus the job each
 *  never-stopped lane was still running when the run ended: it began as the lane's last one ended. */
function rampJobs(events: readonly CalEvent[]): Job[] {
  const jobs: Job[] = [];
  const lastEnd = new Map<number, number>();
  const stopped = new Set<number>();
  for (const e of events) {
    if (e.kind === "lane_start") lastEnd.set(e.lane, e.t);
    if (e.kind === "lane_stop") stopped.add(e.lane);
    if (e.kind === "cmd_end" && e.phase === "ramp" && e.lane !== null) {
      jobs.push({ start: e.startT, end: e.startT + e.durationMs });
      lastEnd.set(e.lane, Math.max(lastEnd.get(e.lane) ?? 0, e.startT + e.durationMs));
    }
  }
  for (const [lane, t] of lastEnd) if (!stopped.has(lane)) jobs.push({ start: t, end: null });
  return jobs.toSorted((a, b) => a.start - b.start);
}
