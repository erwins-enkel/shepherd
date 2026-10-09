import type { Epic, EpicChild, EpicClock, EpicTiming } from "./epic-core";

/** One session that worked a child issue; `endedAt` is null while the session is alive. */
export interface EpicSessionSpan {
  id: string;
  issueNumber: number | null;
  createdAt: number;
  endedAt: number | null;
}

/** A child session's delivery fact — it outlives the session row's prune. */
export interface EpicDeliveryFact {
  sessionId: string;
  issueNumber: number | null;
  createdAt: number;
  mergedAt: number | null;
}

/** What {@link withEpicTiming} reads — gathered by the drain, so the derivation does no I/O. */
export interface EpicTimingInput {
  /** The epic's `epic_clock` row; null when it never ran. */
  clock: EpicClock | null;
  /** Sessions of the repo; only those on one of the epic's children count. */
  sessions: EpicSessionSpan[];
  /** Delivery facts of the repo; only those on one of the epic's children count. */
  facts: EpicDeliveryFact[];
  /** child # → when it was squash-merged into the integration branch (`epic_integrated`). */
  integratedAt: Map<number, number>;
  now: number;
}

type Span = [number, number];

/** Pure: the epic with its {@link EpicTiming} and each child's `startedAt`/`endedAt` attached. */
export function withEpicTiming(epic: Epic, input: EpicTimingInput): Epic {
  const kids = new Set(epic.children.map((c) => c.number));
  const onChild = <T extends { issueNumber: number | null }>(w: T) =>
    w.issueNumber != null && kids.has(w.issueNumber);
  const sessions = input.sessions.filter(onChild);
  const facts = input.facts.filter(onChild);
  return {
    ...epic,
    children: epic.children.map((c) => ({
      ...c,
      ...childTiming(c, sessions, facts, input.integratedAt),
    })),
    timing: epicTiming(input.clock, workSpans(sessions, facts, input.now), input.now),
  };
}

/** Start = the child's earliest session or fact. End = only once the child is done: its
 *  integration stamp, else the latest merge of its facts. */
function childTiming(
  c: EpicChild,
  sessions: EpicSessionSpan[],
  facts: EpicDeliveryFact[],
  integratedAt: Map<number, number>,
): { startedAt: number | null; endedAt: number | null } {
  const starts = [...sessions, ...facts]
    .filter((w) => w.issueNumber === c.number)
    .map((w) => w.createdAt);
  const startedAt = starts.length > 0 ? Math.min(...starts) : null;
  if (c.state !== "merged") return { startedAt, endedAt: null };
  const merges = facts
    .filter((f) => f.issueNumber === c.number && f.mergedAt != null)
    .map((f) => f.mergedAt!);
  const endedAt = integratedAt.get(c.number) ?? (merges.length > 0 ? Math.max(...merges) : null);
  return { startedAt, endedAt };
}

/** Child work as time spans: every session (to now while alive), plus each fact whose session
 *  row is gone and that merged — a pruned fact without a merge has no known end. */
function workSpans(sessions: EpicSessionSpan[], facts: EpicDeliveryFact[], now: number): Span[] {
  const known = new Set(sessions.map((s) => s.id));
  const spans: Span[] = sessions.map((s) => [s.createdAt, s.endedAt ?? now]);
  for (const f of facts)
    if (!known.has(f.sessionId) && f.mergedAt != null) spans.push([f.createdAt, f.mergedAt]);
  return spans.map(([a, b]): Span => [a, Math.min(b, now)]).filter(([a, b]) => b > a);
}

function epicTiming(clock: EpicClock | null, spans: Span[], now: number): EpicTiming {
  const agentMs = length(spans);
  if (!clock)
    return {
      startedAt: null,
      pausedAt: null,
      pausedMs: 0,
      landingStartedAt: null,
      landedAt: null,
      agentMs,
      idleMs: 0,
    };
  const running = runningSpans(clock, now);
  return {
    startedAt: clock.startedAt,
    pausedAt: clock.pausedAt,
    pausedMs: length(clock.pauses),
    landingStartedAt: clock.landingStartedAt,
    landedAt: clock.landedAt,
    agentMs,
    idleMs: Math.max(0, length(running) - overlap(running, union(spans))),
  };
}

/** The stretches the clock ran: from its start to its open stop (or now), minus closed stops. */
function runningSpans(clock: EpicClock, now: number): Span[] {
  const end = Math.min(clock.pausedAt ?? now, now);
  const out: Span[] = [];
  let from = clock.startedAt;
  for (const [a, b] of [...clock.pauses].sort((x, y) => x[0] - y[0])) {
    if (a > from) out.push([from, Math.min(a, end)]);
    from = Math.max(from, b);
  }
  out.push([from, end]);
  return out.filter(([a, b]) => b > a);
}

/** Merge overlapping spans into disjoint ones. */
function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Total overlap between two sets of disjoint spans. */
function overlap(xs: Span[], ys: Span[]): number {
  let ms = 0;
  for (const [a, b] of xs)
    for (const [c, d] of ys) ms += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return ms;
}

function length(spans: Span[]): number {
  return spans.reduce((ms, [a, b]) => ms + Math.max(0, b - a), 0);
}
