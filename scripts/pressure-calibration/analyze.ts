#!/usr/bin/env bun
/**
 * Pressure-brake calibration analysis (#3589): turns run.ts output into the evidence in
 * docs/verification/pressure-brake-3589.md and the replay fixtures under
 * test/fixtures/heavy-slot-brake-traces/.
 *
 *   bun scripts/pressure-calibration/analyze.ts --out DIR REP_DIR...
 *
 * Each REP_DIR holds one run's samples.ndjson + events.ndjson (`.gz` accepted). Writes
 * DIR/summary.md, DIR/selection.json and DIR/fixtures/<rep>.json.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import {
  CAP_REFERENCE_WORKERS,
  CURRENT,
  CURRENT_CAP_BYTES,
  budgetFor,
  buildTrace,
  capFor,
  labelUnhealthy,
  linearFit,
  metrics,
  percentile,
  replay,
  select,
  type CalEvent,
  type CalSample,
  type Scored,
  type Trace,
} from "./core";

const GIB = 1024 ** 3;
const gib = (b: number | null | undefined) => (b == null ? "–" : `${(b / GIB).toFixed(2)} GiB`);
const num = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toFixed(d));
const sec = (ms: number) => `${(ms / 1000).toFixed(0)} s`;

function readNdjson<T>(dir: string, name: string): T[] {
  const plain = join(dir, name);
  const text = existsSync(plain)
    ? readFileSync(plain, "utf8")
    : gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

interface Rep {
  label: string;
  samples: CalSample[];
  events: CalEvent[];
  trace: Trace;
}

type CmdEnd = Extract<CalEvent, { kind: "cmd_end" }>;
const cmdEnds = (r: Rep) => r.events.filter((e): e is CmdEnd => e.kind === "cmd_end");

function table(head: string[], rows: (string | number)[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function hostSection(reps: Rep[]): string {
  const rows = reps.map((r) => {
    const meta = r.events.find((e) => e.kind === "meta");
    const swap = r.samples.find((s) => s.swapTotal != null)?.swapTotal;
    const ooms = (r.samples.at(-1)?.oomKill ?? 0) - (r.samples[0]?.oomKill ?? 0);
    return meta?.kind === "meta"
      ? [
          r.label,
          meta.cpus,
          gib(meta.memTotal),
          gib(swap),
          meta.kernel,
          sec(r.samples.at(-1)?.t ?? 0),
          ooms,
        ]
      : [r.label, "–", "–", "–", "–", "–", ooms];
  });
  return `## Hosts\n\n${table(["Rep", "CPUs", "RAM", "Swap", "Kernel", "Run", "OOM kills"], rows)}`;
}

function baselineSection(reps: Rep[]): string {
  const rows = reps.flatMap((r) =>
    cmdEnds(r)
      .filter((e) => e.phase === "baseline")
      .map((e) => [r.label, e.workload, sec(e.durationMs), gib(e.peakRss), e.exitCode ?? "–"]),
  );
  return `## Solo baseline\n\n${table(["Rep", "Workload", "Duration", "Peak tree RSS", "Exit"], rows)}`;
}

interface SweepResult {
  section: string;
  peakAtReference: number;
}

function sweepSection(reps: Rep[]): SweepResult {
  const sweeps = reps.flatMap((r) =>
    cmdEnds(r)
      .filter((e) => e.phase === "sweep")
      .map((e) => ({ rep: r.label, ...e })),
  );
  const rows = sweeps.map((e) => [
    e.rep,
    e.workload,
    e.workers ?? "–",
    sec(e.durationMs),
    gib(e.peakRss),
    e.exitCode ?? "–",
  ]);
  const fits: (string | number)[][] = [];
  for (const workload of [...new Set(sweeps.map((e) => e.workload))]) {
    const points = sweeps
      .filter((e) => e.workload === workload && e.workers != null && e.exitCode === 0)
      .map((e) => ({ x: e.workers!, y: e.peakRss }));
    const fit = linearFit(points);
    const atRef = Math.max(
      0,
      ...points.filter((p) => p.x === CAP_REFERENCE_WORKERS).map((p) => p.y),
    );
    fits.push([
      workload,
      fit ? gib(fit.slope) : "–",
      gib(atRef),
      fit ? gib(fit.intercept + fit.slope * 32) : "–",
    ]);
  }
  const peakAtReference = Math.max(
    0,
    ...sweeps
      .filter((e) => e.workers === CAP_REFERENCE_WORKERS && e.exitCode === 0)
      .map((e) => e.peakRss),
  );
  const cap = capFor(peakAtReference);
  return {
    peakAtReference,
    section: [
      "## Worker sweep",
      table(["Rep", "Workload", "W", "Duration", "Peak tree RSS", "Exit"], rows),
      table(
        [
          "Workload",
          "RSS per worker (fit)",
          `Peak at W=${CAP_REFERENCE_WORKERS}`,
          "W=32 (estimate)",
        ],
        fits,
      ),
      `Largest single-job peak at W=${CAP_REFERENCE_WORKERS}: **${gib(peakAtReference)}** → cap **${gib(cap)}**` +
        ` (current ${gib(CURRENT_CAP_BYTES)}). The W=32 column is an extrapolation and not used.`,
    ].join("\n\n"),
  };
}

function rampSection(reps: Rep[]): string {
  const out: string[] = ["## Ramp by concurrent lanes"];
  for (const r of reps) {
    const ramp = r.samples.filter((s) => s.phase === "ramp");
    const flags = labelUnhealthy(ramp);
    const byLanes = new Map<number, { s: CalSample; bad: boolean }[]>();
    ramp.forEach((s, i) =>
      byLanes.set(s.lanes, [...(byLanes.get(s.lanes) ?? []), { s, bad: flags[i]! }]),
    );
    const rows = [...byLanes.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([lanes, xs]) => {
        const avail = xs.map((x) => x.s.memAvailable).filter((v): v is number => v != null);
        return [
          lanes,
          xs.length,
          gib(Math.min(...avail)),
          gib(percentile(avail, 50)),
          num(Math.max(...xs.map((x) => x.s.memFull10 ?? 0))),
          num(Math.max(...xs.map((x) => x.s.memSome10 ?? 0))),
          num(Math.max(...xs.map((x) => x.s.cpuSome10 ?? 0))),
          num(
            percentile(
              xs.flatMap((x) => x.s.probeMs),
              95,
            ),
          ),
          num(Math.max(0, ...xs.flatMap((x) => x.s.probeMs)), 0),
          xs.filter((x) => x.bad).length,
          gib(Math.max(...xs.map((x) => x.s.loadRss))),
        ];
      });
    out.push(
      `### ${r.label}`,
      table(
        [
          "Lanes",
          "Seconds",
          "Min avail",
          "Median avail",
          "Max PSI full10",
          "Max PSI some10",
          "Max CPU some10",
          "Probe p95 ms",
          "Probe max ms",
          "Unhealthy s",
          "Max load RSS",
        ],
        rows,
      ),
    );
    const baseline = new Map(
      cmdEnds(r)
        .filter((e) => e.phase === "baseline")
        .map((e) => [e.workload, e.durationMs]),
    );
    const slow = [
      ...new Set(
        cmdEnds(r)
          .filter((e) => e.phase === "ramp")
          .map((e) => e.workload),
      ),
    ].map((w) => {
      const durs = cmdEnds(r)
        .filter((e) => e.phase === "ramp" && e.workload === w && e.exitCode === 0)
        .map((e) => e.durationMs);
      const med = percentile(durs, 50);
      const base = baseline.get(w);
      return [
        w,
        durs.length,
        med == null ? "–" : sec(med),
        base ? sec(base) : "–",
        med && base ? `${(med / base).toFixed(1)}×` : "–",
      ];
    });
    out.push(table(["Workload", "Completed in ramp", "Median duration", "Solo", "Slowdown"], slow));
    const skips = r.events.filter((e) => e.kind === "lane_skip");
    if (skips.length)
      out.push(
        `Governor skipped lanes: ${skips.map((e) => (e.kind === "lane_skip" ? `${e.lane} (${e.reason})` : "")).join(", ")}`,
      );
  }
  return out.join("\n\n");
}

function episodeSection(reps: Rep[]): string {
  const rows = reps.flatMap((r) =>
    r.trace.episodes.map((e) => {
      const k = r.trace.ticks.findIndex((x) => x.t >= e.start);
      const tick = r.trace.ticks[k];
      const lanes = r.trace.starts.filter((s) => s <= e.start).length;
      return [
        r.label,
        sec(e.start),
        sec(e.end - e.start),
        lanes,
        gib(tick?.availableBytes),
        num(tick?.psiFullAvg10),
      ];
    }),
  );
  return `## Unhealthy episodes\n\nTimes relative to the settle phase start.\n\n${
    rows.length
      ? table(
          ["Rep", "Onset", "Length", "Lanes started", "Avail at onset", "PSI full10 at onset"],
          rows,
        )
      : "None."
  }`;
}

const fmt = (s: Scored) => [
  `${(s.fraction * 100).toFixed(1)} %`,
  s.psiFullMax,
  sec(s.releaseHoldMs),
  `${s.covered}/${s.episodes}`,
  s.blocked,
  s.flaps,
];

function selectionSection(sel: ReturnType<typeof select>, cap: number): string {
  const head = [
    "Floor (% RAM)",
    "PSI full max",
    "Hold",
    "Covered",
    "Harmless starts blocked",
    "Flaps",
  ];
  return [
    "## Selection",
    `Current: ${fmt(sel.current).join(" · ")}`,
    `Chosen: **${fmt(sel.chosen).join(" · ")}**, cap ${gib(cap)} — ${sel.keptCurrent ? "current values kept" : "adjusted"}.`,
    table(head, sel.ranked.slice(0, 15).map(fmt)),
  ].join("\n\n");
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  if (!values.out || positionals.length === 0)
    throw new Error("usage: analyze.ts --out DIR REP_DIR...");
  const out = resolve(values.out);
  mkdirSync(join(out, "fixtures"), { recursive: true });
  const reps: Rep[] = positionals.map((dir) => {
    const label = basename(resolve(dir));
    const samples = readNdjson<CalSample>(dir, "samples.ndjson");
    const events = readNdjson<CalEvent>(dir, "events.ndjson");
    return { label, samples, events, trace: buildTrace(label, samples, events) };
  });
  const sweep = sweepSection(reps);
  const cap = capFor(sweep.peakAtReference);
  const traces = reps.map((r) => r.trace);
  const sel = select(traces, cap);
  for (const tr of traces) {
    const m = metrics(tr, replay(tr.ticks, budgetFor(sel.chosen, tr.memTotalBytes, cap)));
    writeFileSync(
      join(out, "fixtures", `${tr.label}.json`),
      `${JSON.stringify({ ...tr, expected: m })}\n`,
    );
  }
  writeFileSync(
    join(out, "selection.json"),
    `${JSON.stringify({ chosen: sel.chosen, current: sel.current, keptCurrent: sel.keptCurrent, capBytes: cap, peakAtReference: sweep.peakAtReference, baseline: CURRENT }, null, 2)}\n`,
  );
  const summary = [
    "# Pressure-brake calibration summary",
    hostSection(reps),
    baselineSection(reps),
    sweep.section,
    rampSection(reps),
    episodeSection(reps),
    selectionSection(sel, cap),
  ].join("\n\n");
  writeFileSync(join(out, "summary.md"), `${summary}\n`);
  console.log(summary);
}

main();
