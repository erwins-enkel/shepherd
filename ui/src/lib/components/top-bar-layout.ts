// Pure responsive-layout helpers for the top bar's right-side cluster.
//
// "touch-desktop" = a coarse-pointer device wider than 768px (an unfolded foldable, a
// tablet). It is NOT a fixed ~1000px layout — its width varies as widely as desktop —
// so right-cluster compaction for both desktop AND touch-desktop is decided by RUNTIME
// MEASUREMENT in TopBar.svelte (measureFull + decideFromCache), which this pure layer
// can't do (it has no pixel widths). Mobile WRAPS instead, via the component's `mobile`
// flag. This module therefore only derives the layout mode and the content-change signals
// the measure-effect tracks (badge count, usage-text width key). A second measured tier folds the
// attention badges into the gear menu when even the icon-only bar overflows (narrow fold).

import { m } from "#lib/paraglide/messages.js";
import { formatTokenLabel } from "#lib/format.js";
import type { CompactUsageView, Gauge } from "./usage-gauges";

export type Mode = "mobile" | "touch-desktop" | "desktop";

/** The already-computed badge-presence inputs the bar counts for crowding.
 * The halt e-stop is NOT among them — it lives in the always-present gear menu,
 * never in the right-side cluster, so `working` doesn't affect bar crowding. */
export interface ChromeState {
  updateAvailable: boolean;
  herdrUpdateAvailable: boolean;
  codexUpdateAvailable: boolean;
  whatsNew: boolean;
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
    (s.codexUpdateAvailable ? 1 : 0) +
    (s.whatsNew ? 1 : 0) +
    (s.held > 0 ? 1 : 0)
  );
}

/** The inline value text of one usage gauge: `85%`, or `85% before reset` once an observed
 *  window's reset has passed without a fresh scrape. */
export function gaugeValueText(gauge: Gauge, nowMs: number): string {
  return "scrapedAt" in gauge.w && gauge.w.resetAt <= nowMs
    ? m.topbar_usage_before_reset({ pct: gauge.w.pct })
    : `${gauge.w.pct}%`;
}

/** Width signal for the inline usage value text, for the measure effect. That text's width
 *  varies (9%→10%, the before-reset flip, a longer credit amount or token label) without the
 *  view's layout signature or width class changing, and the shell-capped bar's
 *  ResizeObserver doesn't fire on inner growth. The bar font is monospace, so the lengths
 *  stand in for widths: same-width ticks (85%→86%) yield the same key and don't re-measure. */
export function usageTextWidthKey(
  view: CompactUsageView | null,
  creditAmount: string,
  nowMs: number,
): string {
  if (!view) return "";
  const texts =
    view.mode === "limits"
      ? view.gauges.map((g) => gaugeValueText(g, nowMs))
      : view.mode === "credit"
        ? [creditAmount]
        : view.mode === "tokens"
          ? [view.totalTokens !== null ? formatTokenLabel(view.totalTokens) : "—"]
          : view.mode === "model"
            ? [`${view.model.pct}%`]
            : [];
  return texts.map((t) => t.length).join("|");
}
