import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertContainedFile,
  parseRoot,
  slugFor,
  extractHeadings,
  keywordsOf,
  fmValue,
  splitFrontmatter,
  prettierModuleSpecifier,
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

describe("gen-docs-manifest — prettierModuleSpecifier", () => {
  it("defaults to the bare specifier so humans and CI resolve the installed prettier", () => {
    expect(prettierModuleSpecifier({})).toBe("prettier");
  });

  it("honours SHEPHERD_PRETTIER_MODULE so a caller with no node_modules can pin a prettier", () => {
    expect(
      prettierModuleSpecifier({ SHEPHERD_PRETTIER_MODULE: "/srv/node_modules/prettier/index.mjs" }),
    ).toBe("/srv/node_modules/prettier/index.mjs");
  });

  it("falls back to the bare specifier when the override is set but empty", () => {
    expect(prettierModuleSpecifier({ SHEPHERD_PRETTIER_MODULE: "" })).toBe("prettier");
  });
});

describe("gen-docs-manifest — --root", () => {
  it("defaults to the fallback root and resolves an explicit --root", () => {
    expect(parseRoot(["bun", "x.ts", "--check"], "/own")).toBe("/own");
    expect(parseRoot(["bun", "x.ts", "--root", "wt"], "/own")).toBe(resolve("wt"));
  });

  it("rejects --root without a directory", () => {
    expect(() => parseRoot(["--root"])).toThrow();
    expect(() => parseRoot(["--root", "--check"])).toThrow();
  });
});

describe("gen-docs-manifest — assertContainedFile", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gdm-root-"));
    outside = mkdtempSync(join(tmpdir(), "gdm-out-"));
    writeFileSync(join(outside, "secret.md"), "x");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "ok.md"), "x");
    symlinkSync(join(outside, "secret.md"), join(root, "docs", "link.md"));
    symlinkSync(outside, join(root, "escape"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a regular file and a not-yet-existing file inside root", () => {
    expect(() => assertContainedFile(root, join(root, "docs", "ok.md"))).not.toThrow();
    expect(() => assertContainedFile(root, join(root, "docs", "new.ts"))).not.toThrow();
  });

  it("refuses a symlinked file", () => {
    expect(() => assertContainedFile(root, join(root, "docs", "link.md"))).toThrow();
  });

  it("refuses a path whose parent resolves outside root", () => {
    expect(() => assertContainedFile(root, join(root, "escape", "secret.md"))).toThrow();
  });
});
