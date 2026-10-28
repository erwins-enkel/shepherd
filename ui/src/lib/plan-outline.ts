import { splitMarkdownSections, type MarkdownSection } from "#lib/epic-draft-outline.js";

/**
 * One table-of-contents sub-entry of a plan section: a `###` heading or a top-level numbered step.
 * `index` is its position among the section's rendered `h3`s (or top-level `ol > li`s), which is
 * how the plan panel finds the element to scroll to. `number` is the step's own Markdown number.
 */
export interface PlanStep {
  kind: "heading" | "item";
  label: string;
  index: number;
  number: number | null;
}

export interface PlanSection extends MarkdownSection {
  steps: PlanStep[];
}

export interface PlanOutline {
  /** The plan's `# ` title when it is the first line; the document renders it as its heading. */
  title: string | null;
  sections: PlanSection[];
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const TITLE_RE = /^\s{0,3}#\s+(.+?)(?:\s+#+)?\s*$/;
const H3_RE = /^\s{0,3}###\s+(.+?)(?:\s+#+)?\s*$/;
// Column 0 only: an indented number is a nested list, which the panel cannot address by index.
const STEP_RE = /^(\d{1,9})[.)]\s+(.*)$/;
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
// The reviewer is told to head its non-blocking section exactly `Suggestions (non-blocking):`
// (src/plan-gate.ts → findingsRoutingBlock); tolerate the heading/bold wrappers and a German
// rendering of it.
const NOTES_HEAD_RE =
  /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)?(?:suggestions \(non-blocking\)|(?:vorschläge|hinweise) \(nicht blockierend\))\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;

/** Each line paired with whether it sits inside a fenced code block (fence lines included). */
function fenced(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return true;
    }
    if (marker) fence = marker;
    return marker !== undefined;
  });
}

/** Heading/step text as a plain label: the first bold run if any, else the text minus markup. */
function plainLabel(text: string): string {
  const bold = /\*\*(.+?)\*\*|__(.+?)__/.exec(text);
  const raw = bold ? (bold[1] ?? bold[2]) : text;
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`|\*+|__/g, "")
    .replace(/[\s:–—-]+$/, "")
    .trim();
}

function stepsOf(body: string): PlanStep[] {
  const lines = body.split(/\r?\n/);
  const inFence = fenced(lines);
  const headings: PlanStep[] = [];
  const items: PlanStep[] = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const h = H3_RE.exec(line);
    if (h) {
      headings.push({
        kind: "heading",
        label: plainLabel(h[1]),
        index: headings.length,
        number: null,
      });
      return;
    }
    const s = STEP_RE.exec(line);
    if (s)
      items.push({
        kind: "item",
        label: plainLabel(s[2]),
        index: items.length,
        number: Number(s[1]),
      });
  });
  return headings.length > 0 ? headings : items;
}

/**
 * Outline of a `.shepherd-plan.md` for the plan panel's table of contents: its title, its `#`/`##`
 * sections (splitMarkdownSections) and per section the `###` headings — or, when it has none, its
 * top-level numbered steps.
 */
export function planOutline(markdown: string): PlanOutline {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  const heading = first >= 0 ? TITLE_RE.exec(lines[first]) : null;
  const rest = heading ? lines.filter((_, i) => i !== first).join("\n") : markdown;
  return {
    title: heading ? heading[1] : null,
    sections: splitMarkdownSections(rest).map((s) => ({ ...s, steps: stepsOf(s.body) })),
  };
}

/**
 * The element a table-of-contents anchor points at inside `root`: `[data-anchor]` for a whole part,
 * and for a step anchor (`part-<i>-<j>`) step j's `h3` or top-level `li` within part i. A step the
 * rendered Markdown does not line up with falls back to its part.
 */
export function planAnchorTarget(
  root: ParentNode,
  anchor: string,
  outline: PlanOutline,
): HTMLElement | null {
  const step = /^part-(\d+)-(\d+)$/.exec(anchor);
  if (!step) return root.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
  const part = root.querySelector<HTMLElement>(`[data-anchor="part-${step[1]}"]`);
  const index = Number(step[2]);
  const kind = outline.sections[Number(step[1])]?.steps[index]?.kind;
  const selector = kind === "heading" ? ".md-body > h3" : ".md-body > ol > li";
  return part?.querySelectorAll<HTMLElement>(selector)[index] ?? part;
}

/**
 * Split the reviewer's `Suggestions (non-blocking):` list out of its write-up so the verdict card
 * can show the items on their own. `rest` is the write-up without that section. A body without
 * the section — or whose section is prose rather than a list — comes back whole, with no notes.
 */
export function splitReviewerNotes(body: string): { notes: string[]; rest: string } {
  const lines = body.split(/\r?\n/);
  const inFence = fenced(lines);
  const head = lines.findIndex((l, i) => !inFence[i] && NOTES_HEAD_RE.test(l));
  if (head < 0) return { notes: [], rest: body };
  const notes: string[] = [];
  let end = head + 1;
  for (let j = head + 1; j < lines.length; j++) {
    const line = lines[j];
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      notes.push(item[1].trim());
      end = j + 1;
    } else if (line.trim() === "") {
      // A blank line inside a loose list; the section ends where the list does.
      if (notes.length > 0 && !LIST_ITEM_RE.test(lines.slice(j + 1).find((l) => l.trim()) ?? ""))
        break;
    } else if (/^\s+\S/.test(line) && notes.length > 0) {
      notes[notes.length - 1] += ` ${line.trim()}`;
      end = j + 1;
    } else break;
  }
  if (notes.length === 0) return { notes: [], rest: body };
  const rest = [...lines.slice(0, head), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { notes, rest };
}
