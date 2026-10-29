import type { HeavySlotLastResult, HeavySlotSnapshot } from "#lib/types.js";

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

/** How often an open overview re-reads the snapshot while a result still counts as current. */
export const RESULT_REFRESH_MS = 15_000;

/** A result that is still current can go stale at any moment (the agent keeps editing, and no
 *  event announces it), so such a snapshot has to be re-read. Stale ones only change on a new run. */
export function needsResultRefresh(s: HeavySlotSnapshot | null | undefined): boolean {
  return slotEnabled(s) && s.lastResults.some((r) => !r.stale);
}

export type ResultView = "passed" | "failed" | "aborted" | "stale";

/** What a last result shows as. A pass whose revision no longer matches the worktree is "stale",
 *  never green; a failure stays red (an old failure is still the more useful signal). */
export function resultView(r: HeavySlotLastResult): ResultView {
  return r.result === "passed" && r.stale ? "stale" : r.result;
}

/** The 7-character commit the job ran on, or a dash when it is unknown. */
export function shortRevision(r: HeavySlotLastResult): string {
  return r.head ? r.head.slice(0, 7) : "–";
}

/** How many last results the overview lists before "show all". */
const RESULTS_SHOWN = 5;

/** Last results newest first (unknown end last), cut to `RESULTS_SHOWN` unless `all`. */
export function recentResults(
  s: HeavySlotSnapshot,
  all: boolean,
): { rows: HeavySlotLastResult[]; hidden: number } {
  const sorted = [...s.lastResults].sort((a, b) => (b.endedAt ?? -1) - (a.endedAt ?? -1));
  const rows = all ? sorted : sorted.slice(0, RESULTS_SHOWN);
  return { rows, hidden: sorted.length - rows.length };
}
