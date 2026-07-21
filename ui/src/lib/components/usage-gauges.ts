import type {
  UsageLimits,
  LimitWindow,
  ModelWeekWindow,
  UsageProviderSnapshot,
  CreditWindow,
} from "../types";
import type { AgentProvider } from "../types";

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

type CodexTokenSnapshot = Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }>;

export type CompactUsageView =
  | {
      provider: "claude";
      mode: "limits";
      gauges: Gauge[];
      stale: boolean;
      rotationEligible: boolean;
      widthClass: "bars";
    }
  | {
      provider: "claude";
      mode: "credit";
      stale: boolean;
      rotationEligible: boolean;
      widthClass: "credit";
    }
  | {
      provider: "claude";
      mode: "model";
      model: ModelWeekWindow;
      stale: boolean;
      rotationEligible: boolean;
      widthClass: "model";
    }
  | {
      provider: "codex";
      mode: "limits";
      gauges: Gauge[];
      stale: boolean;
      rotationEligible: boolean;
      widthClass: "bars";
    }
  | {
      provider: "codex";
      mode: "tokens";
      totalTokens: number;
      stale: boolean;
      rotationEligible: boolean;
      widthClass: "token";
    };

/** Codex's 5H/WK rate-limit windows as gauges, in display order — the same shape `gaugeList`
 *  produces for Claude so both render identically. Empty until Codex logs a rate-limit event. */
export function codexGaugeList(usage: CodexTokenSnapshot | null): Gauge[] {
  if (!usage) return [];
  const out: Gauge[] = [];
  if (usage.session5h) out.push({ label: "5H", w: usage.session5h });
  if (usage.week) out.push({ label: "WK", w: usage.week });
  return out;
}

export function providerSnapshots(limits: UsageLimits | null): UsageProviderSnapshot[] {
  if (!limits) return [];
  if (limits.providers?.length) return limits.providers;
  return [
    {
      provider: "claude",
      kind: "limits",
      session5h: limits.session5h,
      week: limits.week,
      perModelWeek: limits.perModelWeek ?? [],
      credits: limits.credits,
      stale: limits.stale,
      calibratedAt: limits.calibratedAt,
      subscriptionOnly: limits.subscriptionOnly,
    },
  ];
}

/**
 * Per-model weekly passthrough sub-limits (e.g. "Current week (Fable)") for display as their own
 * bars. Deliberately SEPARATE from `gaugeList`/`hotterGauge` — these are passthroughs with a
 * nullable resetAt and their own staleness, and must never become the compact layout's "hottest"
 * gauge.
 */
export function modelWeekList(limits: UsageLimits | null): ModelWeekWindow[] {
  return limits?.perModelWeek ?? [];
}

/** Proper-noun display name for a model slug (e.g. "fable" → "Fable"). Not translated. */
export function modelDisplayName(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function codexTokenUsage(
  limits: UsageLimits | null,
): Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null {
  return (
    providerSnapshots(limits).find(
      (p): p is Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> =>
        p.provider === "codex" && p.kind === "tokens",
    ) ?? null
  );
}

export function compactUsageViews({
  gauges,
  claudeStale,
  perModel,
  credits,
  codexUsage,
}: {
  gauges: Gauge[];
  claudeStale: boolean;
  perModel: ModelWeekWindow[];
  credits: CreditWindow | null;
  codexUsage: CodexTokenSnapshot | null;
}): CompactUsageView[] {
  const views: CompactUsageView[] = [];
  const capped = gauges.some((g) => g.w.pct >= 100);
  const showCreditsInline = (capped || gauges.length === 0) && !!credits;

  if (showCreditsInline) {
    views.push({
      provider: "claude",
      mode: "credit",
      stale: credits.stale,
      rotationEligible: true,
      widthClass: "credit",
    });
  } else if (gauges.length) {
    views.push({
      provider: "claude",
      mode: "limits",
      gauges,
      stale: claudeStale,
      rotationEligible: true,
      widthClass: "bars",
    });
  } else if (perModel.length) {
    views.push({
      provider: "claude",
      mode: "model",
      model: perModel[0]!,
      stale: perModel[0]!.stale,
      rotationEligible: true,
      widthClass: "model",
    });
  }

  if (codexUsage) {
    const codexGauges = codexGaugeList(codexUsage);
    if (codexGauges.length) {
      views.push({
        provider: "codex",
        mode: "limits",
        gauges: codexGauges,
        stale: codexUsage.stale,
        rotationEligible: true,
        widthClass: "bars",
      });
    } else {
      views.push({
        provider: "codex",
        mode: "tokens",
        totalTokens: codexUsage.totalTokens,
        stale: codexUsage.stale,
        rotationEligible: true,
        widthClass: "token",
      });
    }
  }

  return views;
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

/** Usage-gauge fill/text color. Three-step ladder: muted through 50, amber as the window
 *  warms above 50, red once it runs critically hot (>90). Red here is a deliberate,
 *  documented exception to the Four-Light Rule (DESIGN.md / DESIGN.json) — usage telemetry
 *  near cap is an operator-attention signal, but it stays a bar-fill/text hue only (no halo,
 *  no status pip) so a blocked agent's red pip remains the loudest red on screen. */
export function gaugeColor(pct: number): string {
  if (pct > 90) return "var(--color-red)";
  if (pct > 50) return "var(--color-amber)";
  return "var(--color-muted)";
}

/** True when paid extra-credit spend is actually happening on a fresh snapshot — the signal that
 *  drives the elevated alert. Keyed off `spent` (pct rounds to 0 while money is already spent) and
 *  gated on freshness so a stale snapshot never raises a false alarm. */
export function overspending(limits: UsageLimits | null): boolean {
  const c = limits?.credits;
  return !!c && !c.stale && c.spent > 0;
}

/** One usage window's remaining room, labelled by which window it is (5H vs WK) so the gauge
 *  is never ambiguous about which limit a bar reflects. */
export interface ProviderCapacityWindow {
  key: GaugeKey; // "5H" | "WK"
  usedPct: number; // capped 0..100 — drives the bar color
  remainingPct: number; // 100 − usedPct — the "% free"
  resetAt: number; // raw reset timestamp; consumers decide whether it is usable
}

export interface ProviderCapacityRow {
  provider: AgentProvider;
  /** Per-window rooms in display order (5H before WK). Empty when the provider has no window data. */
  windows: ProviderCapacityWindow[];
  available: boolean;
  stale: boolean;
}

function capPct(v: number): number {
  return Math.min(Math.max(v, 0), 100);
}

function capacityWindows(gauges: Gauge[]): ProviderCapacityWindow[] {
  return gauges.map((g) => {
    const usedPct = capPct(g.w.pct);
    return {
      key: g.label,
      usedPct,
      remainingPct: Math.max(0, 100 - usedPct),
      resetAt: g.w.resetAt,
    };
  });
}

/** The New Task compact capacity line: the selected provider's hottest window (lowest
 *  remaining %) with its designation code (untranslated, like TASK-07). `stale` mirrors the
 *  row (rendered dimmed, matching ProviderCapacityGauge); `null` = provider unavailable
 *  (line hidden). Layered on providerCapacityRows so the two never disagree. */
export interface SelectedProviderCapacity {
  code: string; // "CC·5H" | "CC·WK" | "CX·5H" | "CX·WK"
  freePct: number;
  usedPct: number;
  stale: boolean;
}

export function selectedProviderCapacity(
  limits: UsageLimits | null,
  provider: AgentProvider,
): SelectedProviderCapacity | null {
  const row = providerCapacityRows(limits).find((r) => r.provider === provider);
  if (!row?.available || row.windows.length === 0) return null;
  const hottest = row.windows.reduce((hot, w) => (w.remainingPct < hot.remainingPct ? w : hot));
  return {
    code: `${provider === "claude" ? "CC" : "CX"}·${hottest.key}`,
    freePct: hottest.remainingPct,
    usedPct: hottest.usedPct,
    stale: row.stale,
  };
}

export function providerCapacityRows(limits: UsageLimits | null): ProviderCapacityRow[] {
  const codexUsage = codexTokenUsage(limits);
  const claudeWindows = capacityWindows(gaugeList(limits));
  const codexWindows = capacityWindows(codexGaugeList(codexUsage));

  return [
    {
      provider: "claude",
      windows: claudeWindows,
      available: claudeWindows.length > 0,
      stale: limits?.stale ?? false,
    },
    {
      provider: "codex",
      windows: codexWindows,
      available: codexWindows.length > 0,
      stale: codexUsage?.stale ?? false,
    },
  ];
}
