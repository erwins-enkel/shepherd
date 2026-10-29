// Browser-safe default shared by the server and demo; no telemetry or revision I/O.
export const DISABLED_HEAVY_SLOT = {
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
  lastResults: [],
};
