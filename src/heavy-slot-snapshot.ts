// Read model of the host-wide heavy-check slot (#3181) as the overview renders it. Only the shape
// and a "switched off" default live here; whatever enforces the slot supplies the real snapshot.

export interface HeavySlotHolder {
  sessionId: string;
  /** What is running, e.g. `vitest run`. */
  command: string;
  startedAt: number;
  /** Summed RSS of the holder's process tree (an upper bound — shared pages count repeatedly). */
  rssBytes: number | null;
}

export interface HeavySlotWaiter {
  sessionId: string;
  /** 1-based place in the queue. */
  position: number;
  reason: "slot" | "pressure";
}

export interface HeavySlotPressure {
  ramAvailableBytes: number | null;
  ramTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  /** Memory PSI `full` avg10, percent. */
  memFullAvg10: number | null;
  /** The brake's threshold for `memFullAvg10`, percent. */
  memBrakeThreshold: number | null;
  /** CPU PSI `some` avg10, percent. */
  cpuSomeAvg10: number | null;
}

export interface HeavySlotMemoryBySource {
  agentsBytes: number | null;
  foreignBytes: number | null;
  foreignTop: Array<{ name: string; bytes: number }>;
}

export interface HeavySlotSnapshot {
  /** Master switch. Off → the overview shows no chip and no strip. */
  enabled: boolean;
  capacity: number;
  holders: HeavySlotHolder[];
  waiters: HeavySlotWaiter[];
  brake: { active: boolean; reason: "memory" | null };
  pressure: HeavySlotPressure;
  memoryBySource: HeavySlotMemoryBySource;
}

/** What the slot owner exposes to the server. */
export interface HeavySlotSource {
  snapshot(): HeavySlotSnapshot;
  /** Manually free a holder's slot; false when that session holds none. */
  release(sessionId: string): boolean;
}

export const DISABLED_HEAVY_SLOT: HeavySlotSnapshot = {
  enabled: false,
  capacity: 0,
  holders: [],
  waiters: [],
  brake: { active: false, reason: null },
  pressure: {
    ramAvailableBytes: null,
    ramTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    memFullAvg10: null,
    memBrakeThreshold: null,
    cpuSomeAvg10: null,
  },
  memoryBySource: { agentsBytes: null, foreignBytes: null, foreignTop: [] },
};

/** Most holders / waiters / foreign processes taken from a connected machine's snapshot. */
const REMOTE_LIST_MAX = 64;
const REMOTE_TEXT_MAX = 256;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const orNull = (v: unknown): number | null => (finite(v) ? v : null);
const rec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null =>
  typeof v === "string" ? v.slice(0, REMOTE_TEXT_MAX) : null;

/**
 * A connected machine's `GET /api/heavy-slot` body, validated field by field — it comes from
 * another host. Null when it isn't a snapshot at all (an older Shepherd answers 404 instead).
 */
export function parseHeavySlotSnapshot(raw: unknown): HeavySlotSnapshot | null {
  if (!rec(raw) || typeof raw.enabled !== "boolean" || !finite(raw.capacity)) return null;
  if (!Array.isArray(raw.holders) || !Array.isArray(raw.waiters)) return null;
  const holders: HeavySlotHolder[] = [];
  for (const h of raw.holders.slice(0, REMOTE_LIST_MAX)) {
    const sessionId = rec(h) ? text(h.sessionId) : null;
    const command = rec(h) ? text(h.command) : null;
    if (!rec(h) || sessionId === null || command === null || !finite(h.startedAt)) continue;
    holders.push({ sessionId, command, startedAt: h.startedAt, rssBytes: orNull(h.rssBytes) });
  }
  const waiters: HeavySlotWaiter[] = [];
  for (const w of raw.waiters.slice(0, REMOTE_LIST_MAX)) {
    const sessionId = rec(w) ? text(w.sessionId) : null;
    if (!rec(w) || sessionId === null || !finite(w.position)) continue;
    waiters.push({
      sessionId,
      position: w.position,
      reason: w.reason === "pressure" ? "pressure" : "slot",
    });
  }
  const brake = rec(raw.brake) ? raw.brake : {};
  const p = rec(raw.pressure) ? raw.pressure : {};
  const src = rec(raw.memoryBySource) ? raw.memoryBySource : {};
  const foreignTop: Array<{ name: string; bytes: number }> = [];
  if (Array.isArray(src.foreignTop)) {
    for (const f of src.foreignTop.slice(0, REMOTE_LIST_MAX)) {
      const name = rec(f) ? text(f.name) : null;
      if (rec(f) && name !== null && finite(f.bytes)) foreignTop.push({ name, bytes: f.bytes });
    }
  }
  return {
    enabled: raw.enabled,
    capacity: raw.capacity,
    holders,
    waiters,
    brake: { active: brake.active === true, reason: brake.reason === "memory" ? "memory" : null },
    pressure: {
      ramAvailableBytes: orNull(p.ramAvailableBytes),
      ramTotalBytes: orNull(p.ramTotalBytes),
      swapUsedBytes: orNull(p.swapUsedBytes),
      swapTotalBytes: orNull(p.swapTotalBytes),
      memFullAvg10: orNull(p.memFullAvg10),
      memBrakeThreshold: orNull(p.memBrakeThreshold),
      cpuSomeAvg10: orNull(p.cpuSomeAvg10),
    },
    memoryBySource: {
      agentsBytes: orNull(src.agentsBytes),
      foreignBytes: orNull(src.foreignBytes),
      foreignTop,
    },
  };
}
