import type { EpicDraftChild } from "#lib/types.js";

/** One heading-delimited part of a Markdown body. `title` is null for text before the first heading. */
export interface MarkdownSection {
  title: string | null;
  body: string;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,2}\s+(.+?)(?:\s+#+)?\s*$/;

/**
 * Split a Markdown body at its `#`/`##` headings so the epic-draft review can give each part an
 * anchor and a table-of-contents entry. Deeper headings stay inside their section, and heading-like
 * lines inside fenced code are not headings.
 */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let title: string | null = null;
  let lines: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const body = lines.join("\n").trim();
    if (title !== null || body) sections.push({ title, body });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      lines.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      lines.push(line);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      title = heading[1];
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/**
 * Wave of each child (1-based): one more than the longest chain of blockers in front of it, so
 * children sharing a wave can run in parallel. Blocker keys outside the draft are ignored; the
 * server rejects cyclic drafts, the visiting guard only keeps a malformed one from recursing forever.
 */
export function childWaves(children: EpicDraftChild[]): Map<string, number> {
  const byKey = new Map(children.map((c) => [c.key, c]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (key: string): number => {
    const known = waves.get(key);
    if (known !== undefined) return known;
    const child = byKey.get(key);
    if (!child || visiting.has(key)) return 0;
    visiting.add(key);
    const wave = 1 + Math.max(0, ...child.blockedBy.map(visit));
    visiting.delete(key);
    waves.set(key, wave);
    return wave;
  };
  for (const c of children) visit(c.key);
  return waves;
}
