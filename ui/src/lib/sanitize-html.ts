import { firstSafeHttpUrl } from "./url";

// A type query, not an import: marked/dompurify must stay dynamic (eslint no-restricted-imports).
type Purifier = (typeof import("dompurify"))["default"];

/**
 * The one sanitizer for untrusted markup the HUD injects with `{@html}` (#2099, #2104): Markdown
 * written by agents (plans, recaps, critic bodies, plan blocks) or forge authors (issue bodies,
 * release notes), and Mermaid SVG rendered from agent source.
 *
 * DOMPurify's defaults keep `<img src=https://…>` (a silent beacon that leaks data and the
 * operator's IP, and lets an autonomous agent route around its egress allowlist), `<form action>`
 * and `style=` (in-app phishing / overlays). This config drops those; the app CSP
 * (src/security-headers.ts) is the backstop.
 *
 * Both purifiers are dedicated instances, so their hooks never touch the shared `dompurify`
 * singleton. marked + DOMPurify load lazily on first use, off the first-paint critical path —
 * callers run these from `$effect`, never during SSR.
 */

const MARKDOWN_CONFIG = {
  // Media/SVG/MathML would be further fetch paths (`<video poster>`, `<svg><image href>`).
  FORBID_TAGS: [
    ...["form", "button", "textarea", "select", "option", "style"],
    ...["svg", "math", "audio", "video", "source", "track", "picture"],
  ],
  // srcset/background/poster: more fetch-capable attributes. `data-session-id` marks only the
  // session links MarkdownBody generates, never the source.
  FORBID_ATTR: ["style", "srcset", "background", "poster", "data-session-id"],
  // DOMPurify's own pattern minus tel:/sms:/cid:/xmpp:/callto: — http(s), mailto and relative.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

type Markdown = { parse(src: string, breaks: boolean): string; purify: Purifier };
let markdown: Promise<Markdown> | null = null;

function loadMarkdown(): Promise<Markdown> {
  markdown ??= Promise.all([import("marked"), import("dompurify")]).then(
    ([{ marked }, { default: DOMPurify }]) => {
      const purify = DOMPurify(window);
      // Links in agent/forge text point off-app; following one in place would navigate the HUD away.
      purify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName !== "A") return;
        const href = node.getAttribute("href");
        if (href === null || href.startsWith("#")) return;
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      });
      return {
        parse: (src, breaks) => marked.parse(src, { async: false, breaks }) as string,
        purify,
      };
    },
  );
  return markdown;
}

/** An image the browser may load without contacting a third party. */
function isLocalImage(src: string): boolean {
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** Swap each external `<img>` for a link to it (or bare text if the URL isn't http(s)). Every
 *  node added here is created locally and filled via textContent/setAttribute. */
function defuseExternalImages(root: DocumentFragment): void {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (isLocalImage(src)) continue;
    const label = img.getAttribute("alt") || src;
    let href: string | null = null;
    try {
      href = firstSafeHttpUrl(new URL(src, location.href).href); // resolves `//host/x`
    } catch {
      // unparseable — label only
    }
    if (href === null) {
      img.replaceWith(document.createTextNode(label));
      continue;
    }
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    img.replaceWith(a);
  }
  // GFM task lists render `<input type="checkbox" disabled>`; keep only those, inert.
  for (const input of root.querySelectorAll("input")) {
    if (input.type === "checkbox") input.disabled = true;
    else input.remove();
  }
}

/** Markdown → sanitized HTML string, ready for `{@html}`. `breaks`: a single newline is a line
 *  break (GitHub issue/comment semantics). */
export async function renderMarkdown(md: string, { breaks = false } = {}): Promise<string> {
  const { parse, purify } = await loadMarkdown();
  const fragment = purify.sanitize(parse(md, breaks), {
    ...MARKDOWN_CONFIG,
    RETURN_DOM_FRAGMENT: true,
  });
  defuseExternalImages(fragment);
  const host = document.createElement("div");
  host.append(fragment);
  return host.innerHTML;
}

/** Drop `@import` and every `url(…)` (closed or not — CSS accepts one unterminated at EOF) that
 *  isn't a same-document `#ref`. CSS resolves escapes
 *  before tokenizing (`ur\l(`, `\75 rl(`, `@\69mport`), which no pattern here can see — so CSS
 *  containing any backslash is dropped whole (null) rather than matched. */
function localCss(css: string): string | null {
  if (css.includes("\\")) return null;
  return css.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(?!['"]?#)[^)]*\)?/gi, "none");
}

let svgPurifier: Promise<Purifier> | null = null;

function loadSvgPurifier(): Promise<Purifier> {
  svgPurifier ??= import("dompurify").then(({ default: DOMPurify }) => {
    const purify = DOMPurify(window);
    // A diagram may reference its own defs (`#marker`), never an outside document or URL —
    // neither via href nor via CSS (`%%{init: {themeCSS}}%%` is agent-controlled), including CSS
    // values in `style` and presentation attributes (`fill="url(…)"`, `cursor`, `filter`).
    purify.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style") node.textContent = localCss(node.textContent ?? "") ?? "";
    });
    purify.addHook("afterSanitizeAttributes", (node) => {
      for (const attr of ["href", "xlink:href"]) {
        const v = node.getAttribute(attr);
        if (v !== null && !v.startsWith("#")) node.removeAttribute(attr);
      }
      for (const { name, value } of [...node.attributes]) {
        if (!value.includes("\\") && !/url\(/i.test(value)) continue;
        const css = localCss(value);
        if (css === null) node.removeAttribute(name);
        else node.setAttribute(name, css);
      }
    });
    return purify;
  });
  return svgPurifier;
}

/** Mermaid SVG → sanitized SVG string (#2104). Mermaid's `securityLevel: "strict"` stays the first
 *  layer; this is defense in depth. HTML labels live in `<foreignObject>`, so it, the HTML profile
 *  and foreignObject as an HTML integration point are allowed. */
export async function sanitizeSvg(svg: string): Promise<string> {
  const purify = await loadSvgPurifier();
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    // Form controls, plus the media/image elements the HTML profile would admit inside a
    // foreignObject — each a fetch path (`<video src>`, `<img src>`), as in MARKDOWN_CONFIG.
    FORBID_TAGS: [
      ...["form", "button", "textarea", "select", "option", "input"],
      ...["img", "audio", "video", "source", "track", "picture"],
    ],
    FORBID_ATTR: ["srcset", "background", "poster"],
  });
}
