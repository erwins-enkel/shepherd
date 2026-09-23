/**
 * Pure core of the event-loop watchdog (see `loop-watchdog.ts` for the wiring and the WHY).
 *
 * Everything here is thread-agnostic and timer-free so it can be unit-tested directly: the
 * shared-memory operation registry both threads view, the stall monitor the worker runs, and the
 * dump formatter. Nothing in this file may touch the event loop — the whole point of the design is
 * that the reader side keeps working while the main thread is spinning.
 */

/** Concurrent in-flight operations tracked. Overflow is counted, never blocks the caller. */
export const SLOTS = 64;
/** Recently finished operations kept for the timeline (newest overwrite oldest). */
export const RING = 32;
/** Max UTF-8 bytes of an operation label; longer labels are truncated. */
export const LABEL_BYTES = 120;

/** The SharedArrayBuffers backing one registry. Plain data, so it survives `postMessage`. */
export interface RegistryBuffers {
  /** [0] = timestamp (ms) of the main loop's last heartbeat. BigInt64 so Atomics covers it. */
  beat: SharedArrayBuffer;
  /** [0] = operations dropped because every slot was busy; [1] = next ring write index. */
  counters: SharedArrayBuffer;
  slotState: SharedArrayBuffer;
  slotLen: SharedArrayBuffer;
  slotStart: SharedArrayBuffer;
  slotLabel: SharedArrayBuffer;
  ringLen: SharedArrayBuffer;
  ringStart: SharedArrayBuffer;
  ringEnd: SharedArrayBuffer;
  ringLabel: SharedArrayBuffer;
}

export function allocRegistryBuffers(): RegistryBuffers {
  const sab = (bytes: number) => new SharedArrayBuffer(bytes);
  return {
    beat: sab(8),
    counters: sab(8),
    slotState: sab(SLOTS * 4),
    slotLen: sab(SLOTS * 4),
    slotStart: sab(SLOTS * 8),
    slotLabel: sab(SLOTS * LABEL_BYTES),
    ringLen: sab(RING * 4),
    ringStart: sab(RING * 8),
    ringEnd: sab(RING * 8),
    ringLabel: sab(RING * LABEL_BYTES),
  };
}

export interface OpRecord {
  label: string;
  start: number;
  /** Absent for an operation still in flight. */
  end?: number;
}

export interface RegistrySnapshot {
  lastBeat: number;
  inFlight: OpRecord[];
  recent: OpRecord[];
  dropped: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Labels go straight into the log on a stall; strip anything that could forge a log line. */
export function sanitizeLabel(label: string): string {
  let out = "";
  for (const ch of label) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/**
 * Typed views over one set of {@link RegistryBuffers}. The main thread writes through
 * {@link start}/{@link end}/{@link beat}; the worker reads through {@link snapshot}. Writers
 * publish a slot's data BEFORE flipping its state with `Atomics.store` (a full fence), and the
 * reader loads the state with `Atomics.load` before touching the data, so a reader never sees a
 * half-written record for a slot it considers live.
 */
export class OpRegistry {
  private readonly beatView: BigInt64Array;
  private readonly counters: Int32Array;
  private readonly slotState: Int32Array;
  private readonly slotLen: Int32Array;
  private readonly slotStart: Float64Array;
  private readonly slotLabel: Uint8Array;
  private readonly ringLen: Int32Array;
  private readonly ringStart: Float64Array;
  private readonly ringEnd: Float64Array;
  private readonly ringLabel: Uint8Array;

  constructor(readonly buffers: RegistryBuffers) {
    this.beatView = new BigInt64Array(buffers.beat);
    this.counters = new Int32Array(buffers.counters);
    this.slotState = new Int32Array(buffers.slotState);
    this.slotLen = new Int32Array(buffers.slotLen);
    this.slotStart = new Float64Array(buffers.slotStart);
    this.slotLabel = new Uint8Array(buffers.slotLabel);
    this.ringLen = new Int32Array(buffers.ringLen);
    this.ringStart = new Float64Array(buffers.ringStart);
    this.ringEnd = new Float64Array(buffers.ringEnd);
    this.ringLabel = new Uint8Array(buffers.ringLabel);
  }

  /** Main loop is alive at `now`. */
  beat(now: number): void {
    Atomics.store(this.beatView, 0, BigInt(Math.trunc(now)));
  }

  /** Timestamp of the last heartbeat — the worker's cheap per-tick read. */
  lastBeat(): number {
    return Number(Atomics.load(this.beatView, 0));
  }

  /** Record an operation starting. Returns its slot, or -1 when the registry is full. */
  start(label: string, now: number): number {
    for (let i = 0; i < SLOTS; i++) {
      if (Atomics.load(this.slotState, i) !== 0) continue;
      this.slotLen[i] = writeLabel(this.slotLabel, i, label);
      this.slotStart[i] = now;
      Atomics.store(this.slotState, i, 1);
      return i;
    }
    Atomics.add(this.counters, 0, 1);
    return -1;
  }

  /** Record the operation in `slot` finishing: free the slot, append it to the ring. */
  end(slot: number, now: number): void {
    if (slot < 0 || slot >= SLOTS) return;
    const r = Atomics.add(this.counters, 1, 1) % RING;
    const len = this.slotLen[slot]!;
    // Cross-buffer copy (slot table → ring table); copyWithin would only move bytes inside one.
    this.ringLabel.set(
      this.slotLabel.subarray(slot * LABEL_BYTES, slot * LABEL_BYTES + len),
      r * LABEL_BYTES,
    );
    this.ringLen[r] = len;
    this.ringStart[r] = this.slotStart[slot]!;
    this.ringEnd[r] = now;
    Atomics.store(this.slotState, slot, 0);
  }

  snapshot(): RegistrySnapshot {
    const inFlight: OpRecord[] = [];
    for (let i = 0; i < SLOTS; i++) {
      if (Atomics.load(this.slotState, i) !== 1) continue;
      inFlight.push({
        label: readLabel(this.slotLabel, i, this.slotLen[i]!),
        start: this.slotStart[i]!,
      });
    }
    inFlight.sort((a, b) => a.start - b.start);

    const written = Atomics.load(this.counters, 1);
    const recent: OpRecord[] = [];
    for (let k = Math.max(0, written - RING); k < written; k++) {
      const r = k % RING;
      recent.push({
        label: readLabel(this.ringLabel, r, this.ringLen[r]!),
        start: this.ringStart[r]!,
        end: this.ringEnd[r]!,
      });
    }
    return {
      lastBeat: this.lastBeat(),
      inFlight,
      recent,
      dropped: Atomics.load(this.counters, 0),
    };
  }
}

/** Write `label` into row `row` of a label table; returns the byte length written. */
function writeLabel(table: Uint8Array, row: number, label: string): number {
  // Encode into ordinary memory first: TextEncoder.encodeInto rejects shared-buffer views.
  let bytes: Uint8Array = encoder.encode(sanitizeLabel(label));
  if (bytes.length > LABEL_BYTES) bytes = truncateUtf8(bytes, LABEL_BYTES);
  table.set(bytes, row * LABEL_BYTES);
  return bytes.length;
}

function readLabel(table: Uint8Array, row: number, len: number): string {
  const n = Math.max(0, Math.min(len, LABEL_BYTES));
  // `slice` copies into a non-shared buffer — TextDecoder rejects shared-buffer views.
  return decoder.decode(table.slice(row * LABEL_BYTES, row * LABEL_BYTES + n));
}

/** Cut to at most `max` bytes without splitting a multi-byte UTF-8 sequence. */
function truncateUtf8(bytes: Uint8Array, max: number): Uint8Array {
  let end = max;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

// ── stall monitor (runs in the worker) ────────────────────────────────────────────────────

export interface MonitorConfig {
  /** Report a stall once the last heartbeat is at least this old. */
  stallReportMs: number;
  /** Only ping systemd while the last heartbeat is younger than this. */
  pingFreshMs: number;
}

export interface MonitorDecision {
  /** Loop is alive — tell systemd so. */
  ping: boolean;
  /** A stall just crossed the report threshold — dump the registry (once per episode). */
  reportStall: boolean;
  /** A reported stall has ended — how long the loop was frozen, else null. */
  recoveredAfterMs: number | null;
}

/**
 * Decides, from the last heartbeat alone, whether to vouch for the main loop to systemd and when
 * to dump. Holds only per-episode state (has this stall been reported yet), so a long-but-finite
 * block reports once, logs its recovery, and never touches the watchdog budget on the way.
 */
export class StallMonitor {
  private stallReportedAt: number | null = null;

  constructor(private readonly cfg: MonitorConfig) {}

  tick(lastBeat: number, now: number): MonitorDecision {
    const age = now - lastBeat;
    const decision: MonitorDecision = {
      ping: lastBeat > 0 && age < this.cfg.pingFreshMs,
      reportStall: false,
      recoveredAfterMs: null,
    };
    if (age >= this.cfg.stallReportMs) {
      if (this.stallReportedAt === null) {
        this.stallReportedAt = lastBeat;
        decision.reportStall = true;
      }
    } else if (this.stallReportedAt !== null) {
      decision.recoveredAfterMs = lastBeat - this.stallReportedAt;
      this.stallReportedAt = null;
    }
    return decision;
  }
}

// ── dump formatting ───────────────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * The stall report, one self-contained `[loop-watchdog]` line per row so it greps cleanly out of
 * the shared log. Timestamps are absolute ISO — `shepherd.log` has none of its own, and these are
 * what let the report be lined up against `journalctl --user -u shepherd`.
 */
export function formatStallReport(
  snap: RegistrySnapshot,
  now: number,
  pid: number,
  watchdogArmed: boolean,
): string[] {
  const P = "[loop-watchdog]";
  const lines = [
    `${P} ${iso(now)} event loop stalled ${secs(now - snap.lastBeat)} — last heartbeat ${iso(snap.lastBeat)}, pid ${pid}`,
    `${P}   in flight (oldest first):${snap.inFlight.length === 0 ? " none" : ""}`,
  ];
  for (const op of snap.inFlight) {
    lines.push(`${P}     ${iso(op.start)}  running ${secs(now - op.start)}  ${op.label}`);
  }
  lines.push(`${P}   recently finished (newest last):${snap.recent.length === 0 ? " none" : ""}`);
  for (const op of snap.recent) {
    lines.push(`${P}     ${iso(op.start)}  took ${op.end! - op.start}ms  ${op.label}`);
  }
  if (snap.dropped > 0) lines.push(`${P}   untracked (registry full): ${snap.dropped}`);
  lines.push(
    watchdogArmed
      ? `${P}   systemd watchdog pings withheld — systemd restarts the service if the loop stays frozen`
      : `${P}   no systemd watchdog armed — nothing will restart this process automatically`,
  );
  return lines;
}
