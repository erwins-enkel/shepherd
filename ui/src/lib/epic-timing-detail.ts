import { m } from "#lib/paraglide/messages.js";
import { elapsed } from "#lib/format.js";
import {
  approx,
  at,
  atApprox,
  byEpicOrder,
  clock,
  confidenceRung,
  confidenceWord,
  dateTime,
  dur,
  inFlight,
  phaseOf,
  round5,
  runMs,
  sameDay,
  slipMs,
  stepTitle,
  waitNote,
  type Phase,
} from "./epic-timing-text";
import type { Epic, EpicChild, EpicChildForecast, EpicForecast, EpicTiming } from "./types";

// The backlog epic detail's time view (#2939): the ZEIT tiles, the ZEITLEISTE Gantt, the
// faster-with-slots hint, the forecast's basis and the step list's durations. Pure: every
// function reads the caller's `now`, so the detail ticks with its own clock.

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Tick steps in hours; the smallest that keeps the axis readable wins — a 12-hour clock's
 *  "10:00 PM" needs the room. */
const TICK_HOURS = [1, 2, 3, 6, 12, 24];
const MAX_TICKS = 8;
/** A note past this share of the track goes before its bar instead of after it. */
const NOTE_FLIP = 0.7;

/** One ZEIT tile. */
export interface TimeTile {
  /** May carry glossary markers. */
  label: string;
  value: string;
  tone?: "warn";
  /** The muted line under the value. */
  sub?: string;
  /** The forecast's confidence: a rung 0–3 for the meter and its words. */
  confidence?: { rung: number; text: string };
  /** A last line in the tile's tone: where a slipped finish stood before. */
  note?: string;
}

/** The ZEIT tiles for the epic's phase; [] before the epic ever ran, null without a clock. */
export function epicTimeTiles(epic: Epic, now: number): TimeTile[] | null {
  const t = epic.timing;
  if (!t) return null;
  const f = epic.forecast ?? null;
  const phase = phaseOf(epic);
  switch (phase) {
    case "plain":
    case "unstarted":
      return [];
    case "running":
      return [
        { label: m.epicdetail_tile_running(), value: dur(runMs(t, now)), sub: since(t) },
        agentTile(t),
        ...(f?.finishAt != null
          ? [remainingTile(f, f.finishAt, now), finishTile(f, f.finishAt, now, true)]
          : noForecastTiles()),
      ];
    case "paused":
    case "stopped":
      return [
        { label: m.epic_tip_ran(), value: dur(runMs(t, now)), sub: since(t) },
        agentTile(t),
        {
          label: phase === "paused" ? m.epic_tip_paused() : m.epicdetail_tile_stopped(),
          value: dur(now - t.pausedAt!),
          sub: m.epicdetail_paused_since({ at: at(t.pausedAt!, now) }),
        },
        resumeTile(f, now),
      ];
    case "landing":
      return [
        {
          label: m.epic_tip_steps_done_after(),
          value: dur(runMs(t, now)),
          ...(t.startedAt != null ? { sub: since(t) } : {}),
        },
        agentTile(t),
        {
          label: m.epic_tip_landing(),
          value: dur(now - t.landingStartedAt!),
          sub: m.epicdetail_landing_sub(),
        },
        f?.finishAt != null
          ? finishTile(f, f.finishAt, now, false)
          : { label: m.epic_tip_done_around(), value: "?" },
      ];
    case "landed":
      return landedTiles(epic, t, now);
  }
}

const since = (t: EpicTiming) => m.epicdetail_since({ at: dateTime(t.startedAt!) });

function agentTile(t: EpicTiming): TimeTile {
  return {
    label: m.epicdetail_tile_agent(),
    value: dur(t.agentMs),
    sub: m.epicdetail_idle({ dur: dur(t.idleMs) }),
  };
}

function remainingTile(f: EpicForecast, finishAt: number, now: number): TimeTile {
  const left = (ts: number) => approx(Math.max(0, ts - now));
  return {
    label: m.epicdetail_tile_remaining(),
    value: m.epic_tip_about({ dur: left(finishAt) }),
    sub: m.epicdetail_remaining_range({
      low: left(f.finishLow ?? finishAt),
      high: left(f.finishHigh ?? finishAt),
    }),
  };
}

/** Running without a forecast: nothing to count down, no time to name. */
function noForecastTiles(): TimeTile[] {
  return [
    {
      label: m.epicdetail_tile_remaining(),
      value: m.epic_tip_no_forecast(),
      sub: m.epicdetail_first_estimate(),
    },
    { label: m.epic_tip_done_around(), value: "?" },
  ];
}

/** "Today" or "tomorrow" for a forecast instant; null when its label already names the date. */
function dayWord(ts: number, now: number): string | null {
  const t = round5(ts);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(t, now)) return m.epicdetail_today();
  if (sameDay(t, tomorrow.getTime())) return m.epicdetail_tomorrow();
  return null;
}

const confidence = (f: EpicForecast) => ({
  rung: confidenceRung(f),
  text: m.epicdetail_confidence({ word: confidenceWord(f) }),
});

function finishTile(f: EpicForecast, finishAt: number, now: number, slips: boolean): TimeTile {
  const slip = slips ? slipMs(f) : null;
  const range = m.epic_tip_range_value({
    low: atApprox(f.finishLow ?? finishAt, now),
    high: atApprox(f.finishHigh ?? finishAt, now),
  });
  return {
    label: m.epic_tip_done_around(),
    value: m.epic_tip_finish({ at: atApprox(finishAt, now) }),
    sub: [dayWord(finishAt, now), range].filter(Boolean).join(" · "),
    confidence: confidence(f),
    ...(slip != null
      ? { tone: "warn", note: m.epicdetail_finish_was({ was: atApprox(f.firstFinishAt!, now) }) }
      : {}),
  };
}

/** While the clock stands: what is left from a resume. */
function resumeTile(f: EpicForecast | null, now: number): TimeTile {
  const label = m.epic_tip_remaining_from_resume();
  const rest = f?.remainingMsFromResume ?? (f?.finishAt != null ? f.finishAt - now : null);
  if (!f || rest == null)
    return { label, value: m.epic_tip_no_forecast(), sub: m.epicdetail_first_estimate() };
  return {
    label,
    value: m.epic_tip_about({ dur: approx(Math.max(0, rest)) }),
    confidence: confidence(f),
  };
}

/** Durations of the merged steps with both ends known, in epic order. */
function measured(children: readonly EpicChild[]): { number: number; ms: number }[] {
  return [...children]
    .sort(byEpicOrder)
    .flatMap((c) =>
      c.state === "merged" && c.startedAt != null && c.endedAt != null && c.endedAt > c.startedAt
        ? [{ number: c.number, ms: c.endedAt - c.startedAt }]
        : [],
    );
}

/** The totals once landed: total, agent time, waited / landing, fastest / slowest step. */
function landedTiles(epic: Epic, t: EpicTiming, now: number): TimeTile[] {
  const landed = t.landedAt!;
  const start = t.startedAt ?? t.landingStartedAt ?? landed;
  const landing = t.landingStartedAt != null ? dur(landed - t.landingStartedAt) : "—";
  const steps = measured(epic.children).sort((a, b) => a.ms - b.ms);
  const fast = steps[0];
  const slow = steps[steps.length - 1];
  const extremes: TimeTile =
    steps.length === 0
      ? { label: m.epicdetail_tile_fastest_slowest(), value: "—" }
      : steps.length === 1
        ? {
            label: m.epicdetail_tile_fastest_slowest(),
            value: dur(fast.ms),
            sub: `#${fast.number}`,
          }
        : {
            label: m.epicdetail_tile_fastest_slowest(),
            value: `${dur(fast.ms)} / ${dur(slow.ms)}`,
            sub: `#${fast.number} / #${slow.number}`,
          };
  return [
    {
      label: m.epicdetail_tile_total(),
      value: dur(landed - start - t.pausedMs),
      sub: m.epic_tip_range_value({ low: dateTime(start), high: at(landed, now) }),
    },
    { label: m.epicdetail_tile_agent(), value: dur(t.agentMs) },
    { label: m.epicdetail_tile_waited_landing(), value: `${dur(t.idleMs)} / ${landing}` },
    extremes,
  ];
}

// ── the Gantt ───────────────────────────────────────────────────────────────

export type GanttTone = "done" | "run" | "landing";

/** A bar on a row's track, as 0–1 fractions of the axis. */
export interface GanttBar {
  from: number;
  to: number;
  tone: GanttTone;
  /** Not yet happened: a dashed outline. */
  projected?: boolean;
}

export interface GanttRow {
  key: string;
  /** The child's number; null for the landing and finish rows. */
  number: number | null;
  title: string;
  mark: "ok" | "run" | "wait" | "landing" | "finish";
  bars: GanttBar[];
  /** The finish row's range, with a tick where the forecast lands. */
  band?: { from: number; to: number; at: number };
  note: string;
  noteTone?: "bright" | "run" | "warn";
  /** Where the note sits on the track: after `noteAt`, or right-aligned before it. */
  noteAt: number;
  noteSide: "after" | "before";
}

export type GanttLegendKey = "done" | "run" | "forecast" | "range" | "landing" | "pause";

export interface EpicGantt {
  ticks: { at: number; label: string }[];
  rows: GanttRow[];
  now: { at: number; label: string } | null;
  /** The clock stands from here to now (paused or stopped). */
  pause: { from: number; to: number } | null;
  legend: { key: GanttLegendKey; label: string }[];
}

const LEGEND: { key: GanttLegendKey; label: () => string }[] = [
  { key: "done", label: m.epic_tip_legend_merged },
  { key: "run", label: m.epic_tip_legend_running },
  { key: "forecast", label: m.epic_tip_legend_forecast },
  { key: "range", label: m.epicdetail_legend_range },
  { key: "landing", label: m.epic_tip_legend_landing },
  { key: "pause", label: m.epic_tip_legend_paused },
];

/** A row before its bars are placed: spans in epoch ms. */
interface RawRow {
  key: string;
  number: number | null;
  title: string;
  mark: GanttRow["mark"];
  spans: { from: number; to: number; tone: GanttTone; projected?: boolean }[];
  band?: { from: number; to: number; at: number };
  note: string;
  noteTone?: GanttRow["noteTone"];
}

/** What the row builders read. */
interface GanttCtx {
  parent: number;
  now: number;
  /** Where the clock stopped (paused or stopped); null while it runs. */
  stop: number | null;
  fc: Map<number, EpicChildForecast>;
  /** The epic's unmerged children. */
  open: Set<number>;
}

/** The ZEITLEISTE: one row per child, the landing, the finish range; null before the epic ran. */
export function epicGantt(epic: Epic, now: number): EpicGantt | null {
  const t = epic.timing;
  const phase = phaseOf(epic);
  if (!t || phase === "plain" || phase === "unstarted") return null;
  const f = epic.forecast ?? null;
  const children = [...epic.children].sort(byEpicOrder);
  const ctx: GanttCtx = {
    parent: epic.parentIssueNumber,
    now,
    stop: phase === "paused" || phase === "stopped" ? t.pausedAt : null,
    fc: new Map(f?.children.map((c) => [c.number, c])),
    open: new Set(children.filter((c) => c.state !== "merged").map((c) => c.number)),
  };
  const finishAt = phase === "running" || phase === "landing" ? (f?.finishAt ?? null) : null;

  const raw = children.map((c) => childRow(c, ctx));
  const landingRow = landing(phase, t, f, finishAt, now, raw);
  if (landingRow) raw.push(landingRow);
  if (finishAt != null) raw.push(finishRow(f!, finishAt, now));

  const { start, end } = axis(epic, phase, f, finishAt, now);
  const width = Math.max(MIN, end - start);
  const frac = (ts: number) => Math.max(0, Math.min(1, (ts - start) / width));
  const nowAt = phase === "landed" ? null : frac(now);
  const rows = raw.map((r) => place(r, frac, nowAt));

  return {
    ticks: ticks(start, end).map((ts) => ({ at: frac(ts), label: tickLabel(ts) })),
    rows,
    now: nowAt == null ? null : { at: nowAt, label: m.epic_tip_now({ time: clock(now) }) },
    pause: ctx.stop == null ? null : { from: frac(ctx.stop), to: frac(now) },
    legend: legend(rows, ctx.stop != null),
  };
}

function childRow(c: EpicChild, ctx: GanttCtx): RawRow {
  const base = { key: `#${c.number}`, number: c.number, title: stepTitle(c.title, ctx.parent) };
  if (c.state === "merged") return { ...base, ...mergedRow(c) };
  if (inFlight(c)) return { ...base, ...inFlightRow(c, ctx) };
  const cf = ctx.fc.get(c.number);
  const planned = cf?.projectedStart != null && cf.projectedEnd != null;
  return {
    ...base,
    mark: "wait",
    spans: planned
      ? [{ from: cf.projectedStart!, to: cf.projectedEnd!, tone: "done", projected: true }]
      : [],
    note: waitNote(c, cf, ctx.now, ctx.open) ?? "",
  };
}

type RowBody = Omit<RawRow, "key" | "number" | "title">;

/** At its real start and end, noted with how long it took. */
function mergedRow(c: EpicChild): RowBody {
  const known = c.startedAt != null && c.endedAt != null;
  return {
    mark: "ok",
    spans: known ? [{ from: c.startedAt!, to: c.endedAt!, tone: "done" }] : [],
    note: known ? dur(c.endedAt! - c.startedAt!) : m.epic_tip_legend_merged(),
    noteTone: "bright",
  };
}

/** Up to now, then — while the clock runs — dashed to its projected end. */
function inFlightRow(c: EpicChild, { fc, now, stop }: GanttCtx): RowBody {
  const cf = fc.get(c.number);
  const end = stop == null ? (cf?.projectedEnd ?? null) : null;
  const ahead = end != null && end > now ? end : null;
  return {
    mark: "run",
    spans: [
      { from: c.startedAt ?? now, to: now, tone: "run" },
      ...(ahead != null ? [{ from: now, to: ahead, tone: "run" as const, projected: true }] : []),
    ],
    note:
      ahead != null
        ? m.epicdetail_note_running({ left: approx(ahead - now) })
        : m.epic_tip_legend_running(),
    noteTone: cf?.overrun ? "warn" : "run",
  };
}

/** The forecast's range with a tick where it lands. */
function finishRow(f: EpicForecast, finishAt: number, now: number): RawRow {
  const low = f.finishLow ?? finishAt;
  const high = f.finishHigh ?? finishAt;
  return {
    key: "finish",
    number: null,
    title: m.epicdetail_row_finish({ at: atApprox(finishAt, now) }),
    mark: "finish",
    spans: [],
    band: { from: low, to: high, at: finishAt },
    note: m.epic_tip_range_value({ low: atApprox(low, now), high: atApprox(high, now) }),
  };
}

/** From the earliest start to the landing, the forecast's latest finish, or a little past now. */
function axis(
  epic: Epic,
  phase: Phase,
  f: EpicForecast | null,
  finishAt: number | null,
  now: number,
): { start: number; end: number } {
  const t = epic.timing!;
  const starts = [t.startedAt, t.landingStartedAt, ...epic.children.map((c) => c.startedAt)].filter(
    (n): n is number => n != null,
  );
  const start = starts.length > 0 ? Math.min(...starts) : (t.landedAt ?? now);
  if (phase === "landed") return { start, end: t.landedAt! };
  if (finishAt != null) return { start, end: Math.max(f!.finishHigh ?? finishAt, finishAt, now) };
  return { start, end: now + Math.max(30 * MIN, 0.1 * (now - start)) };
}

/** A row's spans as fractions of the axis, its note placed. */
function place(r: RawRow, frac: (ts: number) => number, nowAt: number | null): GanttRow {
  const bars = r.spans
    .filter((s) => s.to > s.from)
    .map((s) => ({
      from: frac(s.from),
      to: frac(s.to),
      tone: s.tone,
      ...(s.projected ? { projected: true } : {}),
    }));
  const band = r.band && { from: frac(r.band.from), to: frac(r.band.to), at: frac(r.band.at) };
  return {
    key: r.key,
    number: r.number,
    title: r.title,
    mark: r.mark,
    bars,
    ...(band ? { band } : {}),
    note: r.note,
    ...(r.noteTone ? { noteTone: r.noteTone } : {}),
    ...notePlace(bars, band, nowAt),
  };
}

/** The legend for what is drawn, in a fixed order. */
function legend(rows: GanttRow[], paused: boolean): EpicGantt["legend"] {
  const keys = new Set<GanttLegendKey>(paused ? ["pause"] : []);
  for (const r of rows) {
    for (const b of r.bars) keys.add(b.projected ? "forecast" : b.tone);
    if (r.band) keys.add("range");
  }
  return LEGEND.filter((l) => keys.has(l.key)).map((l) => ({ key: l.key, label: l.label() }));
}

/** The landing row: underway, done, or projected after the last step; none while the clock
 *  stands or without a forecast. */
function landing(
  phase: Phase,
  t: EpicTiming,
  f: EpicForecast | null,
  finishAt: number | null,
  now: number,
  steps: RawRow[],
): RawRow | null {
  const base = {
    key: "landing",
    number: null,
    title: m.epicdetail_row_landing(),
    mark: "landing" as const,
  };
  if (phase === "landed") {
    if (t.landingStartedAt == null) return null;
    return {
      ...base,
      spans: [{ from: t.landingStartedAt, to: t.landedAt!, tone: "landing" }],
      note: dur(t.landedAt! - t.landingStartedAt),
      noteTone: "bright",
    };
  }
  if (phase === "landing") {
    const from = t.landingStartedAt!;
    return {
      ...base,
      spans: [
        { from, to: now, tone: "landing" },
        ...(finishAt != null && finishAt > now
          ? [{ from: now, to: finishAt, tone: "landing" as const, projected: true }]
          : []),
      ],
      note: m.epic_tip_landing_since({ dur: dur(now - from) }),
    };
  }
  if (f == null || finishAt == null) return null;
  const lastEnd = Math.max(now, ...steps.flatMap((r) => r.spans.map((s) => s.to)));
  return {
    ...base,
    spans: [{ from: Math.min(lastEnd, finishAt), to: finishAt, tone: "landing", projected: true }],
    note: m.epicdetail_note_landing({ dur: approx(f.landingMs) }),
  };
}

/** After the row's last bar; near the right edge, before its first one instead; a row with
 *  nothing drawn notes beside now. */
function notePlace(
  bars: GanttBar[],
  band: GanttRow["band"],
  nowAt: number | null,
): Pick<GanttRow, "noteAt" | "noteSide"> {
  const ends = [...bars.map((b) => b.to), ...(band ? [band.to] : [])];
  const starts = [...bars.map((b) => b.from), ...(band ? [band.from] : [])];
  if (ends.length === 0) {
    const pos = nowAt ?? 0;
    return { noteAt: pos, noteSide: pos <= NOTE_FLIP ? "after" : "before" };
  }
  const last = Math.max(...ends);
  if (last <= NOTE_FLIP) return { noteAt: last, noteSide: "after" };
  const first = Math.min(...starts);
  // No room on either side: right-aligned at the track's end, over the bar.
  return first >= 1 - NOTE_FLIP
    ? { noteAt: first, noteSide: "before" }
    : { noteAt: 1, noteSide: "before" };
}

/** Local whole hours at the smallest step that keeps the axis to {@link MAX_TICKS} ticks. */
function ticks(start: number, end: number): number[] {
  const span = end - start;
  const step =
    TICK_HOURS.find((h) => span / (h * HOUR) <= MAX_TICKS) ??
    24 * Math.ceil(span / (MAX_TICKS * 24 * HOUR));
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < start) d.setHours(d.getHours() + 1);
  while (d.getHours() % step !== 0) d.setHours(d.getHours() + 1);
  const out: number[] = [];
  for (; d.getTime() <= end; d.setHours(d.getHours() + step)) out.push(d.getTime());
  return out;
}

/** A tick's hour; midnight names the day instead. */
function tickLabel(ts: number): string {
  return new Date(ts).getHours() === 0
    ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : clock(ts);
}

// ── the hint, the basis, the durations ─────────────────────────────────────

export interface FasterSlotsHint {
  /** May carry glossary markers. */
  title: string;
  body: string;
  action: string;
}

/** One more agent slot would land the epic notably sooner: what, why, and the cost. Null unless
 *  the forecast offers the what-if. */
export function fasterSlotsHint(epic: Epic, now: number): FasterSlotsHint | null {
  const f = epic.forecast;
  const w = f?.fasterWithSlots;
  if (!f || !w || f.finishAt == null) return null;
  const children = [...epic.children].sort(byEpicOrder);
  const fc = new Map(f.children.map((c) => [c.number, c]));
  const ready = children.filter((c) => c.state === "ready");
  // The step the cap holds back: ready, but projected to start later.
  const waiting =
    ready.find((c) => (fc.get(c.number)?.projectedStart ?? 0) > now + MIN) ?? ready[0];
  const alongside = children.filter(inFlight).map((c) => `#${c.number}`);
  const reason =
    waiting == null
      ? null
      : alongside.length > 0
        ? m.epicdetail_faster_parallel({ step: `#${waiting.number}`, list: alongside.join(", ") })
        : m.epicdetail_faster_waiting({ step: `#${waiting.number}` });
  return {
    title: m.epicdetail_faster_title({
      slots: w.slots,
      at: atApprox(w.finishAt, now),
      was: atApprox(f.finishAt, now),
    }),
    body: [reason, m.epicdetail_faster_cost()].filter(Boolean).join(" "),
    action: m.epicdetail_faster_allow({ slots: w.slots }),
  };
}

/** "How is the forecast made?": the step estimate's blend, the order over the slots plus the
 *  landing, and how the range behaves. Null without a forecast. May carry glossary markers. */
export function forecastBasisLines(epic: Epic, slots: number | null): string[] | null {
  const f = epic.forecast;
  if (!f) return null;
  return [
    blendLine(f, epic.children),
    orderLine(slots, approx(f.landingMs)),
    m.epicdetail_basis_range(),
  ];
}

/** How the step estimate is blended: this epic's measured steps, the repo median, or both. */
function blendLine(f: EpicForecast, children: readonly EpicChild[]): string {
  const step = approx(f.stepMs);
  const own = measured(children);
  // One measured step is named, with its time; more are counted.
  const one = f.epicSamples === 1 && own.length === 1 ? own[0] : null;
  const sample = one && { number: `#${one.number}`, dur: dur(one.ms) };
  if (f.epicSamples === 0) return m.epicdetail_basis_repo({ step, count: f.repoSamples });
  if (f.repoSamples === 0)
    return sample
      ? m.epicdetail_basis_epic_one({ step, ...sample })
      : m.epicdetail_basis_epic_other({ step, own: f.epicSamples });
  return sample
    ? m.epicdetail_basis_blend_one({ step, ...sample, count: f.repoSamples })
    : m.epicdetail_basis_blend_other({ step, own: f.epicSamples, count: f.repoSamples });
}

/** The order over the agent slots, plus the landing. */
function orderLine(slots: number | null, landing: string): string {
  if (slots == null) return m.epicdetail_basis_order({ landing });
  return slots <= 1
    ? m.epicdetail_basis_order_serial({ landing })
    : m.epicdetail_basis_order_parallel({ slots, landing });
}

/** A step's DAUER cell. */
export interface ChildDuration {
  /** The running step's own clock (the session clock's format). */
  clock?: string;
  text: string;
  tone: "done" | "run" | "forecast";
}

/** Merged: how long it took; in flight: its clock and what is left; otherwise the step estimate.
 *  Null when there is nothing to show or the server sends no epic clock. */
export function childDuration(c: EpicChild, epic: Epic, now: number): ChildDuration | null {
  if (!epic.timing) return null;
  const f = epic.forecast ?? null;
  if (c.state === "merged")
    return c.startedAt != null && c.endedAt != null
      ? { text: dur(c.endedAt - c.startedAt), tone: "done" }
      : null;
  if (inFlight(c)) return inFlightDuration(c, f, now);
  return f
    ? { text: m.epicdetail_dur_forecast({ dur: approx(f.stepMs) }), tone: "forecast" }
    : null;
}

function inFlightDuration(c: EpicChild, f: EpicForecast | null, now: number): ChildDuration | null {
  const end = f?.children.find((x) => x.number === c.number)?.projectedEnd;
  const left = end != null && end > now ? m.epic_tip_step_left({ left: approx(end - now) }) : "";
  if (c.startedAt == null) return left ? { text: left, tone: "run" } : null;
  return { clock: elapsed(c.startedAt, now), text: left, tone: "run" };
}
