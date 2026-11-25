import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeReadiness,
  bootstrapGuardrailChecklist,
  scanEcosystem,
  SWIFT_GUARDRAILS,
  type GuardrailId,
} from "../src/readiness";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-readiness-swift-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, body = "") {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

async function present(id: GuardrailId) {
  return (await analyzeReadiness(dir)).checks.find((c) => c.id === id)?.present ?? false;
}

test("a root Package.swift makes the repo applicable as swift", async () => {
  write("Package.swift", "// swift-tools-version: 6.2\n");
  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.ecosystem).toBe("swift");
});

test("a Package.swift one or two levels down is detected", async () => {
  write("ios/App/Package.swift");
  expect((await analyzeReadiness(dir)).ecosystem).toBe("swift");
  write("ios/Package.swift");
  expect((await analyzeReadiness(dir)).ecosystem).toBe("swift");
});

test("dependency directories are not Swift roots", async () => {
  write("Pods/Foo/Package.swift");
  write("node_modules/foo/Package.swift");
  write(".build/checkouts/Package.swift");
  expect((await analyzeReadiness(dir)).applicable).toBe(false);
});

test.each([
  ["root package.json", "package.json", "js-ts"],
  ["root Cargo.toml", "Cargo.toml", "rust"],
  ["deep package.json", "apps/web/package.json", "js-ts"],
  ["deep Cargo.toml", "crates/core/Cargo.toml", "rust"],
] as const)(
  "%s keeps its profile beside a nearer Package.swift",
  async (_name, manifest, ecosystem) => {
    write("Package.swift");
    write("ios/Package.swift");
    write(manifest, manifest.endsWith("json") ? "{}" : '[package]\nname = "x"\n');
    expect((await analyzeReadiness(dir)).ecosystem).toBe(ecosystem);
  },
);

test("the Swift guardrail set omits type_checker, lint_staged, env_schema and swallowed_errors", () => {
  const ids = SWIFT_GUARDRAILS.map((g) => g.id);
  for (const id of ["type_checker", "lint_staged", "env_schema", "swallowed_errors"] as const)
    expect(ids).not.toContain(id);
});

test("a murmur-shaped repo scores what its pre-commit hook and config prove", async () => {
  write("Package.swift");
  write(".swift-format", "{}");
  write(
    ".githooks/pre-commit",
    "swift format lint --strict -r Sources Tests\nswift test --quiet\n",
  );
  write("Tests/CoreTests/a.swift");
  for (const id of ["linter", "formatter", "test_runner", "git_hooks"] as const)
    expect(await present(id)).toBe(true);
  for (const id of ["pre_push_ci", "ci", "dead_code_audit", "agent_instructions"] as const)
    expect(await present(id)).toBe(false);
});

test("evidence comes from config files and the command corpus", async () => {
  write("Package.swift");
  expect(await present("linter")).toBe(false);
  expect(await present("formatter")).toBe(false);
  expect(await present("test_runner")).toBe(false);
  write(".swiftlint.yml");
  write(".swiftformat");
  write("Tests/a.swift");
  expect(await present("linter")).toBe(true);
  expect(await present("formatter")).toBe(true);
  expect(await present("test_runner")).toBe(true);
  write(".github/workflows/ci.yml", "steps:\n  - run: periphery scan --strict\n");
  expect(await present("dead_code_audit")).toBe(true);
  expect(await present("ci")).toBe(true);
});

test("a dependency named swift-format in Package.swift does not prove the tool runs", async () => {
  write(
    "Package.swift",
    '.package(url: "https://github.com/swiftlang/swift-format", from: "6.0.0")',
  );
  expect(await present("formatter")).toBe(false);
  expect(await present("linter")).toBe(false);
});

test("xcodebuild test counts as a test runner on one line only", async () => {
  write("Package.swift");
  write(".github/workflows/ci.yml", "run: xcodebuild -scheme App\nrun: echo test\n");
  expect(await present("test_runner")).toBe(false);
  write(".github/workflows/ci.yml", "run: xcodebuild -scheme App test\n");
  expect(await present("test_runner")).toBe(true);
});

test("a crafted one-line hook can't stall the server loop", async () => {
  write("Package.swift");
  write(".githooks/pre-push", "xcodebuild ".repeat(20_000));
  const start = performance.now();
  expect(await present("test_runner")).toBe(false);
  expect(performance.now() - start).toBeLessThan(1000);
});

test("a pre-commit-only repo has git_hooks but not pre_push_ci", async () => {
  write("Package.swift");
  write(".githooks/pre-commit", "swift test");
  expect(await present("git_hooks")).toBe(true);
  expect(await present("pre_push_ci")).toBe(false);
  write(".githooks/pre-push", "swift test");
  expect(await present("pre_push_ci")).toBe(true);
});

test("only .swift-version is a toolchain pin", async () => {
  write("Package.swift", "// swift-tools-version: 6.2\n");
  expect((await scanEcosystem(dir)).toolchainPins).toEqual([]);
  write(".swift-version", "6.4.2\n");
  const scan = await scanEcosystem(dir);
  expect(scan.ecosystem).toBe("swift");
  expect(scan.toolchainPins).toEqual([".swift-version"]);
});

const FOREIGN = /\b(?:npm|bun|bunx|husky|cargo|clippy|rustfmt|prettier|eslint|vitest)\b/;

test("the prescription names only Swift tooling", async () => {
  write("Package.swift");
  const { claudeMd } = await analyzeReadiness(dir);
  expect(claudeMd).toContain("House rules for AI agents (Swift)");
  expect(claudeMd).toContain("swift format lint --strict");
  expect(claudeMd).toContain('package-ecosystem: "swift"');
  expect(claudeMd).toContain("periphery scan");
  expect(claudeMd).not.toMatch(FOREIGN);
});

test("the bootstrap checklist covers every Swift guardrail", () => {
  const list = bootstrapGuardrailChecklist("swift", "npm");
  expect(list.split("\n").filter((l) => l.startsWith("- ")).length).toBe(SWIFT_GUARDRAILS.length);
  expect(list).not.toMatch(FOREIGN);
});

// ── lint_strictness (#4153) ──

async function strictCheck() {
  return (await analyzeReadiness(dir)).checks.find((c) => c.id === "lint_strictness");
}

test("lint_strictness is omitted when the package has no linter", async () => {
  write("Package.swift");
  write(".githooks/pre-push", "swift build --strict\n");
  expect(await strictCheck()).toBeUndefined();
});

test("strict: SwiftLint strict: true, swiftlint --strict or swift format lint --strict → present", async () => {
  write("Package.swift");
  write(".swiftlint.yml", "opt_in_rules:\n  - empty_count\nstrict: true\n");
  expect(await strictCheck()).toMatchObject({
    present: true,
    evidence: ["swiftlint strict: true"],
  });

  write(".swiftlint.yml", "strict: false\n");
  write(".githooks/pre-push", "swiftlint lint --strict\n");
  expect(await strictCheck()).toMatchObject({ present: true, evidence: ["swiftlint --strict"] });

  write(".githooks/pre-push", "swift format lint --strict -r Sources\n");
  expect(await strictCheck()).toMatchObject({
    present: true,
    evidence: ["swift-format lint --strict"],
  });
});

test("lax: a non-strict linter → absent, prescribed", async () => {
  write("Package.swift");
  write(".swiftlint.yml", "strict: false\n");
  write(".githooks/pre-push", "swiftlint lint\n");
  const r = await analyzeReadiness(dir);
  expect(r.checks.find((c) => c.id === "lint_strictness")).toMatchObject({
    present: false,
    evidence: [],
  });
  expect(r.claudeMd).toContain("Set `strict: true` in `.swiftlint.yml`");
});
