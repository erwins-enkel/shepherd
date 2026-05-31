import type { UsageLimits, LimitWindow } from "../types";

export type GaugeKey = "5H" | "WK";

export interface Gauge {
  label: GaugeKey;
  w: LimitWindow;
}

/** Present usage windows in display order (5H before WK). */
export function gaugeList(limits: UsageLimits | null): Gauge[] {
  if (!limits) return [];
  const out: Gauge[] = [];
  if (limits.session5h) out.push({ label: "5H", w: limits.session5h });
  if (limits.week) out.push({ label: "WK", w: limits.week });
  return out;
}

/**
 * The window closest to its cap — what touch layouts collapse to.
 * Ties break toward WK: a near-exhausted weekly cap is worse to recover from.
 */
export function hotterGauge(limits: UsageLimits | null): Gauge | null {
  const gauges = gaugeList(limits);
  if (!gauges.length) return null;
  return gauges.reduce((hot, g) => (g.w.pct >= hot.w.pct ? g : hot));
}
