// Split plain text into runs and bare http(s) URLs so a view can render the URLs as links — an
// agent's question names an artifact or PR the operator wants to open, not copy. Pure, like
// desigLinks.ts; native/Sources/ShepherdAppCore/Plan/TextLinks.swift applies the same rule.

export interface TextSegment {
  text: string;
  /** Set on a link segment: the URL, exactly as written in the text. */
  href?: string;
}

// A scheme at a word start, then everything up to whitespace or a char that can't sit in a bare URL.
const CANDIDATE = /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"`]+/giu;
// Sentence punctuation and quotes after a URL belong to the prose, not the link.
const TRAILING = ".,;:!?'\"…“”‘’»«";
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (s: string, c: string) => s.split(c).length - 1;

/** Drop trailing punctuation, and a closing bracket the URL never opened (`(https://x.dev)`). */
function trimTrailing(url: string): string {
  for (;;) {
    const last = url.at(-1) ?? "";
    const opener = OPENER[last];
    if ((last && TRAILING.includes(last)) || (opener && count(url, last) > count(url, opener))) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

/** `text` as an ordered run of plain and link segments; their texts join back to `text`. */
export function linkSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const url = trimTrailing(match[0]);
    if (url.length <= url.indexOf("://") + 3) continue;
    if (match.index > at) segments.push({ text: text.slice(at, match.index) });
    segments.push({ text: url, href: url });
    at = match.index + url.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}
