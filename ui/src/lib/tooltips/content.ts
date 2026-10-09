/**
 * Explanatory tooltips need a title, a short summary and labelled sections.
 * Keep one idea per section; use plain strings only for short action/status labels.
 * See CLAUDE.md and the live /design-system examples before adding tooltip copy.
 * All fields are localized plain text, never HTML or Markdown.
 */
export interface TooltipExplanation {
  title: string;
  summary: string;
  /** A strip under the summary that lays spans out over time (an epic's steps). */
  timeline?: TooltipTimeline;
  sections: readonly TooltipSection[];
  /** Quiet closing lines under a rule: what this is about, a clock, what a click does. */
  footer?: readonly string[];
}

/** One labelled section: one idea. `rows` lists genuinely parallel items under it (checks,
 *  events, outcomes) — each a short line with an optional right-aligned aside (a time, a
 *  duration) and a status mark. `text` may be empty when the rows say it all. */
export interface TooltipSection {
  label: string;
  text: string;
  rows?: readonly TooltipRow[];
  /** A muted line after the rows: what they rest on. */
  note?: string;
  /** Span every column of a wide panel — for rows that need the width (a list of titles). */
  full?: boolean;
}

/** `tone` picks the row's mark: ok ✓, run ◷, fail ✕, warn !, idle ·. The text carries the
 *  meaning; the mark only reinforces it. */
export interface TooltipRow {
  text: string;
  aside?: string;
  tone?: "ok" | "run" | "fail" | "warn" | "idle";
  /** A small step meter before the aside (e.g. confidence, 1 of 3); the aside's word carries
   *  the meaning. */
  meter?: { value: number; max: number };
}

/** done slate · run amber · landing blue · pause hatched · unknown dotted. */
export type TooltipSegmentTone = "done" | "run" | "landing" | "pause" | "unknown";

/** One span on a {@link TooltipTimeline}; `from`/`to` are fractions of the strip (0–1).
 *  `projected`: not yet happened — a dashed outline instead of a fill. */
export interface TooltipSegment {
  from: number;
  to: number;
  tone: TooltipSegmentTone;
  projected?: boolean;
}

/** A proportional strip over time. The words carry the meaning — the edge labels, the now
 *  label and a legend entry per kind of span drawn — so hue never stands alone. */
export interface TooltipTimeline {
  segments: readonly TooltipSegment[];
  /** Left and right edge labels (a start time, a projected finish or "?"). */
  start: string;
  end: string;
  /** The now marker; absent when the clock stands. */
  now?: { at: number; label: string };
  legend: readonly { tone: TooltipSegmentTone; projected?: boolean; label: string }[];
}

export type TooltipContent = string | TooltipExplanation;

export function tooltipText(content: TooltipContent): string {
  if (typeof content === "string") return content;
  const strip = content.timeline;
  return [
    content.title,
    content.summary,
    ...(strip ? [[strip.start, strip.now?.label, strip.end].filter(Boolean).join(" → ")] : []),
    ...content.sections.map(({ label, text, rows, note }) =>
      [
        text ? `${label}: ${text}` : `${label}:`,
        ...(rows ?? []).map((r) => `- ${r.text}${r.aside ? ` (${r.aside})` : ""}`),
        ...(note ? [note] : []),
      ].join("\n"),
    ),
    ...(content.footer?.length ? [content.footer.join("\n")] : []),
  ].join("\n\n");
}
