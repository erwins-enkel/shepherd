import { glossaryById } from "./glossary";

export type TextSegment = { t: "text"; value: string };
export type TermSegment = { t: "term"; id: string; label: string };
export type GlossarySegment = TextSegment | TermSegment;

const MARKER_RE = /\[\[([a-z0-9-]+)\|([^\]]+)\]\]/g;

/**
 * Parse a string containing `[[id|Label]]` markers into an ordered array of
 * text and term segments.  Surrounding whitespace and punctuation are preserved
 * as text segments.
 *
 * Fail-soft: if an `id` has no entry in the glossary registry, the marker is
 * emitted as a plain text segment containing the visible label — the UI never
 * goes blank due to a stale or unknown marker.
 *
 * Pure / SSR-safe — no DOM, no Svelte.
 */
export function parseGlossary(text: string): GlossarySegment[] {
  const segments: GlossarySegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MARKER_RE)) {
    const matchStart = match.index;
    const id = match[1];
    const label = match[2];

    // Emit any text before this marker.
    if (matchStart > lastIndex) {
      segments.push({ t: "text", value: text.slice(lastIndex, matchStart) });
    }

    if (glossaryById.has(id)) {
      segments.push({ t: "term", id, label });
    } else {
      // Unknown id — degrade gracefully to plain text using the visible label.
      segments.push({ t: "text", value: label });
    }

    lastIndex = matchStart + match[0].length;
  }

  // Emit any trailing text after the last marker.
  if (lastIndex < text.length) {
    segments.push({ t: "text", value: text.slice(lastIndex) });
  }

  return segments;
}
