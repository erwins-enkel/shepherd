import { test, expect } from "bun:test";
import { classify, formatOutputs } from "../scripts/ci-changes.mjs";

const ALL = { test: true, site: true, cli: true, docs_site: true };
const pr = (...files: string[]) => classify(files, { event: "pull_request" });
const flags = (r: ReturnType<typeof classify>) => ({
  test: r.test,
  site: r.site,
  cli: r.cli,
  docs_site: r.docs_site,
});

test("non-PR events run everything", () => {
  expect(flags(classify(["docs/a.md"], { event: "push" }))).toEqual(ALL);
  expect(classify(["docs/a.md"], { event: "push" }).reason).toContain("push");
});

test("empty diff runs everything", () => {
  expect(flags(pr())).toEqual(ALL);
});

test("docs-only: docs/** + root *.md skip tests, site, cli", () => {
  expect(flags(pr("docs/research/x.md", "README.md"))).toEqual({
    test: false,
    site: false,
    cli: false,
    docs_site: true,
  });
});

test("root *.md alone skips docs-site too", () => {
  expect(flags(pr("README.md", "CHANGELOG.md"))).toEqual({
    test: false,
    site: false,
    cli: false,
    docs_site: false,
  });
});

test("CLAUDE.md feeds docs-site (sync-docs renders it)", () => {
  expect(flags(pr("CLAUDE.md"))).toEqual({ test: false, site: false, cli: false, docs_site: true });
});

test("nested .md is not docs", () => {
  expect(pr("ui/src/lib/notes.md").test).toBe(true);
});

test.each([
  "package.json",
  "ui/package.json",
  "bun.lock",
  "site/bun.lock",
  "bun.lockb",
  "cli/Cargo.lock",
  "bunfig.toml",
  "tsconfig.json",
  "ui/tsconfig.app.json",
  "eslint.config.js",
  "extension/eslint.config.mjs",
  ".prettierrc",
  ".prettierignore",
  ".github/workflows/ci.yml",
  "scripts/check-cli.sh",
  "contracts/openapi.yaml",
])("global trigger %s runs everything", (file) => {
  const r = pr("docs/a.md", file);
  expect(flags(r)).toEqual(ALL);
  expect(r.reason).toContain(file);
});

test.each([
  ".husky/pre-push",
  ".claude/rules/i18n.md",
  ".env.schema",
  "agent-skills/x/SKILL.md",
  "mockup/a.html",
])("uncovered path %s runs everything", (file) => {
  const r = pr(file);
  expect(flags(r)).toEqual(ALL);
  expect(r.reason).toContain(file);
});

test("site/** runs site + tests, not cli", () => {
  expect(flags(pr("site/src/index.astro"))).toEqual({
    test: true,
    site: true,
    cli: false,
    docs_site: false,
  });
});

test("cli/** runs cli + tests, not site", () => {
  expect(flags(pr("cli/src/main.rs"))).toEqual({
    test: true,
    site: false,
    cli: true,
    docs_site: false,
  });
});

test("src/** runs tests + docs-site", () => {
  expect(flags(pr("src/server.ts"))).toEqual({
    test: true,
    site: false,
    cli: false,
    docs_site: true,
  });
});

test("docs-site/** runs tests + docs-site", () => {
  expect(flags(pr("docs-site/astro.config.mjs"))).toEqual({
    test: true,
    site: false,
    cli: false,
    docs_site: true,
  });
});

test.each([
  "test/a.test.ts",
  "ui/src/x.svelte",
  "extension/src/a.ts",
  "native/Package.swift",
  "deploy/x",
  "ci/x",
  "examples/x",
])("area %s runs tests only", (file) => {
  expect(flags(pr(file))).toEqual({ test: true, site: false, cli: false, docs_site: false });
});

test("formatOutputs writes key=value lines", () => {
  expect(formatOutputs({ test: true, site: false, cli: false, docs_site: true, reason: "x" })).toBe(
    "test=true\nsite=false\ncli=false\ndocs_site=true\n",
  );
});
