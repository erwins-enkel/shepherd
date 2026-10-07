/**
 * Explanatory tooltips need a title, a short summary and labelled sections.
 * Keep one idea per section; use plain strings only for short action/status labels.
 * See CLAUDE.md and the live /design-system examples before adding tooltip copy.
 * All fields are localized plain text, never HTML or Markdown.
 */
export interface TooltipExplanation {
  title: string;
  summary: string;
  sections: readonly TooltipSection[];
}

/** One labelled section: one idea. `rows` lists genuinely parallel items under it (checks,
 *  events, outcomes) — each a short line with an optional right-aligned aside (a time, a
 *  duration) and a status mark. `text` may be empty when the rows say it all. */
export interface TooltipSection {
  label: string;
  text: string;
  rows?: readonly TooltipRow[];
}

/** `tone` picks the row's mark: ok ✓, run ◷, fail ✕, warn !, idle ·. The text carries the
 *  meaning; the mark only reinforces it. */
export interface TooltipRow {
  text: string;
  aside?: string;
  tone?: "ok" | "run" | "fail" | "warn" | "idle";
}

export type TooltipContent = string | TooltipExplanation;

export function tooltipText(content: TooltipContent): string {
  if (typeof content === "string") return content;
  return [
    content.title,
    content.summary,
    ...content.sections.map(({ label, text, rows }) =>
      [
        text ? `${label}: ${text}` : `${label}:`,
        ...(rows ?? []).map((r) => `- ${r.text}${r.aside ? ` (${r.aside})` : ""}`),
      ].join("\n"),
    ),
  ].join("\n\n");
}
