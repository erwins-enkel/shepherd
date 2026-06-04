// Pure responsive-layout decisions for the top bar's right-side cluster.
// Extracted from TopBar.svelte so the #247/#322 collapse rules are unit-testable.
// "touch-desktop" = an unfolded foldable (touch + desktop layout, ~1000px,
// narrower than a real desktop) — the crunch the badges overflowed on.
//
// Scope: this pure layer only models the FIXED-WIDTH modes — touch-desktop
// (count-based, #322) and mobile. DESKTOP compaction is NOT modeled here: real
// desktop width varies (a ~1366px laptop gives the bar far less than the ~1436px
// .shell cap), so a fixed count can't be correct across all desktop widths. It's
// decided by RUNTIME MEASUREMENT in TopBar.svelte (measureFull + decideFromCache),
// which the pure layer can't do — it has no pixel widths. So for desktop this
// function returns both flags false; the component ORs in the measured result.

export type Mode = "mobile" | "touch-desktop" | "desktop";

/** The five already-computed badge-presence inputs the bar counts for crowding.
 * The halt e-stop is NOT among them — it lives in the always-present gear menu,
 * never in the right-side cluster, so `working` doesn't affect bar crowding. */
export interface ChromeState {
  updateAvailable: boolean;
  herdrUpdateAvailable: boolean;
  learnings: number;
  overBudget: number;
  needsYou: number;
  whatsNew: boolean;
}

export interface TopBarPlan {
  /** drop the numeric clock-time (keep the connection dot) */
  hideClockTime: boolean;
  /** collapse labelled badges to their compact icon/dot form */
  compactBadges: boolean;
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
    (s.learnings > 0 || s.overBudget > 0 ? 1 : 0) +
    (s.needsYou > 0 ? 1 : 0) +
    (s.whatsNew ? 1 : 0)
  );
}

/**
 * The fixed-width right-cluster render plan for a given mode + state.
 *
 * Only touch-desktop is crunched here (count-based, #322). DESKTOP compaction is
 * measurement-driven in TopBar.svelte (measureFull/decideFromCache OR the measured
 * flag into compactBadges/hideClockTime), since this pure layer can't see the bar's
 * actual pixel width — desktop therefore returns both flags false. Mobile collapses
 * via the component's `mobile` flag, not these flags.
 */
export function topBarPlan(mode: Mode, s: ChromeState): TopBarPlan {
  const count = badgeCount(s);
  const touchDesktop = mode === "touch-desktop";
  return {
    // Any badge crowds touch-desktop, so the numeric clock is sacrificed first.
    hideClockTime: touchDesktop && count > 0,
    // Two+ badges won't fit even after the clock drops — collapse labels.
    compactBadges: touchDesktop && count >= 2,
  };
}
