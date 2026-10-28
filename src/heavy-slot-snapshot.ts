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
