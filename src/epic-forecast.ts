import type {
  Epic,
  EpicChild,
  EpicChildForecast,
  EpicForecast,
  EpicForecastConfidence,
} from "./epic-core";
import type { DeliverySample } from "./types";

const MIN = 60_000;
/** The landing estimate when the repo never landed an epic. */
const DEFAULT_LANDING_MS = 20 * MIN;
/** How many samples the repo median counts as in the blend. */
const PRIOR_WEIGHT = 2;
/** An in-flight step is never projected to need less than this share of its estimate. */
const MIN_REMAINING_SHARE = 0.1;
/** An in-flight child past this multiple of the estimate is overrunning. */
const OVERRUN_FACTOR = 1.5;
/** Below this many own samples the range is widened to at least ×0.75 / ×1.35. */
const MIN_RANGE_SAMPLES = 3;
const WIDEN_LOW = 0.75;
const WIDEN_HIGH = 1.35;
/** One more slot is only worth suggesting when it saves at least this much. */
const MIN_WHAT_IF_SAVING_MS = 15 * MIN;

/** What {@link forecastEpic} reads besides the epic — gathered by the drain, so the model does
 *  no I/O and reads no clock. */
export interface EpicForecastInput {
  /** The repo's `DeliveryStats.leadTimeMs` over 30 days (`repoLeadTime`). */
  repoLeadTime: DeliverySample;
  /** The repo's agent slots. */
  maxAuto: number;
  /** The repo's non-archived auto sessions — what the drain's cap counts. */
  slotsUsed: number;
  /** `landedAt − landingStartedAt` of the repo's landed epics. */
  landingMs: number[];
  /** The persisted drift anchor (`epic_clock.firstFinishAt`). */
  firstFinishAt: number | null;
  now: number;
}

/** A child still to finish, as the simulation sees it. */
interface Step {
  child: EpicChild;
  /** Blockers that are themselves still to finish. */
  blockers: number[];
  /** Time already worked when in flight (`running` / `in-review`); null while pending. */
  elapsed: number | null;
  /** In flight with a live session — what the drain's cap counts. */
  holdsSlot: boolean;
}

/** Offsets from now. */
interface Span {
  start: number;
  end: number;
}

/** The landing step: its estimate, and how long it has been underway (null before it began). */
interface Landing {
  ms: number;
  since: number | null;
}

/**
 * Pure: when `epic` lands and how sure that is; null when there is nothing to forecast from (no
 * repo median and no measured child) or once it landed.
 *
 * Each child is priced at the mean of the repo median (counted {@link PRIOR_WEIGHT} times) and this
 * epic's measured children, so the epic's own pace takes over as it accumulates. The children
 * still to finish are list-scheduled over `maxAuto` slots in epic order, honoring `blockedBy`, and
 * the landing follows the last one. The range re-runs that schedule at the blend's p25 / p75.
 * While the clock is stopped (paused, idle) nothing is absolute: only the time from a resume.
 */
export function forecastEpic(epic: Epic, input: EpicForecastInput): EpicForecast | null {
  const timing = epic.timing;
  if (timing?.landedAt != null) return null;
  const own = ownSamples(epic.children);
  const repo = input.repoLeadTime.value;
  const blend = repo == null ? own : [...Array<number>(PRIOR_WEIGHT).fill(repo), ...own];
  if (blend.length === 0) return null;
  const stepMs = mean(blend);
  const [lowMs, highMs] = stepRange(blend, stepMs, own.length);
  const { now } = input;
  const landing: Landing = {
    ms: median(input.landingMs.filter((ms) => ms > 0)) ?? DEFAULT_LANDING_MS,
    since: timing?.landingStartedAt != null ? Math.max(0, now - timing.landingStartedAt) : null,
  };
  // A landing underway means every child is in; only its own remainder is left.
  const steps = landing.since == null ? toSteps(epic.children, now) : [];
  const slots = Math.max(1, input.maxAuto);
  const point = project(steps, stepMs, slots, landing);
  const live = landing.since != null || epic.run.status === "running";
  const at = (offset: number) => (live ? Math.round(now + offset) : null);
  const finishAt = at(point.finish);
  const anyMerged = epic.children.some((c) => c.state === "merged");
  return {
    finishAt,
    finishLow: at(Math.min(point.finish, project(steps, lowMs, slots, landing).finish)),
    finishHigh: at(Math.max(point.finish, project(steps, highMs, slots, landing).finish)),
    remainingMsFromResume: live ? null : Math.round(point.finish),
    confidence: confidence(epic.children, own.length),
    stepMs: Math.round(stepMs),
    landingMs: Math.round(landing.ms),
    epicSamples: own.length,
    repoSamples: repo == null ? 0 : input.repoLeadTime.n,
    firstFinishAt: input.firstFinishAt ?? (anyMerged ? finishAt : null),
    fasterWithSlots:
      finishAt == null ? null : fasterWithSlots(epic, input, steps, stepMs, landing, finishAt),
    children: steps.map((s) =>
      childForecast(s, point.spans.get(s.child.number)!, stepMs, now, live),
    ),
  };
}

/** Durations of this epic's merged children whose start and end are both known. */
function ownSamples(children: EpicChild[]): number[] {
  return children.flatMap((c) =>
    c.state === "merged" && c.startedAt != null && c.endedAt != null && c.endedAt > c.startedAt
      ? [c.endedAt - c.startedAt]
      : [],
  );
}

/** The low / high step: the blend's p25 / p75, never past the estimate itself, and with fewer than
 *  {@link MIN_RANGE_SAMPLES} own samples at least ×{@link WIDEN_LOW} / ×{@link WIDEN_HIGH} of it. */
function stepRange(blend: number[], stepMs: number, own: number): [number, number] {
  const sorted = [...blend].sort((a, b) => a - b);
  let low = Math.min(quantile(sorted, 0.25), stepMs);
  let high = Math.max(quantile(sorted, 0.75), stepMs);
  if (own < MIN_RANGE_SAMPLES) {
    low = Math.min(low, WIDEN_LOW * stepMs);
    high = Math.max(high, WIDEN_HIGH * stepMs);
  }
  return [low, high];
}

function confidence(children: EpicChild[], own: number): EpicForecastConfidence {
  const merged = children.filter((c) => c.state === "merged").length;
  if (own >= 4 || merged * 2 >= children.length) return "high";
  if (own === 0) return "very-low";
  return own === 1 ? "low" : "medium";
}

/** The children still to finish, in epic order. */
function toSteps(children: EpicChild[], now: number): Step[] {
  const open = children
    .filter((c) => c.state !== "merged")
    .sort((a, b) => a.order - b.order || a.number - b.number);
  const openNumbers = new Set(open.map((c) => c.number));
  return open.map((c) => {
    const inFlight = c.state === "running" || c.state === "in-review";
    return {
      child: c,
      blockers: c.blockedBy.filter((b) => b !== c.number && openNumbers.has(b)),
      elapsed: inFlight ? Math.max(0, now - (c.startedAt ?? now)) : null,
      holdsSlot: inFlight && c.sessionId != null,
    };
  });
}

/** Time an in-flight step still needs: what is left of its estimate, but never less than
 *  {@link MIN_REMAINING_SHARE} of it — it has not finished yet. */
function remaining(estimate: number, elapsed: number): number {
  return Math.max(estimate - elapsed, MIN_REMAINING_SHARE * estimate);
}

/** The schedule at one step duration: each child's span and the landing's end (offsets). */
function project(
  steps: Step[],
  stepMs: number,
  slots: number,
  landing: Landing,
): { finish: number; spans: Map<number, Span> } {
  if (landing.since != null)
    return { finish: remaining(landing.ms, landing.since), spans: new Map() };
  const spans = simulate(steps, stepMs, slots);
  const lastEnd = Math.max(0, ...[...spans.values()].map((s) => s.end));
  return { finish: lastEnd + landing.ms, spans };
}

/** The schedule as the simulation builds it. */
interface Schedule {
  spans: Map<number, Span>;
  /** The spans that hold a slot. */
  slotted: Span[];
  stepMs: number;
  slots: number;
}

/** List scheduling: in-flight steps run from now for their remainder; at each moment a step ends,
 *  every pending step whose blockers have ended starts, in epic order, while a slot is free. */
function simulate(steps: Step[], stepMs: number, slots: number): Map<number, Span> {
  const sched: Schedule = { spans: new Map(), slotted: [], stepMs, slots };
  for (const s of steps)
    if (s.elapsed != null) place(sched, s, 0, remaining(stepMs, s.elapsed), s.holdsSlot);
  let t = 0;
  let pending = startReady(
    sched,
    steps.filter((s) => s.elapsed == null),
    t,
  );
  while (pending.length > 0) {
    const ends = [...sched.spans.values()].map((sp) => sp.end).filter((end) => end > t);
    // A dependency cycle leaves nothing to wait for: its first step starts anyway.
    if (ends.length === 0) place(sched, pending.shift()!, t, t + stepMs, true);
    else t = Math.min(...ends);
    pending = startReady(sched, pending, t);
  }
  return sched.spans;
}

function place(sched: Schedule, s: Step, start: number, end: number, holdsSlot: boolean): void {
  const span = { start, end };
  sched.spans.set(s.child.number, span);
  if (holdsSlot) sched.slotted.push(span);
}

/** Start, in epic order, every pending step whose blockers have ended at `t` while a slot is free;
 *  returns the steps still waiting. */
function startReady(sched: Schedule, pending: Step[], t: number): Step[] {
  const waiting: Step[] = [];
  for (const s of pending) {
    const free = sched.slotted.filter((sp) => sp.end > t).length < sched.slots;
    const unblocked = s.blockers.every((b) => (sched.spans.get(b)?.end ?? Infinity) <= t);
    if (free && unblocked) place(sched, s, t, t + sched.stepMs, true);
    else waiting.push(s);
  }
  return waiting;
}

/** The finish with one more slot — only when a `ready` child waits on the cap and the slot saves
 *  at least {@link MIN_WHAT_IF_SAVING_MS}. */
function fasterWithSlots(
  epic: Epic,
  input: EpicForecastInput,
  steps: Step[],
  stepMs: number,
  landing: Landing,
  finishAt: number,
): EpicForecast["fasterWithSlots"] {
  const capHeld =
    epic.children.some((c) => c.state === "ready") && input.slotsUsed >= input.maxAuto;
  if (!capHeld) return null;
  const slots = Math.max(1, input.maxAuto) + 1;
  const fasterAt = Math.round(input.now + project(steps, stepMs, slots, landing).finish);
  const savedMs = finishAt - fasterAt;
  return savedMs >= MIN_WHAT_IF_SAVING_MS ? { slots, finishAt: fasterAt, savedMs } : null;
}

function childForecast(
  s: Step,
  span: Span,
  stepMs: number,
  now: number,
  live: boolean,
): EpicChildForecast {
  const inFlight = s.elapsed != null;
  return {
    number: s.child.number,
    projectedStart: !live
      ? null
      : inFlight
        ? (s.child.startedAt ?? now)
        : Math.round(now + span.start),
    projectedEnd: live ? Math.round(now + span.end) : null,
    overrun: inFlight && s.elapsed! > OVERRUN_FACTOR * stepMs,
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

/** Linear interpolation between the closest ranks of an ascending, non-empty list. */
function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}
