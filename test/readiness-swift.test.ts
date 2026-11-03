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

function present(id: GuardrailId) {
  return analyzeReadiness(dir).checks.find((c) => c.id === id)?.present ?? false;
}

test("a root Package.swift makes the repo applicable as swift", () => {
  write("Package.swift", "// swift-tools-version: 6.2\n");
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.ecosystem).toBe("swift");
});

test("a Package.swift one or two levels down is detected", () => {
  write("ios/App/Package.swift");
  expect(analyzeReadiness(dir).ecosystem).toBe("swift");
  write("ios/Package.swift");
  expect(analyzeReadiness(dir).ecosystem).toBe("swift");
});

test("dependency directories are not Swift roots", () => {
  write("Pods/Foo/Package.swift");
  write("node_modules/foo/Package.swift");
  write(".build/checkouts/Package.swift");
  expect(analyzeReadiness(dir).applicable).toBe(false);
});

test.each([
  ["root package.json", "package.json", "js-ts"],
  ["root Cargo.toml", "Cargo.toml", "rust"],
  ["deep package.json", "apps/web/package.json", "js-ts"],
  ["deep Cargo.toml", "crates/core/Cargo.toml", "rust"],
] as const)("%s keeps its profile beside a nearer Package.swift", (_name, manifest, ecosystem) => {
  write("Package.swift");
  write("ios/Package.swift");
  write(manifest, manifest.endsWith("json") ? "{}" : '[package]\nname = "x"\n');
  expect(analyzeReadiness(dir).ecosystem).toBe(ecosystem);
});

test("the Swift guardrail set omits type_checker, lint_staged and env_schema", () => {
  const ids = SWIFT_GUARDRAILS.map((g) => g.id);
  for (const id of ["type_checker", "lint_staged", "env_schema"] as const)
    expect(ids).not.toContain(id);
});

test("a murmur-shaped repo scores what its pre-commit hook and config prove", () => {
  write("Package.swift");
  write(".swift-format", "{}");
  write(
    ".githooks/pre-commit",
    "swift format lint --strict -r Sources Tests\nswift test --quiet\n",
  );
  write("Tests/CoreTests/a.swift");
  for (const id of ["linter", "formatter", "test_runner", "git_hooks"] as const)
    expect(present(id)).toBe(true);
  for (const id of ["pre_push_ci", "ci", "dead_code_audit", "agent_instructions"] as const)
    expect(present(id)).toBe(false);
});

test("evidence comes from config files and the command corpus", () => {
  write("Package.swift");
  expect(present("linter")).toBe(false);
  expect(present("formatter")).toBe(false);
  expect(present("test_runner")).toBe(false);
  write(".swiftlint.yml");
  write(".swiftformat");
  write("Tests/a.swift");
  expect(present("linter")).toBe(true);
  expect(present("formatter")).toBe(true);
  expect(present("test_runner")).toBe(true);
  write(".github/workflows/ci.yml", "steps:\n  - run: periphery scan --strict\n");
  expect(present("dead_code_audit")).toBe(true);
  expect(present("ci")).toBe(true);
});

test("a dependency named swift-format in Package.swift does not prove the tool runs", () => {
  write(
    "Package.swift",
    '.package(url: "https://github.com/swiftlang/swift-format", from: "6.0.0")',
  );
  expect(present("formatter")).toBe(false);
  expect(present("linter")).toBe(false);
});

test("xcodebuild test counts as a test runner on one line only", () => {
  write("Package.swift");
  write(".github/workflows/ci.yml", "run: xcodebuild -scheme App\nrun: echo test\n");
  expect(present("test_runner")).toBe(false);
  write(".github/workflows/ci.yml", "run: xcodebuild -scheme App test\n");
  expect(present("test_runner")).toBe(true);
});

test("a crafted one-line hook can't stall the server loop", () => {
  write("Package.swift");
  write(".githooks/pre-push", "xcodebuild ".repeat(20_000));
  const start = performance.now();
  expect(present("test_runner")).toBe(false);
  expect(performance.now() - start).toBeLessThan(1000);
});

test("a pre-commit-only repo has git_hooks but not pre_push_ci", () => {
  write("Package.swift");
  write(".githooks/pre-commit", "swift test");
  expect(present("git_hooks")).toBe(true);
  expect(present("pre_push_ci")).toBe(false);
  write(".githooks/pre-push", "swift test");
  expect(present("pre_push_ci")).toBe(true);
});

test("only .swift-version is a toolchain pin", () => {
  write("Package.swift", "// swift-tools-version: 6.2\n");
  expect(scanEcosystem(dir).toolchainPins).toEqual([]);
  write(".swift-version", "6.4.2\n");
  const scan = scanEcosystem(dir);
  expect(scan.ecosystem).toBe("swift");
  expect(scan.toolchainPins).toEqual([".swift-version"]);
});

const FOREIGN = /\b(?:npm|bun|bunx|husky|cargo|clippy|rustfmt|prettier|eslint|vitest)\b/;

test("the prescription names only Swift tooling", () => {
  write("Package.swift");
  const { claudeMd } = analyzeReadiness(dir);
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
