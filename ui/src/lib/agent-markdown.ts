// Type-only `import()` types: erased at build, and unlike an `import type` declaration they don't
// trip the static-import ban on dompurify (see eslint.config.js — it would hoist into the main chunk).
type DOMPurify = import("dompurify").DOMPurify;
type Config = import("dompurify").Config;

/**
 * Sanitizer for markdown an agent or forge user authored (recaps, plans, review findings, issue
 * bodies). That text is a prompt-injection carrier: DOMPurify's default allow-list lets through
 * `<img src>` (silent beacon), `<form>`/`<input>`/`<button>` (in-app phishing), `style=` (CSS
 * tracking) and the SVG/media equivalents. This is a closed allow-list of reading markup instead
 * — the same approach as `codex-release-notes-renderer.ts`.
 *
 * Callers keep their own lazy `import("dompurify")` and pass the module in, so DOMPurify stays
 * out of the main chunk.
 */

const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "kbd",
  "samp",
  "var",
  "abbr",
  "span",
  "div",
  "a",
  "details",
  "summary",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  // GFM task lists render `<input type=checkbox disabled>`; `harden` removes any other input.
  "input",
];

const ALLOWED_ATTR = [
  "href",
  "title",
  "class",
  "open",
  "align",
  "colspan",
  "rowspan",
  "start",
  "type",
  "checked",
  "disabled",
  "lang",
  "dir",
];

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
} satisfies Config;

// marked only ever emits `language-*` classes (fenced code); any other class name could
// collide with an app-global one and be used to restyle the UI now that `style=` is gone.
const SAFE_CLASS = /^language-[\w+-]+$/;

/** Runs on every element that survived tag/attribute sanitization. */
function harden(node: Element): void {
  if (node.tagName === "A") {
    // A plain link would navigate the whole SPA away; send it out-of-app.
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  } else if (node.tagName === "INPUT") {
    if (node.getAttribute("type")?.toLowerCase() !== "checkbox") {
      node.remove();
      return;
    }
    node.setAttribute("disabled", "");
  }
  const cls = node.getAttribute("class");
  if (cls !== null) {
    const kept = cls.split(/\s+/).filter((c) => SAFE_CLASS.test(c));
    if (kept.length > 0) node.setAttribute("class", kept.join(" "));
    else node.removeAttribute("class");
  }
}

// A private instance carries the hook: a hook on the shared `DOMPurify` singleton would also
// apply to every other consumer (HerdrUpdateModal, WireframeBlock, …).
let hardened: DOMPurify | null = null;
function instance(purify: DOMPurify): DOMPurify {
  if (!hardened) {
    hardened = purify(window);
    hardened.addHook("afterSanitizeAttributes", harden);
  }
  return hardened;
}

export function sanitizeAgentHtml(purify: DOMPurify, html: string): string;
export function sanitizeAgentHtml(
  purify: DOMPurify,
  html: string,
  opts: { fragment: true },
): DocumentFragment;
export function sanitizeAgentHtml(
  purify: DOMPurify,
  html: string,
  opts?: { fragment?: boolean },
): string | DocumentFragment {
  const p = instance(purify);
  return opts?.fragment
    ? p.sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: true })
    : p.sanitize(html, CONFIG);
}
