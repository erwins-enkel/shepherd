import { beforeAll, describe, expect, it } from "vitest";
import { sanitizeAgentHtml } from "./agent-markdown";

// marked/DOMPurify may only be imported dynamically in ui/src (eslint no-restricted-imports).
let DOMPurify: (typeof import("dompurify"))["default"];
let marked: (typeof import("marked"))["marked"];
beforeAll(async () => {
  ({ default: DOMPurify } = await import("dompurify"));
  ({ marked } = await import("marked"));
});

/** Parse sanitizer output into a detached container so tests can query it like the DOM it becomes. */
function dom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("sanitizeAgentHtml", () => {
  // Every one of these is a passive-load, phishing or CSS-tracking carrier that DOMPurify's
  // default allow-list lets through.
  const carriers: Array<[name: string, html: string, selector: string]> = [
    ["img", '<img src="https://evil.example/p.png">', "img"],
    ["svg image", '<svg><image href="https://evil.example/p.png"></image></svg>', "svg, image"],
    [
      "svg feImage",
      '<svg><filter><feImage href="https://evil.example/p.png"/></filter></svg>',
      "svg",
    ],
    [
      "video poster",
      '<video poster="https://evil.example/p.png" src="https://evil.example/v"></video>',
      "video",
    ],
    ["audio", '<audio src="https://evil.example/a"></audio>', "audio"],
    [
      "picture/source",
      '<picture><source srcset="https://evil.example/p.png"></picture>',
      "picture, source",
    ],
    ["form", '<form action="https://evil.example/"><input name="pw"></form>', "form, input"],
    ["button", "<button>Sign in</button>", "button"],
    ["textarea", "<textarea>x</textarea>", "textarea"],
    ["select", "<select><option>x</option></select>", "select, option"],
    ["style element", "<style>a{background:url(https://evil.example/p.png)}</style>", "style"],
    ["script", "<script>window.__x = 1</script>", "script"],
    ["math", "<math><mi>x</mi></math>", "math"],
    ["iframe", '<iframe src="https://evil.example/"></iframe>', "iframe"],
    ["text input", '<input type="text" name="user">', "input"],
    ["password input", '<input type="password">', "input"],
    ["image input", '<input type="image" src="https://evil.example/p.png">', "input"],
    ["untyped input", "<input>", "input"],
  ];

  it.each(carriers)("removes %s", (_name, html, selector) => {
    const out = sanitizeAgentHtml(DOMPurify, `<p>keep</p>${html}`);
    expect(dom(out).querySelector(selector), out).toBeNull();
    expect(dom(out).querySelector("p")?.textContent).toBe("keep");
  });

  it("strips style attributes and event handlers but keeps the element", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      '<p style="background:url(https://evil.example/p.png)" onclick="x()" data-x="1" aria-label="y">hi</p>',
    );
    const p = dom(out).querySelector("p")!;
    expect(p.textContent).toBe("hi");
    expect([...p.attributes].map((a) => a.name)).toEqual([]);
  });

  it("drops markdown images", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      marked.parse("before ![alt](https://evil.example/p.png) after", { async: false }) as string,
    );
    expect(dom(out).querySelector("img")).toBeNull();
    expect(out).not.toContain("evil.example");
  });

  it("removes javascript: and data: hrefs", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      '<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a>',
    );
    for (const a of dom(out).querySelectorAll("a")) expect(a.getAttribute("href")).toBeNull();
  });

  it("keeps ordinary rendered markdown intact", () => {
    const md = [
      "# Title",
      "",
      "Some **bold**, _em_, ~~gone~~ and `code`.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "",
      "> quote",
      "",
      "| a | b |",
      "|:--|--:|",
      "| 1 | 2 |",
      "",
      "```diff\n+added\n-removed\n```",
      "",
      "<details open><summary>more</summary>body <kbd>Esc</kbd> H<sub>2</sub>O</details>",
    ].join("\n");
    const root = dom(sanitizeAgentHtml(DOMPurify, marked.parse(md, { async: false }) as string));
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("em");
    expect(root.querySelector("del")?.textContent).toBe("gone");
    expect(root.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root.querySelectorAll("ol > li")).toHaveLength(1);
    expect(root.querySelector("blockquote")).not.toBeNull();
    expect(root.querySelectorAll("table th")).toHaveLength(2);
    expect(root.querySelector("th")?.getAttribute("align")).toBe("left");
    expect(root.querySelector("pre > code.language-diff")).not.toBeNull();
    expect(root.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(root.querySelector("summary + *, summary")?.textContent).toBe("more");
    expect(root.querySelector("kbd")?.textContent).toBe("Esc");
    expect(root.querySelector("sub")?.textContent).toBe("2");
  });

  it("forces links to open out-of-app", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      '<a href="https://example.com/x" target="_self" rel="opener">x</a>',
    );
    const a = dom(out).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps GFM task-list checkboxes as disabled checkboxes", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      marked.parse("- [x] done\n- [ ] todo", { async: false }) as string,
    );
    const boxes = [...dom(out).querySelectorAll("li > input")] as HTMLInputElement[];
    expect(boxes.map((b) => [b.type, b.checked, b.disabled])).toEqual([
      ["checkbox", true, true],
      ["checkbox", false, true],
    ]);
  });

  it("forces a smuggled checkbox disabled and removes its extra attributes", () => {
    const out = sanitizeAgentHtml(DOMPurify, '<input type="checkbox" name="x" form="f" src="u">');
    const box = dom(out).querySelector("input")!;
    expect(box.disabled).toBe(true);
    expect(box.hasAttribute("form")).toBe(false);
    expect(box.hasAttribute("src")).toBe(false);
    expect(box.hasAttribute("name")).toBe(false);
  });

  it("removes a non-checkbox input without disturbing its siblings", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      '<p>a</p><input type="text"><p>b</p><input type="checkbox"><p>c</p>',
    );
    const root = dom(out);
    expect([...root.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["a", "b", "c"]);
    expect(root.querySelectorAll("input")).toHaveLength(1);
  });

  it("limits class to language-* tokens", () => {
    const out = sanitizeAgentHtml(
      DOMPurify,
      '<pre class="fixed inset-0 language-ts"><code class="overlay">x</code></pre>',
    );
    const root = dom(out);
    expect(root.querySelector("pre")?.getAttribute("class")).toBe("language-ts");
    expect(root.querySelector("code")?.hasAttribute("class")).toBe(false);
  });

  it("returns a sanitized DocumentFragment with { fragment: true }", () => {
    const frag = sanitizeAgentHtml(
      DOMPurify,
      '<p>x</p><img src="https://evil.example/p.png"><a href="/y">y</a>',
      {
        fragment: true,
      },
    );
    expect(frag).toBeInstanceOf(DocumentFragment);
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.querySelector("p")?.textContent).toBe("x");
    expect(frag.querySelector("a")?.getAttribute("target")).toBe("_blank");
  });

  it("does not leak its hook onto the shared DOMPurify singleton", () => {
    sanitizeAgentHtml(DOMPurify, '<a href="https://example.com/">x</a>');
    const plain = DOMPurify.sanitize('<a href="https://example.com/">x</a>');
    expect(plain).not.toContain("target=");
    expect(plain).not.toContain("rel=");
  });

  it("is stable across repeated calls", () => {
    const html = '<a href="https://example.com/">x</a><input type="checkbox">';
    expect(sanitizeAgentHtml(DOMPurify, html)).toBe(sanitizeAgentHtml(DOMPurify, html));
  });
});
