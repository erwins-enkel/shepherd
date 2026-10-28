import type { HeavySlotSnapshot } from "#lib/types.js";

/** The master switch is the only gate: with it off there is no chip, strip or popover. */
export function slotEnabled(s: HeavySlotSnapshot | null | undefined): s is HeavySlotSnapshot {
  return s?.enabled === true;
}

/** Something is going on worth a strip: a holder, a waiter, or the brake holding starts back. */
export function slotActive(s: HeavySlotSnapshot | null | undefined): boolean {
  return slotEnabled(s) && (s.holders.length > 0 || s.waiters.length > 0 || s.brake.active);
}

/** Used RAM as a whole percent, or null when the host didn't report it. */
export function ramUsedPct(s: HeavySlotSnapshot): number | null {
  const { ramAvailableBytes: free, ramTotalBytes: total } = s.pressure;
  if (free == null || total == null || total <= 0) return null;
  return Math.round(((total - free) / total) * 100);
}

/** Memory-PSI position as 0..1 of the scale ending at twice the brake threshold, plus the
 *  threshold's own position (always 0.5), for the popover's limit marker. */
export function memPressureBar(s: HeavySlotSnapshot): { fill: number; limit: number } | null {
  const { memFullAvg10: v, memBrakeThreshold: t } = s.pressure;
  if (v == null || t == null || t <= 0) return null;
  return { fill: Math.min(1, v / (t * 2)), limit: 0.5 };
}

export interface ChipModel {
  held: number;
  capacity: number;
  waiting: number;
  ramPct: number | null;
  braking: boolean;
}

export function chipModel(s: HeavySlotSnapshot): ChipModel {
  return {
    held: s.holders.length,
    capacity: s.capacity,
    waiting: s.waiters.length,
    ramPct: ramUsedPct(s),
    braking: s.brake.active,
  };
}

/** `m:ss` (or `h:mm:ss`) since `startedAt`; never negative. */
export function formatRuntime(startedAt: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const sec = String(total % 60).padStart(2, "0");
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}:${sec}`;
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}:${sec}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "–";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** Waiters in queue order. */
export function orderedWaiters(s: HeavySlotSnapshot): HeavySlotSnapshot["waiters"] {
  return [...s.waiters].sort((a, b) => a.position - b.position);
}
