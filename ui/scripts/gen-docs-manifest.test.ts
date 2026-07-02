import { describe, it, expect } from "vitest";
import {
  slugFor,
  extractHeadings,
  keywordsOf,
  fmValue,
  splitFrontmatter,
} from "./gen-docs-manifest";

describe("gen-docs-manifest — slugFor", () => {
  it("maps a top-level page to a trailing-slash root path", () => {
    expect(slugFor("getting-started.md")).toBe("/getting-started/");
  });

  it("maps a nested page preserving its folders", () => {
    expect(slugFor("reference/cli/session.md")).toBe("/reference/cli/session/");
  });

  it("collapses a folder index to the folder root", () => {
    expect(slugFor("reference/cli/index.md")).toBe("/reference/cli/");
  });

  it("lowercases and handles .mdx", () => {
    expect(slugFor("Reference/Foo.mdx")).toBe("/reference/foo/");
  });
});

describe("gen-docs-manifest — frontmatter + headings", () => {
  it("splits frontmatter from body, and returns whole body when absent", () => {
    expect(splitFrontmatter("---\ntitle: X\n---\n\nbody").body.trim()).toBe("body");
    expect(splitFrontmatter("# H1\nbody").fm).toBe("");
  });

  it("reads and unquotes scalar frontmatter values", () => {
    const fm = 'title: "herdr session"\ndraft: true';
    expect(fmValue(fm, "title")).toBe("herdr session");
    expect(fmValue(fm, "draft")).toBe("true");
    expect(fmValue(fm, "missing")).toBeUndefined();
  });

  it("extracts H2/H3 headings only, stripping inline-code backticks", () => {
    const body = "# Title\n## First\ntext\n### `herdr status`\n#### too deep";
    expect(extractHeadings(body)).toEqual(["First", "herdr status"]);
  });
});

describe("gen-docs-manifest — keywordsOf", () => {
  it("joins description + headings into a lowercased, collapsed haystack", () => {
    expect(keywordsOf("Sandbox and egress.", ["Egress firewall", "See also"])).toBe(
      "sandbox and egress. egress firewall see also",
    );
  });

  it("drops empty parts", () => {
    expect(keywordsOf("", ["Only heading"])).toBe("only heading");
  });
});
