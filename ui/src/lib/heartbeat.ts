/** Heat-strip bucketing for the per-agent activity row indicator. Pure + unit-tested. */

/** Number of cells in the strip. Fixed; CSS scales each cell's width. */
export const STRIP_CELLS = 24;

/** Rolling window the strip spans. Equals the server's 8-min stall threshold
 *  (src/stall.ts DEFAULT_STALL.stallMs), so a fully-drained strip coincides with
 *  the stall alarm. Kept as a literal because the UI does not import server code. */
export const STRIP_WINDOW_MS = 8 * 60_000;

const CELL_MS = STRIP_WINDOW_MS / STRIP_CELLS;

export interface StripCell {
  /** Intensity 0 (empty track) … 4 (busiest), from the event count in this slice. */
  level: number;
  /** A tool-use in this slice errored — render red. */
  error: boolean;
  /** This slice holds the single newest event — render brightest. */
  now: boolean;
}

/** Map an event count in one slice to an intensity level (0–4). */
function levelFor(count: number): number {
  if (count <= 0) return 0;
  if (count >= 4) return 4;
  return count;
}

/**
 * Bucket in-window tool-use timestamps into a fixed STRIP_CELLS-long strip,
 * oldest slice first, newest (now) slice last. `nowMs` anchors the window so the
 * strip ages/drains live between server pushes. Zero/out-of-window/future ts are
 * ignored.
 */
export function bucketStrip(recentTs: number[], recentErrTs: number[], nowMs: number): StripCell[] {
  const counts = new Array<number>(STRIP_CELLS).fill(0);
  const errs = new Array<boolean>(STRIP_CELLS).fill(false);
  const errSet = new Set(recentErrTs);
  let newestTs = -1;
  let newestIdx = -1;

  for (const ts of recentTs) {
    if (ts <= 0) continue;
    const age = nowMs - ts;
    if (age < 0 || age >= STRIP_WINDOW_MS) continue;
    const idx = STRIP_CELLS - 1 - Math.floor(age / CELL_MS);
    if (idx < 0 || idx >= STRIP_CELLS) continue;
    counts[idx] = (counts[idx] ?? 0) + 1;
    if (errSet.has(ts)) errs[idx] = true;
    if (ts > newestTs) {
      newestTs = ts;
      newestIdx = idx;
    }
  }

  return counts.map((c, i) => ({
    level: levelFor(c),
    error: errs[i] ?? false,
    now: i === newestIdx,
  }));
}
