#!/usr/bin/env bun
/**
 * Pressure-brake calibration run (#3589). Measures representative heavy-check load on an ISOLATED
 * Linux host — never on the shared operator machine: it drives memory into pressure on purpose.
 * Runs in .github/workflows/pressure-calibration.yml; see docs/verification/pressure-brake-3589.md.
 *
 *   bun scripts/pressure-calibration/run.ts --out DIR --work DIR [--max-lanes 12] [--step 60]
 *     [--hold 180] [--settle 60] [--cooldown 60] [--sweep 1,2,4,8,16] [--protect] [--probe-only]
 *
 * Phases: prepare (one git worktree + bun install per lane) → baseline (each workload once, solo)
 * → sweep (cargo -j W and browser --maxWorkers=W, solo) → settle (idle) → ramp (one looping lane
 * every --step s up to --max-lanes, hold, then one lane stopped every --step s) → cooldown (idle).
 * A 1 Hz sampler writes samples.ndjson; events.ndjson records phases, lanes and every command.
 * `--probe-only` replaces the workloads with short sleeps: a harmless pipeline check.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { availableParallelism, release } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  PROBE_TIMEOUT_MS,
  meminfoBytes,
  psiValue,
  statIds,
  statusRss,
  treePids,
  vmstatOomKill,
  type CalEvent,
  type CalSample,
  type Phase,
} from "./core";

const SELF = import.meta.path;
const REPO = resolve(import.meta.dir, "../..");
const PROBE_INTERVAL_MS = 100;
const STOP_GRACE_MS = 10_000;
/** Lanes are the first thing the kernel kills; the harness itself is protected (with --protect). */
const LANE_OOM_SCORE_ADJ = 500;
const PROTECT_OOM_SCORE_ADJ = -900;
/** The ramp adds no lane past these (the run would otherwise risk losing the runner). */
const GOVERNOR_MIN_AVAILABLE_FRACTION = 0.05;
const GOVERNOR_MAX_PSI_FULL = 50;
const SWEEP_BROWSER_DIRS = ["src/lib/components/settings/", "src/lib/components/heavy-slot/"];
const LANE_BROWSER_FILES = [
  "src/lib/components/heavy-slot/heavy-slot.browser.test.ts",
  "src/lib/components/settings/SettingsResourcesPanel.browser.test.ts",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Probe processes ───────────────────────────────────────────────────────────────────────────

/** The stand-in for Shepherd's single event loop: a tiny HTTP server in its own process. */
function probeServer(): void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: true, t: Date.now() }),
  });
  console.log(server.port);
}

/** Hits the server every 100 ms and prints each second's round trips as one JSON line. */
function probeClient(port: number): void {
  let batch: number[] = [];
  const url = `http://127.0.0.1:${port}/`;
  setInterval(() => {
    const t0 = performance.now();
    fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      .then((r) => r.arrayBuffer())
      .then(() => batch.push(performance.now() - t0))
      .catch(() => batch.push(PROBE_TIMEOUT_MS));
  }, PROBE_INTERVAL_MS);
  setInterval(() => {
    console.log(JSON.stringify(batch.map((ms) => Math.round(ms * 10) / 10)));
    batch = [];
  }, 1000);
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────

interface Config {
  out: string;
  work: string;
  maxLanes: number;
  stepMs: number;
  holdMs: number;
  settleMs: number;
  cooldownMs: number;
  sweep: number[];
  protect: boolean;
  probeOnly: boolean;
}

interface Workload {
  name: string;
  cwd: string;
  cmd: (workers: number | null) => string[];
}

const WORKLOADS: Workload[] = [
  {
    name: "cargo",
    cwd: ".",
    cmd: (w) => [
      "cargo",
      "check",
      "--locked",
      "--manifest-path",
      "cli/Cargo.toml",
      ...(w ? ["-j", String(w)] : []),
    ],
  },
  { name: "typecheck", cwd: ".", cmd: () => ["bun", "run", "typecheck"] },
  { name: "svelte-check", cwd: "ui", cmd: () => ["bun", "run", "check"] },
  { name: "vite-build", cwd: "ui", cmd: () => ["bun", "run", "build"] },
  {
    name: "browser",
    cwd: "ui",
    cmd: (w) =>
      w
        ? [
            "bunx",
            "vitest",
            "run",
            "--project",
            "browser",
            `--maxWorkers=${w}`,
            ...SWEEP_BROWSER_DIRS,
          ]
        : ["bunx", "vitest", "run", "--project", "browser", ...LANE_BROWSER_FILES],
  },
];

const PROBE_ONLY_WORKLOADS: Workload[] = [
  { name: "sleep", cwd: ".", cmd: () => ["sh", "-c", "sleep 3"] },
];

interface Running {
  pid: number;
  child: ChildProcess;
  peakRss: number;
  peakProcs: number;
}

class Harness {
  readonly cfg: Config;
  phase: Phase = "prepare";
  readonly t0 = Date.now();
  readonly running = new Set<Running>();
  readonly laneStop = new Map<number, () => void>();
  probeBuffer: number[] = [];
  lastSample: CalSample | null = null;
  lanesActive = 0;
  #sampling = false;
  readonly #children: ChildProcess[] = [];

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  now(): number {
    return Date.now() - this.t0;
  }

  event(e: CalEvent): void {
    appendFileSync(join(this.cfg.out, "events.ndjson"), `${JSON.stringify(e)}\n`);
  }

  setPhase(phase: Phase): void {
    this.phase = phase;
    this.event({ t: this.now(), kind: "phase", phase });
    console.log(`[calibrate] ${(this.now() / 1000).toFixed(0)}s phase ${phase}`);
  }

  async startProbe(): Promise<void> {
    const server = spawn(process.execPath, [SELF, "--probe-server"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.#children.push(server);
    const port = await new Promise<number>((res, rej) => {
      server.stdout!.once("data", (d: Buffer) => res(Number(String(d).trim())));
      server.once("exit", () => rej(new Error("probe server exited")));
    });
    const client = spawn(process.execPath, [SELF, "--probe-client", String(port)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.#children.push(client);
    let partial = "";
    client.stdout!.on("data", (d: Buffer) => {
      const lines = (partial + String(d)).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line) this.probeBuffer.push(...(JSON.parse(line) as number[]));
    });
    if (this.cfg.protect)
      for (const pid of [process.pid, server.pid!, client.pid!]) await protect(String(pid));
  }

  async sample(): Promise<void> {
    if (this.#sampling) return; // a scan stalled under pressure: skip this second, don't pile up
    this.#sampling = true;
    try {
      const read = (p: string) => readFile(p, "utf8").catch(() => "");
      const [meminfo, mem, cpu, io, vmstat] = await Promise.all(
        [
          "/proc/meminfo",
          "/proc/pressure/memory",
          "/proc/pressure/cpu",
          "/proc/pressure/io",
          "/proc/vmstat",
        ].map(read),
      );
      const loadRss = await this.#scanRss();
      const s: CalSample = {
        t: this.now(),
        phase: this.phase,
        memTotal: meminfoBytes(meminfo!, "MemTotal"),
        memAvailable: meminfoBytes(meminfo!, "MemAvailable"),
        swapTotal: meminfoBytes(meminfo!, "SwapTotal"),
        swapFree: meminfoBytes(meminfo!, "SwapFree"),
        memSome10: psiValue(mem!, "some", "avg10"),
        memFull10: psiValue(mem!, "full", "avg10"),
        memSome60: psiValue(mem!, "some", "avg60"),
        memFull60: psiValue(mem!, "full", "avg60"),
        cpuSome10: psiValue(cpu!, "some", "avg10"),
        ioFull10: psiValue(io!, "full", "avg10"),
        oomKill: vmstatOomKill(vmstat!),
        lanes: this.lanesActive,
        loadRss,
        probeMs: this.probeBuffer.splice(0),
      };
      this.lastSample = s;
      appendFileSync(join(this.cfg.out, "samples.ndjson"), `${JSON.stringify(s)}\n`);
    } finally {
      this.#sampling = false;
    }
  }

  /** Summed RSS of every running command's tree; updates each command's peak. */
  async #scanRss(): Promise<number> {
    if (this.running.size === 0) return 0;
    const pids = (await readdir("/proc").catch(() => [] as string[])).filter((n) =>
      /^\d+$/.test(n),
    );
    const procs = new Map<number, { ppid: number; pgrp: number }>();
    await Promise.all(
      pids.map(async (pid) => {
        const ids = statIds(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""));
        if (ids) procs.set(Number(pid), ids);
      }),
    );
    let total = 0;
    for (const r of this.running) {
      const tree = [...treePids(procs, [r.pid])];
      const rss = await Promise.all(
        tree.map(async (p) =>
          statusRss(await readFile(`/proc/${p}/status`, "utf8").catch(() => "")),
        ),
      );
      const sum = rss.reduce((a, b) => a + b, 0);
      r.peakRss = Math.max(r.peakRss, sum);
      r.peakProcs = Math.max(r.peakProcs, tree.length);
      total += sum;
    }
    return total;
  }

  /** Runs one command in its own process group, lane-scored for the OOM killer; resolves on exit. */
  async run(
    w: Workload,
    laneDir: string,
    lane: number | null,
    workers: number | null,
    extraEnv: Record<string, string> = {},
  ): Promise<number | null> {
    const startT = this.now();
    const log = openSync(
      join(
        this.cfg.out,
        "logs",
        `${lane ?? this.phase}-${w.name}${workers ? `-w${workers}` : ""}.log`,
      ),
      "a",
    );
    const child = spawn(
      "sh",
      [
        "-c",
        `echo ${LANE_OOM_SCORE_ADJ} > /proc/self/oom_score_adj; exec "$@"`,
        "sh",
        ...w.cmd(workers),
      ],
      {
        cwd: join(laneDir, w.cwd),
        env: { ...process.env, ...extraEnv },
        detached: true,
        stdio: ["ignore", log, log],
      },
    );
    const r: Running = { pid: child.pid!, child, peakRss: 0, peakProcs: 0 };
    this.running.add(r);
    const exitCode = await new Promise<number | null>((res) => {
      child.once("exit", (code) => res(code));
      child.once("error", () => res(null));
    });
    this.running.delete(r);
    closeSync(log);
    this.event({
      t: this.now(),
      kind: "cmd_end",
      phase: this.phase,
      lane,
      workload: w.name,
      workers,
      startT,
      durationMs: this.now() - startT,
      exitCode,
      peakRss: r.peakRss,
    });
    console.log(
      `[calibrate] ${w.name}${workers ? ` W=${workers}` : ""} lane=${lane ?? "-"} exit=${exitCode} ` +
        `${((this.now() - startT) / 1000).toFixed(0)}s peak=${(r.peakRss / 1024 ** 3).toFixed(2)}GiB procs=${r.peakProcs}`,
    );
    return exitCode;
  }

  kill(r: Running): void {
    try {
      process.kill(-r.pid, "SIGTERM");
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        process.kill(-r.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, STOP_GRACE_MS).unref();
  }

  shutdown(): void {
    for (const r of this.running) this.kill(r);
    for (const c of this.#children) c.kill("SIGKILL");
  }
}

async function protect(pid: string): Promise<void> {
  const p = spawn("sudo", ["-n", "choom", "-n", String(PROTECT_OOM_SCORE_ADJ), "-p", pid], {
    stdio: "inherit",
  });
  await new Promise((r) => p.once("exit", r));
}

/** The GitHub runner agent must survive the storm, or the run's data is lost with it. */
async function protectRunnerAgent(): Promise<void> {
  const out = await new Promise<string>((res) => {
    const p = spawn("pgrep", ["-f", "Runner\\.(Listener|Worker)"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let s = "";
    p.stdout!.on("data", (d: Buffer) => (s += String(d)));
    p.once("exit", () => res(s));
  });
  for (const pid of out.split("\n").filter(Boolean)) await protect(pid);
}

async function sh(cmd: string[], cwd: string): Promise<void> {
  const p = spawn(cmd[0]!, cmd.slice(1), { cwd, stdio: "inherit" });
  const code = await new Promise<number | null>((r) => p.once("exit", r));
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}) in ${cwd}`);
}

const laneDir = (cfg: Config, lane: number) =>
  cfg.probeOnly ? REPO : join(cfg.work, `lane-${lane}`);

async function prepareLanes(cfg: Config): Promise<void> {
  if (cfg.probeOnly) return;
  for (let lane = 1; lane <= cfg.maxLanes; lane++) {
    const dir = laneDir(cfg, lane);
    await sh(["git", "worktree", "add", "--detach", dir, "HEAD"], REPO);
    await sh(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], dir);
    await sh(["bun", "install", "--frozen-lockfile"], join(dir, "ui"));
  }
}

async function baseline(h: Harness, workloads: Workload[]): Promise<void> {
  h.setPhase("baseline");
  const dir = laneDir(h.cfg, 1);
  const failed: string[] = [];
  for (const w of workloads) {
    const code = await h.run(w, dir, null, null, {
      CARGO_TARGET_DIR: join(h.cfg.work, "target-baseline"),
    });
    if (code !== 0) failed.push(w.name);
  }
  if (failed.length) throw new Error(`baseline workloads failed: ${failed.join(", ")} (see logs/)`);
}

async function sweep(h: Harness, workloads: Workload[]): Promise<void> {
  h.setPhase("sweep");
  const dir = laneDir(h.cfg, 1);
  for (const name of ["cargo", "browser"]) {
    const w = workloads.find((x) => x.name === name);
    if (!w) continue;
    for (const workers of h.cfg.sweep) {
      // Unset CI: ui/vite.config.ts caps the browser pool to 2 under CI, which would hide W.
      await h.run(w, dir, null, workers, {
        CI: "",
        CARGO_TARGET_DIR: join(h.cfg.work, `target-sweep-${workers}`),
      });
    }
  }
}

/** One lane loops the workload mix, starting at its own offset, until stopped. */
function startLane(h: Harness, lane: number, workloads: Workload[]): Promise<void> {
  let stopped = false;
  let current: Running | null = null;
  h.laneStop.set(lane, () => {
    stopped = true;
    if (current) h.kill(current);
  });
  h.lanesActive++;
  h.event({ t: h.now(), kind: "lane_start", lane });
  const dir = laneDir(h.cfg, lane);
  return (async () => {
    for (let i = lane - 1; !stopped; i++) {
      const w = workloads[i % workloads.length]!;
      if (w.name === "cargo" && i >= workloads.length && !h.cfg.probeOnly)
        await sh(["touch", "cli/src/main.rs"], dir); // later rounds re-check the crate, like an edit
      const before = new Set(h.running);
      const done = h.run(w, dir, lane, null, { CARGO_TARGET_DIR: join(dir, ".cargo-target") });
      current = [...h.running].find((r) => !before.has(r)) ?? null;
      await done;
      current = null;
    }
  })();
}

async function ramp(h: Harness, workloads: Workload[]): Promise<void> {
  h.setPhase("settle");
  await sleep(h.cfg.settleMs);
  h.setPhase("ramp");
  const loops: Promise<void>[] = [];
  const started: number[] = [];
  for (let lane = 1; lane <= h.cfg.maxLanes; lane++) {
    const s = h.lastSample;
    const lowMem =
      s?.memAvailable != null &&
      s.memTotal != null &&
      s.memAvailable < s.memTotal * GOVERNOR_MIN_AVAILABLE_FRACTION;
    const stalled = (s?.memFull10 ?? 0) > GOVERNOR_MAX_PSI_FULL;
    if (lowMem || stalled) {
      h.event({
        t: h.now(),
        kind: "lane_skip",
        lane,
        reason: lowMem ? "ceiling_memory" : "ceiling_psi",
      });
      console.log(`[calibrate] ceiling reached: lane ${lane} not started`);
    } else {
      loops.push(startLane(h, lane, workloads));
      started.push(lane);
    }
    await sleep(h.cfg.stepMs);
  }
  await sleep(h.cfg.holdMs);
  for (const lane of started.toReversed()) {
    h.laneStop.get(lane)!();
    h.lanesActive--;
    h.event({ t: h.now(), kind: "lane_stop", lane });
    await sleep(h.cfg.stepMs);
  }
  await Promise.all(loops);
  h.setPhase("cooldown");
  await sleep(h.cfg.cooldownMs);
}

function parseConfig(): Config {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      work: { type: "string" },
      "max-lanes": { type: "string", default: "12" },
      step: { type: "string", default: "60" },
      hold: { type: "string", default: "180" },
      settle: { type: "string", default: "60" },
      cooldown: { type: "string", default: "60" },
      sweep: { type: "string", default: "1,2,4,8,16" },
      protect: { type: "boolean", default: false },
      "probe-only": { type: "boolean", default: false },
    },
  });
  if (!values.out || !values.work) throw new Error("--out and --work are required");
  const num = (v: string, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
    return n;
  };
  return {
    out: resolve(values.out),
    work: resolve(values.work),
    maxLanes: num(values["max-lanes"], "max-lanes"),
    stepMs: num(values.step, "step") * 1000,
    holdMs: num(values.hold, "hold") * 1000,
    settleMs: num(values.settle, "settle") * 1000,
    cooldownMs: num(values.cooldown, "cooldown") * 1000,
    sweep: values.sweep
      .split(",")
      .filter(Boolean)
      .map((v) => num(v, "sweep")),
    protect: values.protect,
    probeOnly: values["probe-only"],
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig();
  if (process.platform !== "linux") throw new Error("calibration needs Linux (/proc, PSI)");
  const psi = await readFile("/proc/pressure/memory", "utf8").catch(() => "");
  if (!psi.includes("full ")) throw new Error("/proc/pressure/memory missing: kernel without PSI");
  mkdirSync(join(cfg.out, "logs"), { recursive: true });
  mkdirSync(cfg.work, { recursive: true });
  writeFileSync(join(cfg.out, "samples.ndjson"), "");
  writeFileSync(join(cfg.out, "events.ndjson"), "");
  const workloads = cfg.probeOnly ? PROBE_ONLY_WORKLOADS : WORKLOADS;
  const h = new Harness(cfg);
  const meminfo = await readFile("/proc/meminfo", "utf8");
  h.event({
    t: 0,
    kind: "meta",
    cpus: availableParallelism(),
    memTotal: meminfoBytes(meminfo, "MemTotal") ?? 0,
    kernel: release(),
    config: { ...cfg, out: undefined, work: undefined },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, () => {
      h.shutdown();
      process.exit(130);
    });
  await h.startProbe();
  if (cfg.protect) await protectRunnerAgent();
  const sampler = setInterval(() => void h.sample(), 1000);
  try {
    h.setPhase("prepare");
    await prepareLanes(cfg);
    if (!cfg.probeOnly) {
      await baseline(h, workloads);
      await sweep(h, workloads);
    }
    await ramp(h, workloads);
  } finally {
    clearInterval(sampler);
    h.shutdown();
  }
  console.log(`[calibrate] done in ${(h.now() / 1000).toFixed(0)}s → ${cfg.out}`);
}

const argv = process.argv.slice(2);
if (argv[0] === "--probe-server") probeServer();
else if (argv[0] === "--probe-client") probeClient(Number(argv[1]));
else
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`[calibrate] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
