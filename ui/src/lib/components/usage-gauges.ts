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

/** Usage-gauge fill/text color. Three-step ladder: muted at rest, amber as the window
 *  warms (75–90), red once it runs critically hot (>90). Red here is a deliberate,
 *  documented exception to the Four-Light Rule (DESIGN.md / DESIGN.json) — usage telemetry
 *  near cap is an operator-attention signal, but it stays a bar-fill/text hue only (no halo,
 *  no status pip) so a blocked agent's red pip remains the loudest red on screen. */
export function gaugeColor(pct: number): string {
  if (pct > 90) return "var(--color-red)";
  if (pct >= 75) return "var(--color-amber)";
  return "var(--color-muted)";
}

/** True when paid extra-credit spend is actually happening on a fresh snapshot — the signal that
 *  drives the elevated alert. Keyed off `spent` (pct rounds to 0 while money is already spent) and
 *  gated on freshness so a stale snapshot never raises a false alarm. */
export function overspending(limits: UsageLimits | null): boolean {
  const c = limits?.credits;
  return !!c && !c.stale && c.spent > 0;
}
