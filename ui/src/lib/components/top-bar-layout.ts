// Pure responsive-layout helpers for the top bar's right-side cluster.
//
// "touch-desktop" = a coarse-pointer device wider than 768px (an unfolded foldable, a
// tablet). It is NOT a fixed ~1000px layout — its width varies as widely as desktop —
// so right-cluster compaction for both desktop AND touch-desktop is decided by RUNTIME
// MEASUREMENT in TopBar.svelte (measureFull + decideFromCache), which this pure layer
// can't do (it has no pixel widths). Mobile WRAPS instead, via the component's `mobile`
// flag. This module therefore only derives the layout mode and the badge count the
// measure-effect tracks as a content-change signal.

export type Mode = "mobile" | "touch-desktop" | "desktop";

/** The already-computed badge-presence inputs the bar counts for crowding.
 * The halt e-stop is NOT among them — it lives in the always-present gear menu,
 * never in the right-side cluster, so `working` doesn't affect bar crowding. */
export interface ChromeState {
  updateAvailable: boolean;
  herdrUpdateAvailable: boolean;
  needsYou: number;
  whatsNew: boolean;
  /** pending learnings to review across all repos; >0 renders the global learnings badge */
  learnings: number;
  /** held tasks; >0 renders the held badge (added async via the held:changed WS event,
   *  so it MUST be a counted input or the measure effect won't re-fire on its arrival) */
  held: number;
}

/** Derive the layout mode from the bar's mobile/touch flags. */
export function modeOf(mobile: boolean, touch: boolean): Mode {
  if (mobile) return "mobile";
  if (touch) return "touch-desktop";
  return "desktop";
}

/** How many right-side badges are present (each renders one button). */
export function badgeCount(s: ChromeState): number {
  return (
    (s.updateAvailable ? 1 : 0) +
    (s.herdrUpdateAvailable ? 1 : 0) +
    (s.needsYou > 0 ? 1 : 0) +
    (s.whatsNew ? 1 : 0) +
    (s.learnings > 0 ? 1 : 0) +
    (s.held > 0 ? 1 : 0)
  );
}
