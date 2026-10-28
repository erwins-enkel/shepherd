// Host-wide heavy-check slot (#3181) — the pure core: job states, the queue, the pressure brake,
// wait estimates and the agent-facing text. No I/O, no timers: HeavySlotService (src/heavy-slot.ts)
// owns persistence, the /proc scan, the memory sampler and the steer, and drives this core.
//
// A heavy check (tests, type checks, builds) asks for the slot BEFORE its process starts. Jobs move
// queued → offered → running → (lingering) → done, or end `dropped`. `offered`, `running` and
// `lingering` hold a slot: an offer reserves it for the queued session Shepherd just steered, and a
// lingering job's command has exited while processes carrying its marker still run — the slot is
// bound to the process tree, not to the command's exit (#3181, "Slot an Job und Prozessbaum
// binden"). FIFO, no barging: a free slot goes to the queue head as an offer, never to a newcomer.

export type HeavyJobState = "queued" | "offered" | "running" | "lingering" | "done" | "dropped";
/** Why a job ended without running to completion. */
export type HeavyDropReason = "expired" | "steer_missed" | "session_gone" | "disabled" | "released";
/** What a queued job is waiting for: a free slot, or the pressure brake to let go. */
export type HeavyWaitReason = "slot" | "pressure";
export type HeavyBrakeReason = "memory_available" | "memory_pressure";

export interface HeavyJob {
  id: string;
  sessionId: string;
  /** The command as the agent typed it, capped at {@link COMMAND_MAX_CHARS}. */
  command: string;
  cwd: string | null;
  /** Groups jobs whose past slot occupancy predicts this one's (see {@link heavyEtaKey}). */
  etaKey: string;
  state: HeavyJobState;
  enqueuedAt: number;
  offerExpiresAt: number | null;
  startedAt: number | null;
  /** When the runner reported the command's exit (not the slot release). */
  finishedAt: number | null;
  /** When the job stopped holding a slot (done or dropped). */
  releasedAt: number | null;
  exitCode: number | null;
  /** macOS only: the process group the runner started the command in. */
  pgid: number | null;
  dropReason: HeavyDropReason | null;
  /** The commit and dirty-worktree hash the command started on (#3554); null until captured. */
  head: string | null;
  treeHash: string | null;
}

export interface HeavySlotBudget {
  slots: number;
  /** Brake engages below this much `MemAvailable`. */
  minAvailableBytes: number;
  /** Brake engages above this memory PSI `full avg10` (percent). */
  psiFullMax: number;
  /** Brake lets go only after both readings stayed under their limits this long. */
  releaseHoldMs: number;
}

export interface MemorySample {
  /** Present only on Darwin; null means the probe could not assess pressure. */
  darwinPressure?: "normal" | "warning" | "critical" | null;
  availableBytes: number | null;
  psiFullAvg10: number | null;
}

export interface BrakeState {
  engaged: boolean;
  reason: HeavyBrakeReason | null;
  /** Start of the current run of under-limit samples while engaged; null otherwise. */
  clearSince: number | null;
  sample: MemorySample | null;
  sampledAt: number | null;
}

export const OFFER_TTL_MS = 5 * 60_000;
/** A running job with no marker process is released only after this long — the runner spawns the
 *  command a moment after the grant, and a scan in between must not free the slot. */
export const RUNNING_GRACE_MS = 15_000;
const COMMAND_MAX_CHARS = 500;
/** Durations feeding a wait estimate: the most recent this many per {@link heavyEtaKey}. */
export const ETA_HISTORY = 20;

const GIB = 1024 ** 3;

/**
 * The budget a host gets with no configuration (#3181): every heavy runner already saturates all
 * cores (Vitest workers, `--max-concurrency`, cargo jobs = core count), so extra slots only pay off
 * on a big box — one per 16 cores AND 32 GiB, never fewer than one. The brake thresholds are the
 * issue's provisional values: at most 4 GiB (15 % of RAM on a smaller host) and PSI `full` 20 %,
 * let go after 30 s. `slotsOverride` (SHEPHERD_HEAVY_SLOTS) wins when it is a positive integer.
 */
export function defaultHeavySlotBudget(
  hw: { cpus: number; memTotalBytes: number },
  slotsOverride?: number | null,
): HeavySlotBudget {
  const derived = Math.max(
    1,
    Math.min(Math.floor(hw.cpus / 16), Math.floor(hw.memTotalBytes / (32 * GIB))),
  );
  const slots =
    slotsOverride != null && Number.isInteger(slotsOverride) && slotsOverride > 0
      ? slotsOverride
      : derived;
  return {
    slots,
    minAvailableBytes: Math.min(4 * GIB, Math.floor(hw.memTotalBytes * 0.15)),
    psiFullMax: 20,
    releaseHoldMs: 30_000,
  };
}

export const BRAKE_OFF: BrakeState = {
  engaged: false,
  reason: null,
  clearSince: null,
  sample: null,
  sampledAt: null,
};

/** Which limit `sample` breaks, or null. An unreadable value breaks nothing (macOS has no PSI). */
function overLimit(sample: MemorySample, budget: HeavySlotBudget): HeavyBrakeReason | null {
  if (sample.availableBytes !== null && sample.availableBytes < budget.minAvailableBytes)
    return "memory_available";
  if (sample.darwinPressure === "warning" || sample.darwinPressure === "critical")
    return "memory_pressure";
  if (sample.psiFullAvg10 !== null && sample.psiFullAvg10 > budget.psiFullMax)
    return "memory_pressure";
  return null;
}

/**
 * Fold one memory sample into the brake. It engages on the first over-limit sample and lets go only
 * once samples have stayed under both limits for `releaseHoldMs` — without that hold a momentary dip
 * in pressure would start the next heavy job straight into the same storm. Any over-limit sample
 * while engaged restarts the hold.
 */
export function nextBrake(
  prev: BrakeState,
  sample: MemorySample,
  budget: HeavySlotBudget,
  now: number,
): BrakeState {
  const over = overLimit(sample, budget);
  if (over) return { engaged: true, reason: over, clearSince: null, sample, sampledAt: now };
  if (!prev.engaged) return { ...BRAKE_OFF, sample, sampledAt: now };
  if (
    "darwinPressure" in sample &&
    (sample.darwinPressure !== "normal" || sample.availableBytes === null)
  )
    return { ...prev, clearSince: null, sample, sampledAt: now };
  const clearSince = prev.clearSince ?? now;
  if (now - clearSince >= budget.releaseHoldMs) return { ...BRAKE_OFF, sample, sampledAt: now };
  return { ...prev, clearSince, sample, sampledAt: now };
}

/** A command collapsed to one line and capped, for storage and display. */
export function normalizeCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > COMMAND_MAX_CHARS ? `${flat.slice(0, COMMAND_MAX_CHARS - 1)}…` : flat;
}

/**
 * The key past durations are looked up by: the repo, the cwd relative to the session's worktree
 * (so `ui/` and the root differ, but every worktree of the repo shares history) and the command.
 */
export function heavyEtaKey(
  repoPath: string,
  worktreePath: string,
  cwd: string | null,
  command: string,
): string {
  let rel = "?";
  if (cwd === worktreePath) rel = ".";
  else if (cwd?.startsWith(`${worktreePath}/`)) rel = cwd.slice(worktreePath.length + 1);
  return `${repoPath}\u0000${rel}\u0000${normalizeCommand(command)}`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const HOLDS_SLOT: ReadonlySet<HeavyJobState> = new Set(["offered", "running", "lingering"]);
const TERMINAL: ReadonlySet<HeavyJobState> = new Set(["done", "dropped"]);

/**
 * How the sweep ends one job, or null to keep it. A holder ends `done` once its processes are gone
 * (a running one only after the grace — the runner may not have spawned yet); a waiter is dropped
 * when its session is gone or its offer ran out.
 */
function settle(
  job: HeavyJob,
  now: number,
  alive: (job: HeavyJob) => boolean | null,
  sessionActive: (sessionId: string) => boolean,
): "done" | HeavyDropReason | null {
  if (job.state === "running" || job.state === "lingering") {
    const graced = job.state === "lingering" || now - (job.startedAt ?? now) > RUNNING_GRACE_MS;
    return graced && alive(job) === false ? "done" : null;
  }
  if (!sessionActive(job.sessionId)) return "session_gone";
  return job.state === "offered" && now > (job.offerExpiresAt ?? now) ? "expired" : null;
}

export type AcquireOutcome =
  | { kind: "unmanaged" }
  | { kind: "run"; job: HeavyJob }
  | {
      kind: "queued";
      job: HeavyJob;
      position: number;
      total: number;
      reason: HeavyWaitReason;
      /** True when the session was already queued — the agent asked again instead of waiting. */
      repeat: boolean;
    };

export interface LedgerContext {
  now: number;
  budget: HeavySlotBudget;
  brakeEngaged: boolean;
}

/**
 * The non-terminal jobs and every transition between them. Mutating, but pure of I/O: each change
 * marks the job dirty, and the service persists and announces whatever {@link takeDirty} returns.
 */
export class HeavyLedger {
  #jobs = new Map<string, HeavyJob>();
  #dirty = new Map<string, HeavyJob>();

  constructor(jobs: readonly HeavyJob[] = []) {
    for (const j of jobs) if (!TERMINAL.has(j.state)) this.#jobs.set(j.id, { ...j });
  }

  /** Jobs holding a slot, oldest first. */
  active(): HeavyJob[] {
    return [...this.#jobs.values()]
      .filter((j) => HOLDS_SLOT.has(j.state))
      .toSorted((a, b) => (a.startedAt ?? a.enqueuedAt) - (b.startedAt ?? b.enqueuedAt));
  }

  /** Queued jobs in the order they get the slot. */
  queue(): HeavyJob[] {
    return [...this.#jobs.values()]
      .filter((j) => j.state === "queued")
      .toSorted((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id));
  }

  get(id: string): HeavyJob | null {
    return this.#jobs.get(id) ?? null;
  }

  all(): HeavyJob[] {
    return [...this.#jobs.values()];
  }

  /** Binds a running job to the source state it started on. */
  setRevision(id: string, head: string | null, treeHash: string): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    job.head = head;
    job.treeHash = treeHash;
    this.#touch(job);
  }

  /** Jobs changed since the last call, including ones that just turned terminal. */
  takeDirty(): HeavyJob[] {
    const out = [...this.#dirty.values()];
    this.#dirty.clear();
    return out;
  }

  #touch(job: HeavyJob): HeavyJob {
    this.#dirty.set(job.id, { ...job });
    if (TERMINAL.has(job.state)) this.#jobs.delete(job.id);
    return job;
  }

  #ofSession(sessionId: string, state: HeavyJobState): HeavyJob | null {
    for (const j of this.#jobs.values())
      if (j.sessionId === sessionId && j.state === state) return j;
    return null;
  }

  /** True while the session waits for the slot (queued, or offered and not yet claimed). */
  waiting(sessionId: string): boolean {
    return (
      this.#ofSession(sessionId, "queued") !== null ||
      this.#ofSession(sessionId, "offered") !== null
    );
  }

  #release(job: HeavyJob, now: number, state: "done" | "dropped", reason?: HeavyDropReason) {
    job.state = state;
    job.releasedAt = now;
    job.offerExpiresAt = null;
    if (reason) job.dropReason = reason;
    this.#touch(job);
  }

  /**
   * A heavy check asks for the slot. An offer this session holds is claimed first (it was made
   * while the slot and the brake allowed it); an existing queue entry is refreshed, never doubled;
   * otherwise the job runs at once only when a slot is free, nobody waits and the brake is off.
   */
  acquire(
    req: { id: string; sessionId: string; command: string; cwd: string | null; etaKey: string },
    ctx: LedgerContext,
  ): AcquireOutcome {
    const command = normalizeCommand(req.command);
    const offered = this.#ofSession(req.sessionId, "offered");
    if (offered) {
      Object.assign(offered, {
        state: "running",
        command,
        cwd: req.cwd,
        etaKey: req.etaKey,
        startedAt: ctx.now,
        offerExpiresAt: null,
      });
      return { kind: "run", job: this.#touch(offered) };
    }
    const queued = this.#ofSession(req.sessionId, "queued");
    if (queued) {
      Object.assign(queued, { command, cwd: req.cwd, etaKey: req.etaKey });
      this.#touch(queued);
      return this.#queuedOutcome(queued, ctx, true);
    }
    const job: HeavyJob = {
      id: req.id,
      sessionId: req.sessionId,
      command,
      cwd: req.cwd,
      etaKey: req.etaKey,
      state: "queued",
      // Keep FIFO stable even when requests share a millisecond and IDs are random UUIDs.
      // The timestamp is persisted, so restart preserves the same ordering.
      enqueuedAt: Math.max(ctx.now, ...this.all().map((j) => j.enqueuedAt + 1)),
      offerExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      releasedAt: null,
      exitCode: null,
      pgid: null,
      dropReason: null,
      head: null,
      treeHash: null,
    };
    this.#jobs.set(job.id, job);
    if (this.active().length < ctx.budget.slots && !ctx.brakeEngaged && this.queue().length === 1) {
      job.state = "running";
      job.startedAt = ctx.now;
      return { kind: "run", job: this.#touch(job) };
    }
    this.#touch(job);
    return this.#queuedOutcome(job, ctx, false);
  }

  #queuedOutcome(
    job: HeavyJob,
    ctx: LedgerContext,
    repeat: boolean,
  ): Extract<AcquireOutcome, { kind: "queued" }> {
    const queue = this.queue();
    return {
      kind: "queued",
      job,
      position: queue.findIndex((j) => j.id === job.id) + 1,
      total: queue.length,
      reason: ctx.brakeEngaged ? "pressure" : "slot",
      repeat,
    };
  }

  /** macOS: the runner reports the process group it started the command in. */
  started(jobId: string, sessionId: string, pgid: number): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.sessionId !== sessionId || job.state !== "running") return false;
    job.pgid = pgid;
    this.#touch(job);
    return true;
  }

  /**
   * The runner reports the command's exit. `stillAlive` is the caller's scan: processes carrying
   * the job's marker outlived the command (a daemon, a detached browser) → the slot stays bound.
   */
  finish(
    jobId: string,
    sessionId: string,
    exitCode: number | null,
    stillAlive: boolean,
    now: number,
  ): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.sessionId !== sessionId || job.state !== "running") return false;
    job.finishedAt = now;
    job.exitCode = exitCode;
    if (stillAlive) {
      job.state = "lingering";
      this.#touch(job);
    } else {
      this.#release(job, now, "done");
    }
    return true;
  }

  /**
   * The periodic sweep. `alive(job)` is the process scan (null = cannot tell, so nothing is freed
   * on a guess); `sessionActive(id)` is false for an archived or unknown session.
   */
  reconcile(
    now: number,
    alive: (job: HeavyJob) => boolean | null,
    sessionActive: (sessionId: string) => boolean,
  ): void {
    for (const job of this.all()) {
      const end = settle(job, now, alive, sessionActive);
      if (end === "done") this.#release(job, now, "done");
      else if (end) this.#release(job, now, "dropped", end);
    }
  }

  /** Operator: free a slot by hand. Kills nothing — the processes keep running, untracked. */
  release(jobId: string, now: number): HeavyJob | null {
    const job = this.#jobs.get(jobId);
    if (!job || !HOLDS_SLOT.has(job.state)) return null;
    this.#release(job, now, "dropped", "released");
    return job;
  }

  drop(jobId: string, reason: HeavyDropReason, now: number): void {
    const job = this.#jobs.get(jobId);
    if (job) this.#release(job, now, "dropped", reason);
  }

  dropAll(reason: HeavyDropReason, now: number): void {
    for (const job of this.all()) this.#release(job, now, "dropped", reason);
  }

  /** Hand free slots to the queue head as offers. Returns the jobs just offered (to steer). */
  fill(ctx: LedgerContext, offerTtlMs = OFFER_TTL_MS): HeavyJob[] {
    const offered: HeavyJob[] = [];
    if (ctx.brakeEngaged) return offered;
    let free = ctx.budget.slots - this.active().length;
    for (const job of this.queue()) {
      if (free <= 0) break;
      job.state = "offered";
      job.offerExpiresAt = ctx.now + offerTtlMs;
      offered.push(this.#touch(job));
      free--;
    }
    return offered;
  }
}

/**
 * Estimated wait per queued job: each slot frees at its holder's start plus its usual occupancy,
 * and the queue takes the slots in order. Any unknown along the way (no history, a lingering
 * holder, the brake engaged) makes this job's estimate — and every later one's — null: an
 * estimate the card shows must be one Shepherd can actually back (#3181).
 */
export function estimateWaits(
  active: readonly HeavyJob[],
  queue: readonly HeavyJob[],
  history: ReadonlyMap<string, readonly number[]>,
  slots: number,
  brakeEngaged: boolean,
  now: number,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const typical = (key: string) => median(history.get(key) ?? []);
  const frees: (number | null)[] = active.map((j) => {
    if (j.state === "lingering") return null;
    const t = typical(j.etaKey);
    if (t === null) return null;
    return Math.max(now, (j.state === "offered" ? now : (j.startedAt ?? now)) + t);
  });
  while (frees.length < slots) frees.push(now);
  let poisoned = brakeEngaged;
  for (const job of queue) {
    if (poisoned || frees.some((f) => f === null)) {
      poisoned = true;
      out.set(job.id, null);
      continue;
    }
    const known = frees as number[];
    const idx = known.indexOf(Math.min(...known));
    const start = known[idx]!;
    out.set(job.id, start - now);
    const t = typical(job.etaKey);
    frees[idx] = t === null ? null : start + t;
  }
  return out;
}

/** "~4 min" for the agent-facing text; seconds round up to a minute. */
function minutes(ms: number): string {
  return `~${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

/**
 * What the runner prints when the check did NOT run. Typed into the agent's tool result, so fixed
 * English (the same precedent as ciFinishedSteer). It has to stop the three failure modes a refusal
 * invites: polling, reading exit 75 as a test failure, and skipping the check altogether.
 */
export function queuedMessage(
  command: string,
  out: {
    position: number;
    total: number;
    etaMs: number | null;
    reason: HeavyWaitReason;
    repeat: boolean;
  },
): string {
  const wait = out.etaMs === null ? "wait unknown" : `estimated wait ${minutes(out.etaMs)}`;
  const pressure =
    out.reason === "pressure" ? " The host is under memory pressure; starts are on hold." : "";
  return [
    `Shepherd: NOT RUN. \`${command}\` is a heavy check (tests, type checks, builds), and this host ` +
      "runs those one at a time so it stays responsive.",
    `${out.repeat ? "Still queued" : "Queued"} for the heavy-check slot: place ${out.position} of ` +
      `${out.total}, ${wait}.${pressure}`,
    "Do not retry, poll, or skip this check. Continue with other work, or end your turn if nothing " +
      "else is left. Shepherd will message you when the slot is yours; then rerun this exact command.",
  ].join("\n");
}

/** The steer that hands the queue head its slot. Fixed English, typed into the PTY. */
export function offerSteer(job: HeavyJob, ttlMs = OFFER_TTL_MS): string {
  return (
    `Shepherd: the heavy-check slot is free for you now. Rerun the check you queued ` +
    `(\`${job.command}\`) within ${Math.round(ttlMs / 60_000)} minutes — Shepherd routes it ` +
    "through the slot automatically. After that the slot passes to the next session."
  );
}

/** One job as the UI sees it. */
export interface HeavySlotJobView {
  id: string;
  sessionId: string;
  command: string;
  state: "queued" | "offered" | "running" | "lingering";
  /** 1-based place in the queue (queued jobs only). */
  position: number | null;
  enqueuedAt: number;
  startedAt: number | null;
  offerExpiresAt: number | null;
  /** Processes carrying the job's marker at the last scan; null when not scanned (macOS, queued). */
  processCount: number | null;
  rssBytes: number | null;
  /** Estimated wait (queued jobs); null when Shepherd cannot back an estimate. */
  etaMs: number | null;
  waitReason: HeavyWaitReason | null;
}

/** Internal ledger view; the service projects it onto the public snapshot contract. */
export interface HeavySlotLedgerView {
  enabled: boolean;
  slots: number;
  brake: {
    engaged: boolean;
    reason: HeavyBrakeReason | null;
    availableBytes: number | null;
    psiFullAvg10: number | null;
    minAvailableBytes: number;
    psiFullMax: number;
  };
  jobs: HeavySlotJobView[];
}

export function buildSnapshot(
  ledger: HeavyLedger,
  opts: {
    enabled: boolean;
    budget: HeavySlotBudget;
    brake: BrakeState;
    waits: ReadonlyMap<string, number | null>;
    procs: ReadonlyMap<string, { count: number; rssBytes: number }>;
  },
): HeavySlotLedgerView {
  const { budget, brake } = opts;
  const queue = ledger.queue();
  const view = (j: HeavyJob): HeavySlotJobView => {
    const proc = opts.procs.get(j.id);
    const position = j.state === "queued" ? queue.findIndex((q) => q.id === j.id) + 1 : null;
    return {
      id: j.id,
      sessionId: j.sessionId,
      command: j.command,
      state: j.state as HeavySlotJobView["state"],
      position,
      enqueuedAt: j.enqueuedAt,
      startedAt: j.startedAt,
      offerExpiresAt: j.offerExpiresAt,
      processCount: proc?.count ?? null,
      rssBytes: proc?.rssBytes ?? null,
      etaMs: opts.waits.get(j.id) ?? null,
      waitReason: j.state === "queued" ? (brake.engaged ? "pressure" : "slot") : null,
    };
  };
  return {
    enabled: opts.enabled,
    slots: budget.slots,
    brake: {
      engaged: brake.engaged,
      reason: brake.reason,
      availableBytes: brake.sample?.availableBytes ?? null,
      psiFullAvg10: brake.sample?.psiFullAvg10 ?? null,
      minAvailableBytes: budget.minAvailableBytes,
      psiFullMax: budget.psiFullMax,
    },
    jobs: [...ledger.active(), ...queue].map(view),
  };
}
