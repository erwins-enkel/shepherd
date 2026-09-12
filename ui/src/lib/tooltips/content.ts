/**
 * Explanatory tooltips need a title, a short summary and labelled sections.
 * Keep one idea per section; use plain strings only for short action/status labels.
 * See CLAUDE.md and the live /design-system examples before adding tooltip copy.
 * All fields are localized plain text, never HTML or Markdown.
 */
export interface TooltipExplanation {
  title: string;
  summary: string;
  sections: readonly { label: string; text: string }[];
}

export type TooltipContent = string | TooltipExplanation;

export function tooltipText(content: TooltipContent): string {
  if (typeof content === "string") return content;
  return [
    content.title,
    content.summary,
    ...content.sections.map(({ label, text }) => `${label}: ${text}`),
  ].join("\n\n");
}
