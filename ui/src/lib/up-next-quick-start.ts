import { m } from "#lib/paraglide/messages.js";
import { configuredModelLabel } from "#lib/model-label.js";
import { effortLabel } from "#lib/effort-guidance.js";
import { providerLabel } from "#lib/reviewer-env.js";
import { formatReset, formatResetIn } from "#lib/format.js";
import { providerDisplayCapacityRows } from "#lib/components/usage-gauges.js";
import { readyAgentProviders } from "#lib/provider-capacity.js";
import type { TooltipExplanation } from "#lib/tooltips/content.js";
import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type DiagnosticsSnapshot,
  type UpNextQuickStart,
  type UpNextQuickStarts,
  type UsageLimits,
} from "#lib/types.js";

/** ready: starts at once · hold: Claude is over the hold threshold, the server starts the
 *  session held · blocked: the CLI isn't ready, the chip is inert. */
export type QuickStartState = "ready" | "hold" | "blocked";

export interface QuickStartChip {
  provider: AgentProvider;
  preset: UpNextQuickStart;
  state: QuickStartState;
  /** The CLI's 5h window, used %, for the chip's bar; null without usage data. */
  usedPct: number | null;
  /** Claude only, in `hold`: when the window over the threshold resets; null when unknown. */
  holdUntil: number | null;
}

/** One chip per CLI whose preset is switched on (a CLI without a preset gets none), in
 *  provider order. Blocked ones stay, so the operator sees why the shortcut isn't usable. */
export function quickStartChips(opts: {
  quickStarts: UpNextQuickStarts;
  diagnostics: DiagnosticsSnapshot | null;
  limits: UsageLimits | null;
  holdLikely: boolean;
  holdPct: number;
  nowMs: number;
}): QuickStartChip[] {
  const ready = readyAgentProviders(opts.diagnostics);
  const rows = providerDisplayCapacityRows(opts.limits);
  const chips: QuickStartChip[] = [];
  for (const provider of AGENT_PROVIDERS) {
    const preset = opts.quickStarts[provider];
    if (!preset?.enabled) continue;
    const state: QuickStartState = !ready.includes(provider)
      ? "blocked"
      : provider === "claude" && opts.holdLikely
        ? "hold"
        : "ready";
    const fiveH = rows.find((r) => r.provider === provider)?.windows.find((w) => w.key === "5H");
    chips.push({
      provider,
      preset,
      state,
      usedPct: fiveH?.usedPct ?? null,
      holdUntil: state === "hold" ? holdReset(opts.limits, opts.holdPct, opts.nowMs) : null,
    });
  }
  return chips;
}

/** The latest reset among the Claude windows at or over the threshold — the hold lifts once
 *  every one of them has reset. */
function holdReset(limits: UsageLimits | null, holdPct: number, nowMs: number): number | null {
  const resets = [limits?.session5h, limits?.week]
    .filter((w) => w && w.pct >= holdPct && w.resetAt > nowMs)
    .map((w) => w!.resetAt);
  return resets.length > 0 ? Math.max(...resets) : null;
}

export const quickStartModelText = (c: QuickStartChip): string =>
  c.preset.model ? configuredModelLabel(c.preset.model) : m.newtask_model_default();
export const quickStartEffortText = (c: QuickStartChip): string =>
  c.preset.effort ? effortLabel(c.preset.effort) : m.effort_default();

export const quickStartAria = (c: QuickStartChip): string =>
  m.upnext_quickstart_aria({
    cli: providerLabel(c.provider),
    model: quickStartModelText(c),
    effort: quickStartEffortText(c),
  });

/** "holds until HH:MM", or the plain "held" when the reset isn't known. */
export const quickStartHoldText = (c: QuickStartChip, nowMs: number): string =>
  c.holdUntil === null
    ? m.upnext_quickstart_hold_nodate()
    : m.upnext_quickstart_hold({ time: formatReset(c.holdUntil, nowMs, { withTime: true }) });

/** The hover explanation: what the click does, the preset, the CLI's capacity, how to change it. */
export function quickStartTip(
  c: QuickStartChip,
  number: number,
  limits: UsageLimits | null,
  nowMs: number,
): TooltipExplanation {
  const cli = providerLabel(c.provider);
  const windows =
    providerDisplayCapacityRows(limits).find((r) => r.provider === c.provider)?.windows ?? [];
  const rows = windows.map((w) => ({
    text: m.upnext_quickstart_tip_window({ window: w.key, pct: Math.round(w.usedPct) }),
    aside:
      w.resetAt > nowMs
        ? m.upnext_quickstart_tip_window_reset({
            in: formatResetIn(w.resetAt, nowMs),
            at: formatReset(w.resetAt, nowMs, { withTime: true }),
          })
        : undefined,
    tone: w.usedPct > 90 ? ("fail" as const) : w.usedPct > 50 ? ("warn" as const) : ("ok" as const),
  }));
  const note =
    c.state === "blocked"
      ? m.upnext_quickstart_tip_blocked({ cli })
      : c.state === "hold"
        ? c.holdUntil === null
          ? m.upnext_quickstart_tip_hold_nodate()
          : m.upnext_quickstart_tip_hold({
              time: formatReset(c.holdUntil, nowMs, { withTime: true }),
            })
        : undefined;
  return {
    title: m.upnext_quickstart_tip_title({ cli }),
    summary: m.upnext_quickstart_tip_summary({ number }),
    sections: [
      { label: m.upnext_quickstart_tip_model(), text: quickStartModelText(c) },
      { label: m.upnext_quickstart_tip_effort(), text: quickStartEffortText(c) },
      {
        label: m.upnext_quickstart_tip_capacity(),
        text: rows.length === 0 ? m.upnext_quickstart_tip_no_usage() : "",
        rows,
        note,
      },
      { label: m.upnext_quickstart_tip_change(), text: m.upnext_quickstart_tip_change_body() },
    ],
  };
}
