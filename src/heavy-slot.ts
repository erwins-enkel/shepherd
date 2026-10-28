// Host-wide heavy-check slot (#3181) — the service around the pure core in heavy-slot-core.ts.
//
// The tool guard rewrites an agent's heavy Bash command onto scripts/heavy-slot.mjs, which asks
// here (agent ingress `POST /api/sessions/<id>/heavy-slot`) BEFORE the process starts. This
// service owns everything with I/O: the persisted jobs, the memory sampler behind the pressure
// brake, the /proc scan that binds a slot to the job's process tree, the steer that hands a freed
// slot to the queue head, and the `heavyslot:status` snapshot the cards render.
//
// Binding to the process tree: the runner stamps SHEPHERD_HEAVY_JOB=<id> on the command it starts,
// every descendant inherits it, and a slot is held while ANY process carrying it lives — so a
// parent that exits early, a runner killed mid-run or a Shepherd restart never frees a slot whose
// browsers and workers still run. The marker survives `setsid` (Chromium) and the sandbox's PID
// namespace (the host's /proc sees membrane processes). macOS has no environ probe here, so there
// the runner reports the process group it started and the group's liveness stands in.

import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { captureRevision } from "./heavy-slot-revision";
import type { HeavySlotSnapshot } from "./heavy-slot-snapshot";
import type { EventHub } from "./events";
import { parseMemAvailable, parsePsiAvg10 } from "./host-parse";
import { mapBounded } from "./map-bounded";
import type { SessionStore } from "./store";
import {
  BRAKE_OFF,
  ETA_HISTORY,
  HeavyLedger,
  buildSnapshot,
  defaultHeavySlotBudget,
  estimateWaits,
  heavyEtaKey,
  nextBrake,
  offerSteer,
  queuedMessage,
  type BrakeState,
  type HeavyJob,
  type HeavySlotBudget,
  OFFER_TTL_MS,
  type HeavyWaitReason,
  type LedgerContext,
  type MemorySample,
} from "./heavy-slot-core";

/** The env var the runner stamps on the command it starts (scripts/heavy-slot.mjs). */
const HEAVY_JOB_ENV = "SHEPHERD_HEAVY_JOB";
/** Sweep cadence: memory sampling while anything waits, the process scan at most every
 *  {@link SCAN_EVERY_MS} while anything holds a slot. Idle → no timer at all. */
const TICK_MS = 5_000;
const SCAN_EVERY_MS = 10_000;
/** A memory sample older than this is retaken before an acquire is decided. */
const SAMPLE_FRESH_MS = 5_000;
/** Finished rows older than this are pruned at boot; they only feed wait estimates. */
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60_000;
/** /proc reads in flight at once during a scan. */
const SCAN_CONCURRENCY = 8;

export interface ProcStat {
  count: number;
  rssBytes: number;
}

/** What the agent ingress route answers the runner. */
export type AcquireResponse =
  | { decision: "run"; jobId: string }
  | { decision: "run"; unmanaged: true }
  | {
      decision: "queued";
      jobId: string;
      position: number;
      total: number;
      etaMs: number | null;
      reason: HeavyWaitReason;
      message: string;
    };

export interface HeavySlotDeps {
  store: Pick<
    SessionStore,
    "get" | "listHeavySlotJobs" | "upsertHeavySlotJob" | "heavySlotDurations" | "pruneHeavySlotJobs"
  >;
  events: Pick<EventHub, "emit">;
  /** Steer a LIVE pane only (SessionService.reply, automatic). false = it did not land. */
  steer: (sessionId: string, text: string) => Promise<boolean>;
  enabled: boolean;
  budget: HeavySlotBudget;
  now?: () => number;
  newId?: () => string;
  /** Linux: live marker processes per job id; null when the host cannot be scanned. */
  scanMarkers?: (jobIds: ReadonlySet<string>) => Promise<Map<string, ProcStat> | null>;
  /** macOS: does any process of this group still run? */
  groupAlive?: (pgid: number) => boolean;
  sampleMemory?: () => Promise<MemorySample>;
  platform?: NodeJS.Platform;
}

export class HeavySlotService {
  readonly #deps: HeavySlotDeps;
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;
  #ledger = new HeavyLedger();
  #brake: BrakeState = BRAKE_OFF;
  #procs = new Map<string, ProcStat>();
  #history = new Map<string, number[]>();
  #lastScanAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  #filling = false;
  #refill = false;
  #lastEmitted = "";

  constructor(deps: HeavySlotDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#platform = deps.platform ?? process.platform;
  }

  get enabled(): boolean {
    return this.#deps.enabled;
  }

  /** Load persisted jobs, settle what a restart left behind, and start the sweep if needed. */
  async start(): Promise<void> {
    const { store } = this.#deps;
    const now = this.#now();
    store.pruneHeavySlotJobs(now - PRUNE_AFTER_MS);
    this.#ledger = new HeavyLedger(
      store.listHeavySlotJobs(["queued", "offered", "running", "lingering"]),
    );
    this.#history = store.heavySlotDurations(ETA_HISTORY);
    if (!this.#deps.enabled) {
      this.#ledger.dropAll("disabled", now);
      this.#persist();
      return;
    }
    await this.sweep(true);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** True while the session waits for the slot — autopilot stands down meanwhile. */
  waiting(sessionId: string): boolean {
    return this.#deps.enabled && this.#ledger.waiting(sessionId);
  }

  #ledgerView() {
    const waits = estimateWaits(
      this.#ledger.active(),
      this.#ledger.queue(),
      this.#history,
      this.#deps.budget.slots,
      this.#brake.engaged,
      this.#now(),
    );
    return buildSnapshot(this.#ledger, {
      enabled: this.#deps.enabled,
      budget: this.#deps.budget,
      brake: this.#brake,
      waits,
      procs: this.#procs,
    });
  }

  snapshot(): HeavySlotSnapshot {
    const view = this.#ledgerView();
    return {
      enabled: view.enabled,
      capacity: view.slots,
      holders: view.jobs
        .filter((j) => j.state !== "queued")
        .map((j) => ({
          sessionId: j.sessionId,
          command: j.command,
          startedAt:
            j.startedAt ??
            (j.offerExpiresAt === null ? j.enqueuedAt : j.offerExpiresAt - OFFER_TTL_MS),
          rssBytes: j.rssBytes,
        })),
      waiters: view.jobs
        .filter((j) => j.state === "queued")
        .map((j) => ({
          sessionId: j.sessionId,
          position: j.position!,
          reason: j.waitReason!,
        })),
      brake: { active: view.brake.engaged, reason: view.brake.engaged ? "memory" : null },
      pressure: {
        ramAvailableBytes: view.brake.availableBytes,
        ramTotalBytes: totalmem(),
        swapUsedBytes: null,
        swapTotalBytes: null,
        memFullAvg10: view.brake.psiFullAvg10,
        memBrakeThreshold: view.brake.psiFullMax,
        cpuSomeAvg10: null,
      },
      memoryBySource: { agentsBytes: null, foreignBytes: null, foreignTop: [] },
      lastResults: [],
    };
  }

  /** A heavy check asks for the slot (runner → agent ingress). Null: unknown session. */
  async acquire(
    sessionId: string,
    command: string,
    cwd: string | null,
  ): Promise<AcquireResponse | null> {
    const session = this.#deps.store.get(sessionId);
    if (!session || session.status === "archived") return null;
    if (!this.#deps.enabled) return { decision: "run", unmanaged: true };
    if (this.#now() - (this.#brake.sampledAt ?? 0) > SAMPLE_FRESH_MS) await this.#sample();
    const out = this.#ledger.acquire(
      {
        id: (this.#deps.newId ?? randomUUID)(),
        sessionId,
        command,
        cwd,
        etaKey: heavyEtaKey(session.repoPath, session.worktreePath, cwd, command),
      },
      this.#ctx(),
    );
    if (out.kind === "run") {
      // Bind the run to the source it starts on (#3554), before the runner is told to go.
      const rev = await captureRevision(session.worktreePath, session.repoPath);
      this.#ledger.setRevision(out.job.id, rev.head, rev.treeHash);
    }
    await this.#changed();
    if (out.kind === "unmanaged") return { decision: "run", unmanaged: true };
    if (out.kind === "run") return { decision: "run", jobId: out.job.id };
    const etaMs = this.#ledgerView().jobs.find((j) => j.id === out.job.id)?.etaMs ?? null;
    return {
      decision: "queued",
      jobId: out.job.id,
      position: out.position,
      total: out.total,
      etaMs,
      reason: out.reason,
      message: queuedMessage(out.job.command, { ...out, etaMs }),
    };
  }

  /** macOS: the runner reports the process group of the command it just started. */
  async started(sessionId: string, jobId: string, pgid: number): Promise<boolean> {
    const ok = this.#ledger.started(jobId, sessionId, pgid);
    if (ok) await this.#changed();
    return ok;
  }

  /** The runner reports its command's exit; leftover marker processes keep the slot bound. */
  async finish(sessionId: string, jobId: string, exitCode: number | null): Promise<boolean> {
    const job = this.#ledger.get(jobId);
    if (!job || job.sessionId !== sessionId) return false;
    const alive = (await this.#aliveMap([job]))(job);
    const ok = this.#ledger.finish(jobId, sessionId, exitCode, alive !== false, this.#now());
    if (ok) await this.#changed();
    return ok;
  }

  /** Operator: free a running/lingering slot by hand. Kills nothing. */
  async release(sessionId: string): Promise<boolean> {
    const holders = this.#ledger.active().filter((j) => j.sessionId === sessionId);
    if (holders.length === 0) return false;
    for (const job of holders) this.#ledger.release(job.id, this.#now());
    await this.#changed();
    return true;
  }

  #ctx(): LedgerContext {
    return { now: this.#now(), budget: this.#deps.budget, brakeEngaged: this.#brake.engaged };
  }

  async #sample(): Promise<void> {
    const sample = await (this.#deps.sampleMemory ?? defaultSampleMemory)();
    this.#brake = nextBrake(this.#brake, sample, this.#deps.budget, this.#now());
  }

  /** Liveness per job: the marker scan on Linux, the process group on macOS, null = unknown. */
  async #aliveMap(jobs: readonly HeavyJob[]): Promise<(job: HeavyJob) => boolean | null> {
    if (this.#platform === "darwin") {
      const groupAlive = this.#deps.groupAlive ?? defaultGroupAlive;
      return (job) => (job.pgid === null ? false : groupAlive(job.pgid));
    }
    const scan = this.#deps.scanMarkers ?? (this.#platform === "linux" ? scanMarkersLinux : null);
    const found = scan && jobs.length > 0 ? await scan(new Set(jobs.map((j) => j.id))) : null;
    if (!found) return () => null;
    for (const job of jobs) {
      const stat = found.get(job.id);
      if (stat) this.#procs.set(job.id, stat);
      else this.#procs.delete(job.id);
    }
    return (job) => found.has(job.id);
  }

  /** One sweep: sample memory while anyone waits, scan holders, settle, refill, announce. The
   *  interval's body; public so tests can drive it against an injected clock. */
  async sweep(force = false): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      if (force || this.#ledger.queue().length > 0 || this.#brake.engaged) await this.#sample();
      const holders = this.#ledger.active().filter((j) => j.state !== "offered");
      let alive: (job: HeavyJob) => boolean | null = () => null;
      if (holders.length > 0 && (force || now - this.#lastScanAt >= SCAN_EVERY_MS)) {
        this.#lastScanAt = now;
        alive = await this.#aliveMap(holders);
      }
      this.#ledger.reconcile(this.#now(), alive, (id) => {
        const s = this.#deps.store.get(id);
        return !!s && s.status !== "archived";
      });
      await this.#changed();
    } finally {
      this.#ticking = false;
    }
  }

  /** Persist and announce what changed, hand freed slots to the queue head, keep the timer right. */
  async #changed(): Promise<void> {
    this.#persist();
    await this.#fill();
    this.#emit();
    this.#schedule();
  }

  #persist(): void {
    let finished = false;
    for (const job of this.#ledger.takeDirty()) {
      this.#deps.store.upsertHeavySlotJob(job);
      if (job.state === "done" || job.state === "dropped") {
        this.#procs.delete(job.id);
        finished ||= job.state === "done";
      }
    }
    if (finished) this.#history = this.#deps.store.heavySlotDurations(ETA_HISTORY);
  }

  /**
   * Offer free slots to the queue head and steer each offered session. A steer that does not land
   * (no live pane) drops that job and offers the slot to the next one. Re-entrant calls while a
   * steer is in flight only flag another round, so one slot is never offered twice.
   */
  async #fill(): Promise<void> {
    if (!this.#deps.enabled) return;
    if (this.#filling) {
      this.#refill = true;
      return;
    }
    this.#filling = true;
    try {
      do {
        this.#refill = false;
        const offered = this.#ledger.fill(this.#ctx());
        this.#persist();
        for (const job of offered) {
          const landed = await this.#deps.steer(job.sessionId, offerSteer(job)).catch(() => false);
          if (!landed && this.#ledger.get(job.id)?.state === "offered") {
            this.#ledger.drop(job.id, "steer_missed", this.#now());
            this.#refill = true;
          }
        }
        this.#persist();
      } while (this.#refill);
    } finally {
      this.#filling = false;
    }
  }

  #emit(): void {
    const snap = this.snapshot();
    // Unchanged pictures stay off the wire. RSS is compared at 0.1 GiB and estimates at whole
    // minutes, so scan jitter and the clock alone don't re-announce the same picture every tick.
    const key = JSON.stringify(snap, (k, v) => {
      if (typeof v !== "number") return v;
      if (k === "rssBytes") return Math.round(v / 1024 ** 3 / 0.1);
      if (k === "etaMs") return Math.round(v / 60_000);
      return v;
    });
    if (key === this.#lastEmitted) return;
    this.#lastEmitted = key;
    this.#deps.events.emit("heavyslot:status", snap);
  }

  /** Run the sweep only while something is in flight; an idle host carries no timer. */
  #schedule(): void {
    const busy = this.#ledger.all().length > 0 || this.#brake.engaged;
    if (busy && !this.#timer) {
      this.#timer = setInterval(() => void this.sweep(), TICK_MS);
      this.#timer.unref?.();
    } else if (!busy && this.#timer) {
      this.stop();
    }
  }
}

/** The budget for this host: hardware defaults, `SHEPHERD_HEAVY_SLOTS` (0 = derive) on top. */
export function hostHeavySlotBudget(slotsOverride: number): HeavySlotBudget {
  return defaultHeavySlotBudget(
    { cpus: cpus().length, memTotalBytes: totalmem() },
    slotsOverride > 0 ? slotsOverride : null,
  );
}

/** Linux: MemAvailable + memory PSI `full avg10`; anything else is unassessable (null, null). */
async function defaultSampleMemory(): Promise<MemorySample> {
  if (process.platform !== "linux") return { availableBytes: null, psiFullAvg10: null };
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  const [meminfo, psi] = await Promise.all([read("/proc/meminfo"), read("/proc/pressure/memory")]);
  return { availableBytes: parseMemAvailable(meminfo), psiFullAvg10: parsePsiAvg10(psi, "full") };
}

function defaultGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The value of `name` in a NUL-separated environ block, or null. */
export function environValue(environ: string, name: string): string | null {
  const needle = `${name}=`;
  for (const entry of environ.split("\0"))
    if (entry.startsWith(needle)) return entry.slice(needle.length);
  return null;
}

/**
 * Every live process carrying one of `jobIds` as SHEPHERD_HEAVY_JOB, with its RSS. Async and
 * bounded: an environ read takes the target's mmap lock and can stall on a process under memory
 * pressure — exactly when this runs — so it must never sit on the event loop.
 */
export async function scanMarkersLinux(
  jobIds: ReadonlySet<string>,
): Promise<Map<string, ProcStat> | null> {
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  const out = new Map<string, ProcStat>();
  await mapBounded(pids, SCAN_CONCURRENCY, async (pid) => {
    const environ = await readFile(`/proc/${pid}/environ`, "latin1").catch(() => "");
    const id = environ ? environValue(environ, HEAVY_JOB_ENV) : null;
    if (!id || !jobIds.has(id)) return;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const kb = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const stat = out.get(id) ?? { count: 0, rssBytes: 0 };
    stat.count++;
    stat.rssBytes += kb ? Number(kb[1]) * 1024 : 0;
    out.set(id, stat);
  });
  return out;
}
