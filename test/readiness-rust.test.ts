import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeReadiness, RUST_GUARDRAILS, type GuardrailId } from "../src/readiness";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-readiness-rust-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, body = "") {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

function present(id: GuardrailId, report: { checks: { id: GuardrailId; present: boolean }[] }) {
  return report.checks.find((c) => c.id === id)?.present ?? false;
}

function ids(report: { checks: { id: GuardrailId }[] }) {
  return report.checks.map((c) => c.id);
}

/** The CI-mirror hook pitwall itself ships (fmt + clippy + test), but at the pre-push stage. */
const CI_MIRROR =
  "#!/usr/bin/env bash\ncargo fmt --check\ncargo clippy --all-targets -- -D warnings\ncargo test\n";

/** Writes a pitwall-shaped Rust crate (root Cargo.toml) with the given hook file. */
function pitwallShaped(hook: string) {
  write("Cargo.toml", '[package]\nname = "pitwall"\nversion = "0.1.0"\nedition = "2021"\n');
  write("rustfmt.toml", "edition = 2021\n");
  write(hook, CI_MIRROR);
  write("CLAUDE.md", "# rules");
  write(
    ".github/workflows/ci.yml",
    "name: CI\njobs:\n  check:\n    steps:\n      - run: cargo test\n",
  );
  write("tests/smoke.rs", "#[test] fn ok() {}");
}

test("a repo with neither package.json nor Cargo.toml is not applicable, ecosystem null", () => {
  write("main.py", "print()");
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(false);
  expect(r.ecosystem).toBe(null);
  expect(r.checks).toEqual([]);
  expect(r.score).toBe(0);
});

test("a Cargo.toml at the root makes the repo applicable as rust", () => {
  write("Cargo.toml", '[package]\nname = "x"\n');
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.ecosystem).toBe("rust");
});

test("a Cargo.toml one directory down is detected (mixed-stack root)", () => {
  write("README.md", "# repo");
  write("engine/Cargo.toml", '[package]\nname = "engine"\n');
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.ecosystem).toBe("rust");
});

test("the Rust guardrail set omits type_checker and lint_staged", () => {
  write("Cargo.toml", '[package]\nname = "x"\n');
  const r = analyzeReadiness(dir);
  expect(ids(r)).not.toContain("type_checker");
  expect(ids(r)).not.toContain("lint_staged");
  expect(r.checks.length).toBe(RUST_GUARDRAILS.length);
});

test("pitwall-shaped crate (pre-push CI mirror) scores its guardrails correctly", () => {
  pitwallShaped(".githooks/pre-push");
  const r = analyzeReadiness(dir);
  expect(r.ecosystem).toBe("rust");
  // rustfmt.toml → formatter; the hook running clippy → linter; cargo test → test_runner
  expect(present("formatter", r)).toBe(true);
  expect(present("linter", r)).toBe(true);
  expect(present("test_runner", r)).toBe(true);
  // .githooks/ dir → git_hooks; .githooks/pre-push → pre_push_ci
  expect(present("git_hooks", r)).toBe(true);
  expect(present("pre_push_ci", r)).toBe(true);
  // CLAUDE.md → agent_instructions; workflow → ci
  expect(present("agent_instructions", r)).toBe(true);
  expect(present("ci", r)).toBe(true);
  // none of these are configured → absent
  expect(present("dependency_automation", r)).toBe(false);
  expect(present("dead_code_audit", r)).toBe(false);
  expect(present("commit_lint", r)).toBe(false);
});

test("a pre-commit-only hook is git_hooks present but pre_push_ci absent (JS-consistent stage split)", () => {
  pitwallShaped(".githooks/pre-commit");
  const r = analyzeReadiness(dir);
  expect(present("git_hooks", r)).toBe(true);
  expect(present("pre_push_ci", r)).toBe(false);
});

test("dead_code_audit does NOT match on cargo-deny / deny.toml (license/advisory, not unused-code)", () => {
  write("Cargo.toml", '[package]\nname = "x"\n');
  write("deny.toml", "[bans]\n");
  write(
    ".github/workflows/ci.yml",
    "name: CI\njobs:\n  deny:\n    steps:\n      - run: cargo deny check\n",
  );
  const r = analyzeReadiness(dir);
  expect(present("dead_code_audit", r)).toBe(false);
});

test("dead_code_audit matches when cargo machete runs in the corpus", () => {
  write("Cargo.toml", '[package]\nname = "x"\n');
  write(
    ".github/workflows/ci.yml",
    "name: CI\njobs:\n  m:\n    steps:\n      - run: cargo machete\n",
  );
  const r = analyzeReadiness(dir);
  expect(present("dead_code_audit", r)).toBe(true);
});

test("dead_code_audit matches the nightly udeps invocation the prescription recommends", () => {
  write("Cargo.toml", '[package]\nname = "x"\n');
  // udeps is nightly-only, so its real invocation carries a toolchain selector.
  write(
    ".github/workflows/ci.yml",
    "name: CI\njobs:\n  u:\n    steps:\n      - run: cargo +nightly udeps\n",
  );
  const r = analyzeReadiness(dir);
  expect(present("dead_code_audit", r)).toBe(true);
});

test("git_hooks detects a cargo-husky dev-dependency", () => {
  write("Cargo.toml", '[package]\nname = "x"\n\n[dev-dependencies]\ncargo-husky = "1"\n');
  const r = analyzeReadiness(dir);
  expect(present("git_hooks", r)).toBe(true);
  const ev = r.checks.find((c) => c.id === "git_hooks")?.evidence ?? [];
  expect(ev).toContain("cargo-husky");
});

test("generated Rust CLAUDE.md is Rust-correct and free of JS tooling text", () => {
  write("Cargo.toml", '[package]\nname = "bare"\n');
  const r = analyzeReadiness(dir);
  expect(r.claudeMd).toContain("# House rules for AI agents (Rust)");
  // Rust prescriptions for the missing guardrails
  expect(r.claudeMd).toContain("rustup component add clippy");
  expect(r.claudeMd).toContain("rustup component add rustfmt");
  expect(r.claudeMd).toContain("cargo install cargo-machete");
  expect(r.claudeMd).toContain('package-ecosystem: "cargo"');
  expect(r.claudeMd).toContain("core.hooksPath");
  // No JS leakage — the crux of the four-maps-profile-driven fix
  expect(r.claudeMd).not.toContain(".prettierignore");
  expect(r.claudeMd.toLowerCase()).not.toContain("prettier");
  expect(r.claudeMd).not.toContain("lint-staged");
  expect(r.claudeMd).not.toContain("eslint");
  expect(r.claudeMd).not.toContain("tsc");
});

test("a mixed repo with both Cargo.toml and package.json resolves to js-ts (no regression)", () => {
  write("Cargo.toml", '[package]\nname = "native"\n');
  write("package.json", JSON.stringify({ name: "app", devDependencies: { typescript: "^6" } }));
  write("tsconfig.json", "{}");
  const r = analyzeReadiness(dir);
  expect(r.ecosystem).toBe("js-ts");
  // The JS type_checker guardrail is back (js-ts profile), proving the JS path ran.
  expect(present("type_checker", r)).toBe(true);
});

test("the target repo is never executed — a bare crate still yields a scorecard", () => {
  write("Cargo.toml", '[package]\nname = "x"\n');
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.checks.every((c) => !c.present)).toBe(true);
  expect(r.score).toBe(0);
});
