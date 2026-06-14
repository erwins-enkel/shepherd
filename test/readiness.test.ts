import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeReadiness,
  GUARDRAILS,
  INSTALL_STEPS,
  PM_VERBS,
  pickPackageManager,
  type GuardrailId,
} from "../src/readiness";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-readiness-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, body = "") {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

function pkg(obj: Record<string, unknown>) {
  write("package.json", JSON.stringify(obj));
}

function present(id: GuardrailId, report: { checks: { id: GuardrailId; present: boolean }[] }) {
  return report.checks.find((c) => c.id === id)?.present ?? false;
}

test("pickPackageManager: packageManager field wins over any lockfile", () => {
  expect(pickPackageManager("pnpm@9.1.0", () => true)).toBe("pnpm");
  expect(pickPackageManager("yarn@4.0.0", () => true)).toBe("yarn");
});

test("pickPackageManager: falls back to the root lockfile", () => {
  expect(pickPackageManager(undefined, (rel) => rel === "bun.lock")).toBe("bun");
  expect(pickPackageManager(undefined, (rel) => rel === "bun.lockb")).toBe("bun");
  expect(pickPackageManager(undefined, (rel) => rel === "pnpm-lock.yaml")).toBe("pnpm");
  expect(pickPackageManager(undefined, (rel) => rel === "yarn.lock")).toBe("yarn");
  expect(pickPackageManager(undefined, (rel) => rel === "package-lock.json")).toBe("npm");
});

test("pickPackageManager: no field and no lockfile → npm fallback", () => {
  expect(pickPackageManager(undefined, () => false)).toBe("npm");
  expect(pickPackageManager("weird@1", () => false)).toBe("npm");
});

test("a repo without package.json is not applicable to the JS/TS baseline", () => {
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(false);
  expect(r.checks).toEqual([]);
  expect(r.score).toBe(0);
});

test("a mixed-stack repo with package.json only in a subdirectory is applicable", () => {
  // epamano-shopify shape: Python at the root, the JS/TS app in a subproject.
  write("scripts/changelog-gen.py", "print()");
  write(
    "category-ui/package.json",
    JSON.stringify({
      name: "category-ui",
      scripts: { lint: "eslint .", test: "vitest" },
      devDependencies: { eslint: "^10", typescript: "^6" },
    }),
  );
  write("category-ui/tsconfig.json", "{}");
  // Repo-level markers live at the root, not in the subproject.
  write(".github/workflows/ci.yml", "name: ci");
  write("CLAUDE.md", "# rules");

  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(present("linter", r)).toBe(true); // subpackage devDep + lint script
  expect(present("type_checker", r)).toBe(true); // subpackage tsconfig.json
  expect(present("test_runner", r)).toBe(true);
  expect(present("ci", r)).toBe(true); // root-level workflow still counts
  expect(r.hasAgentInstructions).toBe(true); // root-level CLAUDE.md still counts
});

test("node_modules and hidden directories never make a repo applicable", () => {
  write("node_modules/package.json", JSON.stringify({ name: "leftpad" }));
  write(".cache/package.json", JSON.stringify({ name: "tool" }));
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(false);
});

test("a bare package.json scores low — every guardrail absent", () => {
  pkg({ name: "bare" });
  const r = analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.checks.length).toBe(GUARDRAILS.length);
  expect(r.checks.every((c) => !c.present)).toBe(true);
  expect(r.score).toBe(0);
  expect(r.hasAgentInstructions).toBe(false);
});

test("a fully-equipped repo (Shepherd-shaped) scores 100 with all guardrails present", () => {
  pkg({
    name: "equipped",
    scripts: {
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      format: "prettier --write .",
      test: "bun test",
    },
    devDependencies: {
      eslint: "^10",
      prettier: "^3",
      typescript: "^6",
      husky: "^9",
      "lint-staged": "^17",
      "@commitlint/cli": "^21",
    },
  });
  write(".prettierrc", "{}");
  write("eslint.config.js", "export default [];");
  write("tsconfig.json", "{}");
  write("commitlint.config.js", "export default {};");
  write(".husky/pre-commit", "lint-staged");
  write(".husky/pre-push", "bun run lint");
  write(".husky/commit-msg", "commitlint");
  write(".fallowrc.jsonc", "{}");
  write(".github/workflows/ci.yml", "name: ci");
  write(".github/dependabot.yml", "version: 2");
  write("CLAUDE.md", "# rules");

  const r = analyzeReadiness(dir);
  expect(r.score).toBe(100);
  expect(r.checks.every((c) => c.present)).toBe(true);
  expect(r.hasAgentInstructions).toBe(true);
  for (const c of r.checks) expect(c.evidence.length).toBeGreaterThan(0);
});

test("detects individual guardrails from their markers", () => {
  pkg({
    name: "partial",
    scripts: { test: "vitest" },
    devDependencies: { prettier: "^3" },
  });
  write("tsconfig.json", "{}");
  const r = analyzeReadiness(dir);
  expect(present("formatter", r)).toBe(true); // prettier devDep
  expect(present("type_checker", r)).toBe(true); // tsconfig.json
  expect(present("test_runner", r)).toBe(true); // real test script
  expect(present("linter", r)).toBe(false);
  expect(present("git_hooks", r)).toBe(false);
});

test("detects dependency automation from a Dependabot config", () => {
  pkg({ name: "bot" });
  write(".github/dependabot.yml", "version: 2");
  const r = analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(true);
  const ev = r.checks.find((c) => c.id === "dependency_automation")?.evidence ?? [];
  expect(ev).toContain("dependabot.yml");
});

test("detects dependency automation from a Renovate config", () => {
  pkg({ name: "renovated" });
  write("renovate.json", "{}");
  const r = analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(true);
  const ev = r.checks.find((c) => c.id === "dependency_automation")?.evidence ?? [];
  expect(ev).toContain("renovate config");
});

test("absent dependency automation is prescribed in the generated CLAUDE.md", () => {
  pkg({ name: "no-bot" });
  const r = analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(false);
  expect(r.claudeMd).toContain("Dependency automation");
});

test("the npm placeholder test script does not count as a test runner", () => {
  pkg({ name: "no-test", scripts: { test: 'echo "Error: no test specified" && exit 1' } });
  const r = analyzeReadiness(dir);
  expect(present("test_runner", r)).toBe(false);
});

test("score is the weighted fraction of present guardrails, derived from the checks array", () => {
  // Only the highest-leverage guardrail (pre_push_ci) present.
  pkg({ name: "one", devDependencies: { husky: "^9" } });
  write(".husky/pre-push", "x");
  const r = analyzeReadiness(dir);
  const total = GUARDRAILS.reduce((s, g) => s + g.weight, 0);
  const presentWeight = r.checks.filter((c) => c.present).reduce((s, c) => s + c.weight, 0);
  expect(r.score).toBe(Math.round((100 * presentWeight) / total));
  expect(present("pre_push_ci", r)).toBe(true);
  expect(present("git_hooks", r)).toBe(true); // .husky/ implies a hook manager
});

test("generated CLAUDE.md is non-empty, encodes the surgical posture, and names missing tooling", () => {
  pkg({ name: "needs-coaching", devDependencies: { typescript: "^6" } });
  write("tsconfig.json", "{}");
  const r = analyzeReadiness(dir);
  expect(r.claudeMd).toContain("Surgical");
  // a missing high-leverage guardrail should be called out in the prescription
  expect(r.claudeMd.toLowerCase()).toContain("prettier");
});

test("adopt-list (absent guardrails sorted by leverage) leads with pre-push CI mirror", () => {
  pkg({ name: "empty-ish" });
  const r = analyzeReadiness(dir);
  const adopt = r.checks
    .filter((c) => !c.present)
    .sort((a, b) => b.weight - a.weight)
    .map((c) => c.id);
  expect(adopt[0]).toBe("pre_push_ci");
});

test("prescription lists PM-correct install commands for missing guardrails (bun)", () => {
  pkg({ name: "bare" });
  write("bun.lock", "");
  const r = analyzeReadiness(dir);
  expect(r.claudeMd).toContain("$ bun add -d eslint @eslint/js");
  expect(r.claudeMd).toContain("$ bun add -d prettier");
  expect(r.claudeMd).toContain("$ bunx husky init");
});

test("prescription uses the npm verbs when the repo is npm", () => {
  pkg({ name: "bare" });
  write("package-lock.json", "{}");
  const r = analyzeReadiness(dir);
  expect(r.claudeMd).toContain("$ npm i -D eslint @eslint/js");
  expect(r.claudeMd).not.toContain("bun add");
});

test("a bare bun repo emits exactly the installable-guardrail commands, all bun", () => {
  pkg({ name: "bare" });
  write("bun.lock", "");
  const r = analyzeReadiness(dir);
  const cmdLines = r.claudeMd
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("$ "));
  // Derived from the source of truth — no magic count to drift.
  const expected = GUARDRAILS.flatMap((g) => INSTALL_STEPS[g.id](PM_VERBS.bun)).map(
    (c) => `$ ${c}`,
  );
  expect(cmdLines.sort()).toEqual(expected.sort());
  expect(INSTALL_STEPS.ci(PM_VERBS.bun)).toEqual([]);
  expect(INSTALL_STEPS.agent_instructions(PM_VERBS.bun)).toEqual([]);
  expect(INSTALL_STEPS.dependency_automation(PM_VERBS.bun)).toEqual([]);
});

test("a present guardrail emits no install command for itself", () => {
  pkg({ name: "x", devDependencies: { eslint: "^9" }, scripts: { lint: "eslint ." } });
  write("package-lock.json", "{}");
  const r = analyzeReadiness(dir);
  expect(r.claudeMd).not.toContain("$ npm i -D eslint @eslint/js");
});
