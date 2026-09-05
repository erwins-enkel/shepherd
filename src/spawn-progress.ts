/**
 * Phase measurement for one agent spawn (`SessionService.create`).
 *
 * `create()` answers the HTTP request only once the agent is actually running, and the longest
 * stretch inside it — waiting for herdr to auto-detect a trusted agent — can run to 30s. Nothing
 * measured that, and the New Task dialog got no signal between click and answer.
 *
 * This tracker closes both gaps from ONE place: it always measures (so every spawn leaves a single
 * `[create] spawn …` line naming where the time went), and it optionally reports each phase to a
 * subscriber (the dialog, via the `spawn:progress` WS event) when the caller supplied a spawn id.
 * It also owns the `AbortSignal` that reaches herdr's poll loop, which is what makes "cancel"
 * effective during the long phase rather than only between phases.
 */

/** The measured sections of a spawn, in the order `create()` runs them. */
export type SpawnPhase = "base" | "worktree" | "prompt" | "launch" | "agent";

/** How a spawn ended, as stamped on the log line. */
export type SpawnOutcomeStatus = "ok" | "failed" | "canceled";

/**
 * Shape a client-supplied spawn id must have to be accepted. The id is chosen by the browser (a
 * `crypto.randomUUID()`), reaches us through a header and becomes both a Map key and part of a
 * broadcast event — so it is bounded in length and alphabet here rather than trusted as sent.
 */
const SPAWN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function isValidSpawnId(id: string): boolean {
  return SPAWN_ID_RE.test(id);
}

/** Thrown when the operator cancels a spawn that is still in flight. */
export class SpawnCanceled extends Error {
  constructor() {
    super("spawn canceled");
    this.name = "SpawnCanceled";
  }
}

/** One `spawn:progress` payload: the phase now running, plus every phase already done. */
export interface SpawnPhaseProgress {
  spawnId: string;
  phase: SpawnPhase;
  /** Wall clock at which the CURRENT phase started, so the client can run its own counter. */
  startedAt: number;
  completed: { phase: SpawnPhase; ms: number }[];
}

export interface SpawnPhaseTrackerDeps {
  /** Absent for an unobserved spawn (drain, held-release, relaunch): measures + logs, emits nothing. */
  spawnId?: string;
  emit?: (progress: SpawnPhaseProgress) => void;
  now?: () => number;
  log?: (line: string) => void;
  /** Yields to the event loop; injected so tests need no real timer. See `phase()`. */
  yieldToLoop?: () => Promise<void>;
}

const realYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export class SpawnPhaseTracker {
  readonly spawnId: string | null;
  readonly #emit: ((progress: SpawnPhaseProgress) => void) | null;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #yield: () => Promise<void>;
  readonly #controller = new AbortController();
  readonly #completed: { phase: SpawnPhase; ms: number }[] = [];
  readonly #startedAt: number;
  #sealed = false;

  constructor(deps: SpawnPhaseTrackerDeps = {}) {
    this.spawnId = deps.spawnId ?? null;
    this.#emit = deps.emit ?? null;
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? ((line) => console.info(line));
    this.#yield = deps.yieldToLoop ?? realYield;
    this.#startedAt = this.#now();
  }

  /** Reaches herdr's auto-detect poll loop, so a cancel lands mid-phase and not just between phases. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get canceled(): boolean {
    return this.#controller.signal.aborted;
  }

  /**
   * Run one phase, measuring it and (when observed) announcing it before it starts.
   *
   * The announce is followed by a yield because the very next phase may seize the loop:
   * `Worktrees.create()` shells out to `git worktree add` SYNCHRONOUSLY, and without the yield the
   * just-enqueued socket write would not reach the browser until that call returned — the dialog
   * would learn about the phase only once it was over.
   *
   * Measurement happens in `finally` so a phase that THREW still appears on the log line. That is
   * the interesting case: a spawn that dies after 30s in `agent` must say so.
   */
  async phase<T>(phase: SpawnPhase, fn: () => T | Promise<T>): Promise<T> {
    this.throwIfCanceled();
    const started = this.#now();
    if (this.#emit && this.spawnId) {
      this.#emit({
        spawnId: this.spawnId,
        phase,
        startedAt: started,
        completed: [...this.#completed],
      });
      await this.#yield();
    }
    try {
      return await fn();
    } finally {
      this.#completed.push({ phase, ms: this.#now() - started });
    }
  }

  /**
   * Claim the point of no return: the agent is up, so cancelling past here would tear down a live
   * session. Returns false when a cancel got there first — the caller then owes the operator the
   * teardown the cancel route already promised them.
   *
   * This is the ONE place the race is decided. `seal()` and `cancel()` both read and write the
   * same two flags with no `await` between the read and the write, so on a single-threaded loop
   * exactly one of them can win, whatever the driver did in between.
   */
  seal(): boolean {
    if (this.#controller.signal.aborted) return false;
    this.#sealed = true;
    return true;
  }

  /** False when the spawn is already sealed (or already cancelled) — the caller reports "too late". */
  cancel(): boolean {
    if (this.#sealed || this.#controller.signal.aborted) return false;
    this.#controller.abort();
    return true;
  }

  throwIfCanceled(): void {
    if (this.#controller.signal.aborted) throw new SpawnCanceled();
  }

  /** The one line per spawn: every phase that ran, with its duration, plus the total. */
  finish(status: SpawnOutcomeStatus): void {
    const phases = this.#completed.map((c) => `${c.phase} ${secs(c.ms)}`).join(" ");
    const total = secs(this.#now() - this.#startedAt);
    this.#log(`[create] spawn ${status}${phases ? ` ${phases}` : ""} total ${total}`);
  }
}

// ── in-flight registry ────────────────────────────────────────────────────────
//
// Process-wide, and bounded by construction: an entry lives exactly as long as the HTTP request
// that created it (the route registers before `create()` and releases in a `finally`). Only
// observed spawns are registered — an unobserved one has no id to cancel by.

const active = new Map<string, SpawnPhaseTracker>();

export function registerSpawn(tracker: SpawnPhaseTracker): void {
  if (tracker.spawnId) active.set(tracker.spawnId, tracker);
}

export function releaseSpawn(spawnId: string | null): void {
  if (spawnId) active.delete(spawnId);
}

/**
 * Cancel an in-flight spawn.
 * - `canceled` — the signal fired; `create()` will unwind and roll back.
 * - `too_late`  — the spawn is sealed (agent already up); it runs to completion.
 * - `unknown`   — no such spawn in flight.
 */
export function cancelSpawn(spawnId: string): "canceled" | "too_late" | "unknown" {
  const tracker = active.get(spawnId);
  if (!tracker) return "unknown";
  return tracker.cancel() ? "canceled" : "too_late";
}

/** Test seam: drop every registration (no cancellation). */
export function resetSpawnRegistry(): void {
  active.clear();
}
