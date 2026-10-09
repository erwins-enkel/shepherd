import { m } from "#lib/paraglide/messages.js";
import { elapsed } from "#lib/format.js";
import type {
  TooltipExplanation,
  TooltipRow,
  TooltipSection,
  TooltipSegmentTone,
  TooltipTimeline,
} from "#lib/tooltips/content.js";
import type {
  ChecksState,
  Epic,
  EpicChild,
  EpicChildForecast,
  EpicForecast,
  EpicForecastConfidence,
  EpicTiming,
} from "./types";

const MIN = 60_000;
/** A forecast this much later than the first one made after a merge reads as behind plan. */
const SLIP_MS = 15 * MIN;
/** A ready step projected to start later than this is waiting on an agent slot. */
const WAIT_MS = MIN;
/** Without an end to draw to, the strip places now at a quarter of its width. */
const OPEN_SPAN = 3;

/** One segment of the EPIC badge's meter, per child in epic order. */
export type EpicMeterTone = "merged" | "running" | "rest";

export const byEpicOrder = (a: EpicChild, b: EpicChild) => a.order - b.order || a.number - b.number;
/** In flight, as the forecast counts it: the step holds its place until it merges. */
export const inFlight = (c: EpicChild) => c.state === "running" || c.state === "in-review";

export function epicMeter(children: readonly EpicChild[]): EpicMeterTone[] {
  return [...children]
    .sort(byEpicOrder)
    .map((c) => (c.state === "merged" ? "merged" : inFlight(c) ? "running" : "rest"));
}

/** A child's title without a redundant parent prefix ("Stack-Angleichung (#158): …"): the
 *  segment before the first ": " goes only when it names the parent's number. */
export function stepTitle(title: string, parent: number): string {
  const colon = title.indexOf(": ");
  if (colon < 0) return title;
  return new RegExp(`#${parent}(?!\\d)`).test(title.slice(0, colon))
    ? title.slice(colon + 2)
    : title;
}

/** A measured duration, floored to the minute: "8 min", "2 h", "2 h 22 min", "1 d 4 h". */
export function dur(ms: number): string {
  const min = Math.max(0, Math.floor(ms / MIN));
  if (min < 60) return m.epic_tip_dur_min({ m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? m.epic_tip_dur_h_min({ h, m: min % 60 }) : m.epic_tip_dur_h({ h });
  return m.epic_tip_dur_d_h({ d: Math.floor(h / 24), h: h % 24 });
}

/** A projected duration: to 5 min from an hour on, else to the minute, never below a minute. */
export function approx(ms: number): string {
  const step = ms >= 60 * MIN ? 5 * MIN : MIN;
  return dur(Math.max(MIN, Math.round(ms / step) * step));
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}
/** The time alone on today's date, else with the date. */
export const at = (ts: number, now: number) => (sameDay(ts, now) ? clock(ts) : dateTime(ts));
/** A forecast instant is no more precise than 5 min. */
const round5 = (ts: number) => Math.round(ts / (5 * MIN)) * 5 * MIN;
export const atApprox = (ts: number, now: number) => at(round5(ts), now);

function when(ts: number, now: number): string {
  const t = round5(ts);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(t, now)) return m.epic_tip_when_today({ time: clock(t) });
  if (sameDay(t, tomorrow.getTime())) return m.epic_tip_when_tomorrow({ time: clock(t) });
  return m.epic_tip_when_date({ date: dateTime(t) });
}

/** Where the epic clock stands: at its stop, at the landing's start, else it runs. */
const clockEnd = (t: EpicTiming, now: number) => t.pausedAt ?? t.landingStartedAt ?? now;
/** The epic clock: `(pausedAt ?? now) − startedAt − pausedMs`, ticking client-side. */
export function runMs(t: EpicTiming, now: number): number {
  return t.startedAt == null ? 0 : Math.max(0, clockEnd(t, now) - t.startedAt - t.pausedMs);
}

export type Phase = "plain" | "unstarted" | "running" | "paused" | "stopped" | "landing" | "landed";

export function phaseOf(epic: Epic): Phase {
  const t = epic.timing;
  if (!t) return "plain";
  if (t.landedAt != null) return "landed";
  if (t.landingStartedAt != null) return "landing";
  if (t.startedAt == null) return "unstarted";
  if (t.pausedAt != null) return epic.run.status === "paused" ? "paused" : "stopped";
  return "running";
}

const RUNG: Record<EpicForecastConfidence, number> = { "very-low": 0, low: 1, medium: 2, high: 3 };
const CONFIDENCE: Record<EpicForecastConfidence, () => string> = {
  "very-low": m.epic_tip_confidence_very_low,
  low: m.epic_tip_confidence_low,
  medium: m.epic_tip_confidence_medium,
  high: m.epic_tip_confidence_high,
};

/** The confidence rung 0–3 for a meter; an unknown rung counts as the lowest. */
export const confidenceRung = (f: EpicForecast) => RUNG[f.confidence] ?? 0;

/** The confidence word, marked when only the repo median backs it. */
export function confidenceWord(f: EpicForecast): string {
  // The contract's confidence enum is open: a rung this UI doesn't know shows as sent.
  const word = CONFIDENCE[f.confidence]?.() ?? f.confidence;
  return f.epicSamples === 0 ? m.epic_tip_confidence_repo_only({ word }) : word;
}

/** What the badge knows besides the epic. */
export interface EpicTipInput {
  epic: Epic;
  nowMs: number;
  /** The repo's agent slots (the drain's cap); null when unknown. */
  slots: number | null;
  /** The landing PR's checks while the epic lands; absent when unknown. */
  landingChecks?: ChecksState;
}

/** Everything the section builders read. */
interface Ctx {
  epic: Epic;
  children: EpicChild[];
  now: number;
  f: EpicForecast | null;
  fc: Map<number, EpicChildForecast>;
}

/**
 * The EPIC badge's hover panel: how long the epic has run as the title, where it stands and
 * when it lands as the summary, a timeline strip, then one idea per section — time, forecast,
 * steps — and the epic clock as the footer.
 */
export function epicTimingExplanation(input: EpicTipInput): TooltipExplanation {
  const { epic, nowMs: now } = input;
  const children = [...epic.children].sort(byEpicOrder);
  const f = epic.forecast ?? null;
  const ctx: Ctx = { epic, children, now, f, fc: new Map(f?.children.map((c) => [c.number, c])) };
  const merged = children.filter((c) => c.state === "merged").length;
  const counts = m.epic_tip_counts({ merged, total: children.length });
  const body = phaseBody(phaseOf(epic), ctx, input);
  return {
    title: body.title,
    summary: [counts, body.detail].filter(Boolean).join(" "),
    ...(body.timeline ? { timeline: body.timeline } : {}),
    sections: [...body.sections, stepsSection(ctx)],
    footer: footer(epic, now),
  };
}

/** The badge without a live epic: counts only. */
export function epicPlainExplanation(p: {
  number: number;
  merged: number;
  total: number;
}): TooltipExplanation {
  return {
    title: m.epic_tip_title_plain({ number: p.number }),
    summary: m.epic_tip_counts({ merged: p.merged, total: p.total }),
    sections: [],
    footer: [m.epic_tip_click()],
  };
}

interface Body {
  title: string;
  detail: string | null;
  timeline?: TooltipTimeline;
  sections: TooltipSection[];
}

function phaseBody(phase: Phase, ctx: Ctx, input: EpicTipInput): Body {
  const { epic, now } = ctx;
  const number = epic.parentIssueNumber;
  const t = epic.timing!;
  switch (phase) {
    case "plain":
      return { title: m.epic_tip_title_plain({ number }), detail: null, sections: [] };
    case "unstarted":
      return {
        title: m.epic_tip_title_unstarted({ number }),
        detail: m.epic_tip_summary_unstarted(),
        sections: [],
      };
    case "running":
      return {
        title: m.epic_tip_title_running({ number, dur: dur(runMs(t, now)) }),
        detail: runningDetail(ctx),
        timeline: runningStrip(ctx, t),
        sections: [timeSection(t), forecastSection(ctx, input.slots)],
      };
    case "paused":
    case "stopped":
      return {
        title: (phase === "paused" ? m.epic_tip_title_paused : m.epic_tip_title_stopped)({
          number,
          time: at(t.pausedAt!, now),
        }),
        detail: phase === "paused" ? m.epic_tip_summary_paused() : m.epic_tip_summary_stopped(),
        timeline: stoppedStrip(ctx, t),
        sections: [stoppedTimeSection(t, now), forecastSection(ctx, input.slots)],
      };
    case "landing":
      return {
        title: m.epic_tip_title_landing({ number }),
        detail: m.epic_tip_summary_landing(),
        timeline: landingStrip(ctx, t),
        sections: [landingSection(ctx, t, input.landingChecks)],
      };
    case "landed": {
      const started = t.startedAt ?? t.landingStartedAt ?? t.landedAt!;
      return {
        title: m.epic_tip_title_landed({
          number,
          dur: dur(t.landedAt! - started - t.pausedMs),
        }),
        detail: m.epic_tip_summary_landed({
          start: dateTime(started),
          end: at(t.landedAt!, now),
        }),
        timeline: landedStrip(ctx, t, started),
        sections: [totalsSection(t, started)],
      };
    }
  }
}

/** The summary's second sentence while running: when it lands, or why it can't say yet. */
function runningDetail(ctx: Ctx): string {
  const { f, now } = ctx;
  if (!f) return m.epic_tip_summary_no_data();
  const slip = slipMs(f);
  if (slip != null) {
    const step = f.children.find((c) => c.overrun);
    return step
      ? m.epic_tip_summary_slip_step({ step: `#${step.number}`, slip: approx(slip) })
      : m.epic_tip_summary_slip({ slip: approx(slip) });
  }
  if (f.epicSamples === 0) return m.epic_tip_summary_repo_only();
  return f.finishAt != null
    ? m.epic_tip_summary_on_pace({ when: when(f.finishAt, now) })
    : m.epic_tip_summary_no_data();
}

/** How far the finish moved past the first forecast after a merge; null when not behind. */
export function slipMs(f: EpicForecast): number | null {
  if (f.finishAt == null || f.firstFinishAt == null) return null;
  const slip = f.finishAt - f.firstFinishAt;
  return slip >= SLIP_MS ? slip : null;
}

function timeSection(t: EpicTiming): TooltipSection {
  return {
    label: m.epic_tip_section_time(),
    text: "",
    rows: [
      { text: m.epic_tip_started(), aside: dateTime(t.startedAt!) },
      { text: m.epic_tip_agents_active(), aside: dur(t.agentMs) },
      { text: m.epic_tip_waited(), aside: dur(t.idleMs) },
    ],
  };
}

function stoppedTimeSection(t: EpicTiming, now: number): TooltipSection {
  return {
    label: m.epic_tip_section_time(),
    text: "",
    rows: [
      { text: m.epic_tip_ran(), aside: dur(runMs(t, now)) },
      {
        text: m.epic_tip_paused(),
        aside: m.epic_tip_paused_value({ dur: dur(t.pausedMs + now - t.pausedAt!) }),
      },
      { text: m.epic_tip_agents_active(), aside: dur(t.agentMs) },
    ],
  };
}

function forecastSection(ctx: Ctx, slots: number | null): TooltipSection {
  const { f, now } = ctx;
  const label = m.epic_tip_section_forecast();
  if (!f)
    return {
      label,
      text: "",
      rows: [
        { text: m.epic_tip_remaining(), aside: m.epic_tip_no_forecast() },
        { text: m.epic_tip_first_estimate(), aside: m.epic_tip_after_first_merge() },
      ],
    };
  const confidence: TooltipRow = {
    text: m.epic_tip_confidence(),
    meter: { value: confidenceRung(f), max: 3 },
    aside: confidenceWord(f),
  };
  const note = basis(f, slots);
  if (f.finishAt == null)
    return {
      label,
      text: "",
      rows: [
        {
          text: m.epic_tip_remaining_from_resume(),
          aside: m.epic_tip_about({ dur: approx(f.remainingMsFromResume ?? 0) }),
        },
        confidence,
      ],
      note,
    };
  const remaining: TooltipRow = {
    text: m.epic_tip_remaining(),
    aside: m.epic_tip_about({ dur: approx(Math.max(0, f.finishAt - now)) }),
  };
  const slip = slipMs(f);
  const finish: TooltipRow =
    slip != null
      ? {
          text: m.epic_tip_done_around(),
          tone: "warn",
          aside: m.epic_tip_finish_slipped({
            at: atApprox(f.finishAt, now),
            was: atApprox(f.firstFinishAt!, now),
          }),
        }
      : {
          text: m.epic_tip_done_around(),
          aside: m.epic_tip_finish({ at: atApprox(f.finishAt, now) }),
        };
  // Its own row: beside the finish it would squeeze the label in a 12-hour locale.
  const range: TooltipRow = {
    text: m.epic_tip_range(),
    aside: m.epic_tip_range_value({
      low: atApprox(f.finishLow ?? f.finishAt, now),
      high: atApprox(f.finishHigh ?? f.finishAt, now),
    }),
  };
  const overruns = overrunRows(ctx);
  const rows =
    slip != null
      ? [finish, ...overruns, remaining, confidence]
      : [remaining, finish, range, ...overruns, confidence];
  return { label, text: "", rows, note };
}

/** Each step running far past its estimate, with how long it has run, then the usual step. */
function overrunRows(ctx: Ctx): TooltipRow[] {
  const { f, children, now, epic } = ctx;
  const over = children.filter((c) => ctx.fc.get(c.number)?.overrun);
  if (!f || over.length === 0) return [];
  return [
    ...over.map((c): TooltipRow => ({
      text: `#${c.number} ${stepTitle(c.title, epic.parentIssueNumber)}`,
      tone: "run",
      ...(c.startedAt != null ? { aside: dur(now - c.startedAt) } : {}),
    })),
    { text: m.epic_tip_usual_step(), aside: `~${approx(f.stepMs)}` },
  ];
}

/** What the forecast rests on: the step and landing estimates, the pace, the samples. */
function basis(f: EpicForecast, slots: number | null): string {
  const p = { step: approx(f.stepMs), landing: approx(f.landingMs) };
  const pace =
    slots == null
      ? m.epic_tip_basis(p)
      : slots <= 1
        ? m.epic_tip_basis_serial(p)
        : m.epic_tip_basis_parallel({ ...p, slots });
  const samples =
    f.epicSamples > 0
      ? (f.epicSamples === 1 ? m.epic_tip_samples_one : m.epic_tip_samples_other)({
          count: f.epicSamples,
        })
      : f.repoSamples > 0
        ? m.epic_tip_samples_repo({ count: f.repoSamples })
        : null;
  return [pace, samples].filter(Boolean).join(" ");
}

function landingSection(ctx: Ctx, t: EpicTiming, checks: ChecksState | undefined): TooltipSection {
  const { f, now } = ctx;
  const ci =
    checks === "pending"
      ? m.epic_tip_ci_running()
      : checks === "success"
        ? m.epic_tip_ci_green()
        : checks === "failure"
          ? m.epic_tip_ci_red()
          : null;
  const since = m.epic_tip_landing_since({ dur: dur(now - t.landingStartedAt!) });
  return {
    label: m.epic_tip_section_time(),
    text: "",
    rows: [
      { text: m.epic_tip_steps_done_after(), tone: "ok", aside: dur(runMs(t, now)) },
      { text: m.epic_tip_landing(), tone: "run", aside: [since, ci].filter(Boolean).join(" · ") },
      ...(f?.finishAt != null
        ? [
            {
              text: m.epic_tip_done_around(),
              aside: m.epic_tip_finish({ at: atApprox(f.finishAt, now) }),
            },
          ]
        : []),
    ],
    ...(f ? { note: m.epic_tip_basis_landing({ landing: approx(f.landingMs) }) } : {}),
  };
}

function totalsSection(t: EpicTiming, started: number): TooltipSection {
  return {
    label: m.epic_tip_section_totals(),
    text: "",
    rows: [
      { text: m.epic_tip_started(), aside: dateTime(started) },
      { text: m.epic_tip_agent_time(), aside: dur(t.agentMs) },
      { text: m.epic_tip_waited(), aside: dur(t.idleMs) },
      ...(t.landingStartedAt != null
        ? [{ text: m.epic_tip_landing(), aside: dur(t.landedAt! - t.landingStartedAt) }]
        : []),
    ],
  };
}

function stepsSection(ctx: Ctx): TooltipSection {
  const { children, epic } = ctx;
  const open = new Set(children.filter((c) => c.state !== "merged").map((c) => c.number));
  const rows = children.map((c): TooltipRow => {
    const text = `#${c.number} ${stepTitle(c.title, epic.parentIssueNumber)}`;
    const { tone, aside } = stepStatus(c, ctx, open);
    return { text, ...(tone ? { tone } : {}), ...(aside ? { aside } : {}) };
  });
  return { label: m.epic_tip_section_steps(), text: "", full: true, rows };
}

/** A step's mark and aside: its duration once merged, its clock and what is left while in
 *  flight, else what it waits on. */
function stepStatus(
  c: EpicChild,
  ctx: Ctx,
  open: Set<number>,
): { tone?: TooltipRow["tone"]; aside: string } {
  if (c.state === "merged")
    return {
      tone: "ok",
      aside: c.startedAt != null && c.endedAt != null ? dur(c.endedAt - c.startedAt) : "",
    };
  if (inFlight(c)) return { tone: "run", aside: inFlightAside(c, ctx) };
  const wait = waitNote(c, ctx.fc.get(c.number), ctx.now, open) ?? "";
  return { aside: c.state === "ready" ? wait : blockedAside(wait, ctx) };
}

/** The step's own clock (the session clock's format), then what is left of it. */
function inFlightAside(c: EpicChild, { fc, now }: Ctx): string {
  const end = fc.get(c.number)?.projectedEnd;
  return [
    c.startedAt != null ? elapsed(c.startedAt, now) : null,
    end != null && end > now ? m.epic_tip_step_left({ left: approx(end - now) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a step not yet started waits on: ready and projected to start later, an agent slot;
 *  blocked, the open steps it waits on (`open`: the epic's unmerged children). Null for a blocked
 *  step whose blockers are all done. */
export function waitNote(
  c: EpicChild,
  cf: EpicChildForecast | undefined,
  now: number,
  open: ReadonlySet<number>,
): string | null {
  if (c.state === "ready")
    return cf?.projectedStart != null && cf.projectedStart > now + WAIT_MS
      ? m.epic_tip_step_waiting_slot()
      : m.epic_tip_step_ready();
  const blockers = c.blockedBy.filter((b) => b !== c.number && open.has(b));
  return blockers.length > 0
    ? m.epic_tip_step_after({ list: blockers.map((b) => `#${b}`).join(", ") })
    : null;
}

/** The open steps it waits on, then the step estimate. */
function blockedAside(wait: string, { f }: Ctx): string {
  return [wait, f ? `~${approx(f.stepMs)}` : null].filter(Boolean).join(" · ");
}

function footer(epic: Epic, now: number): string[] {
  const t = epic.timing;
  const lines = [m.epic_tip_footer_where({ repo: epic.repoPath, number: epic.parentIssueNumber })];
  if (t?.startedAt != null) {
    const ran = elapsed(now - runMs(t, now), now);
    const stop = t.pausedAt ?? t.landingStartedAt;
    lines.push(
      stop == null
        ? m.timetip_clock({ elapsed: ran, start: dateTime(t.startedAt) })
        : m.epic_tip_clock_stopped({ elapsed: ran, at: at(stop, now) }),
    );
  }
  lines.push(m.epic_tip_click());
  return lines;
}

// ── the timeline strip ──────────────────────────────────────────────────────

/** A span in epoch ms, before it is placed on the strip. */
interface Span {
  from: number;
  to: number;
  tone: TooltipSegmentTone;
  projected?: boolean;
}

/** Legend entries in a fixed order; a running step's projected rest reads as running + forecast. */
const LEGEND: {
  key: string;
  tone: TooltipSegmentTone;
  projected?: boolean;
  label: () => string;
}[] = [
  { key: "done", tone: "done", label: m.epic_tip_legend_merged },
  { key: "run", tone: "run", label: m.epic_tip_legend_running },
  { key: "done*", tone: "done", projected: true, label: m.epic_tip_legend_forecast },
  { key: "landing", tone: "landing", label: m.epic_tip_legend_landing },
  { key: "landing*", tone: "landing", projected: true, label: m.epic_tip_legend_landing },
  { key: "pause", tone: "pause", label: m.epic_tip_legend_paused },
  { key: "unknown", tone: "unknown", label: m.epic_tip_legend_unknown },
];

function strip(
  start: number,
  end: number,
  spans: Span[],
  labels: { start: string; end: string; now?: number },
): TooltipTimeline {
  const width = Math.max(1, end - start);
  const frac = (ts: number) => Math.max(0, Math.min(1, (ts - start) / width));
  const drawn = spans.filter((s) => s.to > s.from);
  const keys = new Set(drawn.map((s) => `${s.tone}${s.projected ? "*" : ""}`));
  // One landing entry: dashed when any of it is still projected.
  if (keys.has("landing") && keys.has("landing*")) keys.delete("landing");
  return {
    segments: drawn.map((s) => ({
      from: frac(s.from),
      to: frac(s.to),
      tone: s.tone,
      ...(s.projected ? { projected: true } : {}),
    })),
    start: labels.start,
    end: labels.end,
    ...(labels.now != null
      ? { now: { at: frac(labels.now), label: m.epic_tip_now({ time: clock(labels.now) }) } }
      : {}),
    legend: LEGEND.filter((l) => keys.has(l.key)).map((l) => ({
      tone: l.tone,
      ...(l.projected ? { projected: true } : {}),
      label: l.label(),
    })),
  };
}

/** Merged steps at their real start and end. */
function mergedSpans(children: EpicChild[]): Span[] {
  return children.flatMap((c): Span[] =>
    c.state === "merged" && c.startedAt != null && c.endedAt != null
      ? [{ from: c.startedAt, to: c.endedAt, tone: "done" }]
      : [],
  );
}

function runningStrip(ctx: Ctx, t: EpicTiming): TooltipTimeline {
  const { children, f, fc, now } = ctx;
  const start = t.startedAt!;
  const spans = mergedSpans(children);
  for (const c of children.filter(inFlight)) {
    spans.push({ from: c.startedAt ?? now, to: now, tone: "run" });
    const end = fc.get(c.number)?.projectedEnd;
    if (end != null) spans.push({ from: now, to: end, tone: "run", projected: true });
  }
  if (!f || f.finishAt == null) {
    const end = now + OPEN_SPAN * Math.max(MIN, now - start);
    spans.push({ from: now, to: end, tone: "unknown" });
    return strip(start, end, spans, { start: at(start, now), end: "?", now });
  }
  let lastEnd = now;
  for (const c of children) {
    const cf = fc.get(c.number);
    if (cf?.projectedEnd != null) lastEnd = Math.max(lastEnd, cf.projectedEnd);
    if (!inFlight(c) && cf?.projectedStart != null && cf.projectedEnd != null)
      spans.push({ from: cf.projectedStart, to: cf.projectedEnd, tone: "done", projected: true });
  }
  spans.push({ from: lastEnd, to: f.finishAt, tone: "landing", projected: true });
  const end = Math.max(f.finishAt, now);
  return strip(start, end, spans, {
    start: at(start, now),
    end: `~${atApprox(f.finishAt, now)}`,
    now,
  });
}

/** The clock stands: the pause up to now, then what is left from a resume — no now marker. */
function stoppedStrip(ctx: Ctx, t: EpicTiming): TooltipTimeline {
  const { children, f, now } = ctx;
  const start = t.startedAt!;
  const stop = t.pausedAt!;
  const spans = mergedSpans(children);
  for (const c of children.filter(inFlight))
    spans.push({ from: c.startedAt ?? stop, to: stop, tone: "run" });
  spans.push({ from: stop, to: now, tone: "pause" });
  const rest = f?.remainingMsFromResume;
  if (rest == null) {
    const end = now + OPEN_SPAN * Math.max(MIN, stop - start);
    spans.push({ from: now, to: end, tone: "unknown" });
    return strip(start, end, spans, { start: at(start, now), end: "?" });
  }
  const end = now + rest;
  const landingFrom = Math.max(now, end - f!.landingMs);
  spans.push({ from: now, to: landingFrom, tone: "done", projected: true });
  spans.push({ from: landingFrom, to: end, tone: "landing", projected: true });
  return strip(start, end, spans, { start: at(start, now), end: "?" });
}

function landingStrip(ctx: Ctx, t: EpicTiming): TooltipTimeline {
  const { children, f, now } = ctx;
  const landingFrom = t.landingStartedAt!;
  const start = t.startedAt ?? landingFrom;
  const finish = f?.finishAt ?? null;
  const end = Math.max(finish ?? now, now);
  const spans = [
    ...mergedSpans(children),
    { from: landingFrom, to: now, tone: "landing" } satisfies Span,
    ...(finish != null
      ? [{ from: now, to: finish, tone: "landing", projected: true } satisfies Span]
      : []),
  ];
  return strip(start, end, spans, {
    start: at(start, now),
    end: finish != null ? `~${atApprox(finish, now)}` : "?",
    now,
  });
}

function landedStrip(ctx: Ctx, t: EpicTiming, start: number): TooltipTimeline {
  const { children, now } = ctx;
  const landed = t.landedAt!;
  const spans = [
    ...mergedSpans(children),
    ...(t.landingStartedAt != null
      ? [{ from: t.landingStartedAt, to: landed, tone: "landing" } satisfies Span]
      : []),
  ];
  return strip(start, landed, spans, { start: at(start, now), end: at(landed, now) });
}
