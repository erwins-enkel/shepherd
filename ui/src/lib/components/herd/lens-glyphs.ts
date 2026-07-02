import type { HerdFilter } from "$lib/components/herd-partition";

/** Canonical glyph per herd lens — the SINGLE source shared by the HerdLensStrip
 *  (the rail's lens switcher) and the CommandBar's lens rows, so the two icon sets
 *  can't drift. The labels are already shared via the `herd_seg_*` message keys; this
 *  covers the remaining duplicated dimension (the glyphs). Covers all six HerdFilter
 *  values; CommandBar surfaces the five navigable lenses (it omits `all`). */
export const lensGlyph: Record<HerdFilter, string> = {
  all: "▦",
  next: "↑",
  ready: "▤",
  done: "✓",
  rundown: "☰",
  owed: "☑",
};
