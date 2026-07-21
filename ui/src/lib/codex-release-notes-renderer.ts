const GITHUB_REPO_BASE = "https://github.com/openai/codex/";
const GITHUB_ORIGIN = "https://github.com";
const RAW_TAGS = new Set([
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
  "del",
  "a",
  "details",
  "summary",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
const NON_VISIBLE_TAGS = new Set(["script", "style", "template"]);
const ALLOWED_TAGS = [...RAW_TAGS];
const ALLOWED_ATTR = ["href", "title", "open"];

interface MarkdownParser {
  parseInline(tokens: unknown[]): string;
}

interface MarkdownRenderer {
  image(token: { text: string }): string;
  html(token: { text: string }): string;
  link(
    this: { parser: MarkdownParser },
    token: { href: string; title?: string | null; tokens: unknown[] },
  ): string;
}

interface RendererModules {
  Marked: new (extension: { renderer: MarkdownRenderer }) => {
    parse(source: string, options: { async: false }): string;
  };
  DOMPurify: {
    sanitize(
      source: string,
      options: {
        ALLOWED_TAGS: string[];
        ALLOWED_ATTR: string[];
        ALLOW_DATA_ATTR: false;
        ALLOW_ARIA_ATTR: false;
      },
    ): string;
  };
}

export interface CodexReleaseRendererOptions {
  load?: () => Promise<RendererModules>;
  beforeSanitize?: (html: string) => void;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

interface RawTag {
  closing: boolean;
  name: string;
  attributes: string;
}

interface RawToken {
  text: string;
  tag: RawTag | null;
  next: number;
  terminal: boolean;
}

function parseRawTag(source: string): RawTag | null {
  const match = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)([\s\S]*?)\/?\s*>$/.exec(source);
  if (!match) return null;
  return {
    closing: match[1] === "/",
    name: match[2]!.toLowerCase(),
    attributes: match[3]!.trim(),
  };
}

function projectedTag(tag: RawTag): string {
  if (!RAW_TAGS.has(tag.name)) return "";
  if (tag.closing) return `</${tag.name}>`;
  if (tag.name === "br" || tag.name === "hr") return `<${tag.name}>`;
  if (tag.name === "details" && /(?:^|\s)open(?=\s|$)/.test(tag.attributes)) {
    return "<details open>";
  }
  return `<${tag.name}>`;
}

function nextRawToken(source: string, cursor: number): RawToken {
  const open = source.indexOf("<", cursor);
  if (open === -1) {
    return { text: source.slice(cursor), tag: null, next: source.length, terminal: true };
  }
  const text = source.slice(cursor, open);
  if (source.startsWith("<!--", open)) {
    const close = source.indexOf("-->", open + 4);
    return {
      text,
      tag: null,
      next: close === -1 ? source.length : close + 3,
      terminal: close === -1,
    };
  }
  const end = tagEnd(source, open);
  if (end === -1) return { text, tag: null, next: source.length, terminal: true };
  return {
    text,
    tag: parseRawTag(source.slice(open, end + 1)),
    next: end + 1,
    terminal: false,
  };
}

function projectRawTag(
  tag: RawTag,
  hidden: string | null,
): { html: string; hidden: string | null } {
  if (hidden) {
    return { html: "", hidden: tag.closing && tag.name === hidden ? null : hidden };
  }
  if (!tag.closing && NON_VISIBLE_TAGS.has(tag.name)) {
    return { html: "", hidden: tag.name };
  }
  return { html: projectedTag(tag), hidden: null };
}

/** Project raw HTML without ever handing its attributes or media URLs to a DOM parser. */
function projectCodexRawHtml(source: string): string {
  let output = "";
  let cursor = 0;
  let hidden: string | null = null;
  while (cursor < source.length) {
    const token = nextRawToken(source, cursor);
    if (!hidden) output += token.text.replaceAll("<", "&lt;");
    cursor = token.next;
    if (token.tag) {
      const projected = projectRawTag(token.tag, hidden);
      output += projected.html;
      hidden = projected.hidden;
    }
    if (token.terminal) break;
  }
  return output;
}

function normalizeCodexReleaseHref(rawHref: string, version: string): string | null {
  const href = rawHref.trim();
  const hasControlCharacter = [...href].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!href || hasControlCharacter || href.startsWith("//")) return null;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href)) {
    try {
      const url = new URL(href);
      if (!new Set(["http:", "https:", "mailto:"]).has(url.protocol)) return null;
      if (url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }
  try {
    if (href.startsWith("#")) {
      return new URL(href, `${GITHUB_REPO_BASE}releases/tag/rust-v${encodeURIComponent(version)}`)
        .href;
    }
    if (href.startsWith("/")) return new URL(href, GITHUB_ORIGIN).href;
    return new URL(href, GITHUB_REPO_BASE).href;
  } catch {
    return null;
  }
}

async function defaultLoad(): Promise<RendererModules> {
  const [{ Marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);
  return { Marked, DOMPurify };
}

export async function renderCodexReleaseMarkdown(
  body: string,
  version: string,
  options: CodexReleaseRendererOptions = {},
): Promise<string> {
  const { Marked, DOMPurify } = await (options.load ?? defaultLoad)();
  const marked = new Marked({
    renderer: {
      image({ text }) {
        return escapeHtml(text);
      },
      html({ text }) {
        return projectCodexRawHtml(text);
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const normalized = normalizeCodexReleaseHref(href, version);
        if (!normalized) return label;
        const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(normalized)}"${safeTitle}>${label}</a>`;
      },
    },
  });
  const beforeSanitize = marked.parse(body, { async: false }) as string;
  options.beforeSanitize?.(beforeSanitize);
  const sanitized = DOMPurify.sanitize(beforeSanitize, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  return sanitized.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
}
