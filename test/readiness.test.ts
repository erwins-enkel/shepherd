import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeReadiness,
  bootstrapGuardrailChecklist,
  GUARDRAIL_BLIND_SPOTS,
  GUARDRAILS,
  INSTALL_STEPS,
  PM_VERBS,
  pickPackageManager,
  scanEcosystem,
  type GuardrailId,
  type ReadinessReport,
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

/** Guardrails scored on every JS/TS repo — conditional ones (`applies`) drop out of a bare repo. */
const UNCONDITIONAL = GUARDRAILS.filter((g) => !g.applies);

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

test("a repo without package.json is not applicable to the JS/TS baseline", async () => {
  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(false);
  expect(r.checks).toEqual([]);
  expect(r.score).toBe(0);
});

test("a mixed-stack repo with package.json only in a subdirectory is applicable", async () => {
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

  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(present("linter", r)).toBe(true); // subpackage devDep + lint script
  expect(present("type_checker", r)).toBe(true); // subpackage tsconfig.json
  expect(present("test_runner", r)).toBe(true);
  expect(present("ci", r)).toBe(true); // root-level workflow still counts
  expect(r.hasAgentInstructions).toBe(true); // root-level CLAUDE.md still counts
});

test("node_modules and hidden directories never make a repo applicable", async () => {
  write("node_modules/package.json", JSON.stringify({ name: "leftpad" }));
  write(".cache/package.json", JSON.stringify({ name: "tool" }));
  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(false);
});

test("a bare package.json scores low — every guardrail absent", async () => {
  pkg({ name: "bare" });
  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(r.ecosystem).toBe("js-ts");
  expect(r.checks.length).toBe(UNCONDITIONAL.length);
  expect(r.checks.every((c) => !c.present)).toBe(true);
  expect(r.score).toBe(0);
  expect(r.hasAgentInstructions).toBe(false);
});

test("a fully-equipped repo (Shepherd-shaped) scores 100 with all guardrails present", async () => {
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
  write(
    "eslint.config.js",
    'export default [{ rules: { "no-empty": "error", "no-floating-promises": "error" } }];',
  );
  write("tsconfig.json", '{ "compilerOptions": { "strict": true } }');
  write("commitlint.config.js", "export default {};");
  write(".husky/pre-commit", "lint-staged");
  write(".husky/pre-push", "bun run lint");
  write(".husky/commit-msg", "commitlint");
  write(".fallowrc.jsonc", "{}");
  write(".github/workflows/ci.yml", "name: ci");
  write(".github/dependabot.yml", "version: 2");
  write("CLAUDE.md", "# rules");
  write(".github/ISSUE_TEMPLATE/task.md", "## Problem");

  const r = await analyzeReadiness(dir);
  expect(r.score).toBe(100);
  expect(r.checks.every((c) => c.present)).toBe(true);
  expect(r.hasAgentInstructions).toBe(true);
  expect(r.hasIssueTemplates).toBe(true);
  for (const c of r.checks) expect(c.evidence.length).toBeGreaterThan(0);
});

test("detects individual guardrails from their markers", async () => {
  pkg({
    name: "partial",
    scripts: { test: "vitest" },
    devDependencies: { prettier: "^3" },
  });
  write("tsconfig.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(present("formatter", r)).toBe(true); // prettier devDep
  expect(present("type_checker", r)).toBe(true); // tsconfig.json
  expect(present("test_runner", r)).toBe(true); // real test script
  expect(present("linter", r)).toBe(false);
  expect(present("git_hooks", r)).toBe(false);
});

test("detects dependency automation from a Dependabot config", async () => {
  pkg({ name: "bot" });
  write(".github/dependabot.yml", "version: 2");
  const r = await analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(true);
  const ev = r.checks.find((c) => c.id === "dependency_automation")?.evidence ?? [];
  expect(ev).toContain("dependabot.yml");
});

test("detects dependency automation from a Renovate config", async () => {
  pkg({ name: "renovated" });
  write("renovate.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(true);
  const ev = r.checks.find((c) => c.id === "dependency_automation")?.evidence ?? [];
  expect(ev).toContain("renovate config");
});

test("absent dependency automation is prescribed in the generated CLAUDE.md", async () => {
  pkg({ name: "no-bot" });
  const r = await analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(false);
  expect(r.claudeMd).toContain("Dependency automation");
});

test("the npm placeholder test script does not count as a test runner", async () => {
  pkg({ name: "no-test", scripts: { test: 'echo "Error: no test specified" && exit 1' } });
  const r = await analyzeReadiness(dir);
  expect(present("test_runner", r)).toBe(false);
});

test("score is the weighted fraction of present guardrails, derived from the checks array", async () => {
  // Only the highest-leverage guardrail (pre_push_ci) present.
  pkg({ name: "one", devDependencies: { husky: "^9" } });
  write(".husky/pre-push", "x");
  const r = await analyzeReadiness(dir);
  const total = UNCONDITIONAL.reduce((s, g) => s + g.weight, 0);
  const presentWeight = r.checks.filter((c) => c.present).reduce((s, c) => s + c.weight, 0);
  expect(r.score).toBe(Math.round((100 * presentWeight) / total));
  expect(present("pre_push_ci", r)).toBe(true);
  expect(present("git_hooks", r)).toBe(true); // .husky/ implies a hook manager
});

test("generated CLAUDE.md is non-empty, keeps the quiet-failure posture, and names missing tooling", async () => {
  pkg({ name: "needs-coaching", devDependencies: { typescript: "^6" } });
  write("tsconfig.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(r.claudeMd).toContain("Fail closed");
  // a missing high-leverage guardrail should be called out in the prescription
  expect(r.claudeMd.toLowerCase()).toContain("prettier");
});

// Issue #2015: the artifact is written into a TARGET repo and re-read every turn, so it must not
// restate the engineering posture every Shepherd spawn already carries in its system prompt, nor
// general judgement a capable model follows unprompted. Without this guard nothing stops the
// section re-growing — which is the whole failure the cut exists to prevent.
test("generated CLAUDE.md carries no posture bullet the system prompt or the guardrails already cover", async () => {
  pkg({ name: "needs-coaching", devDependencies: { typescript: "^6" } });
  const md = (await analyzeReadiness(dir)).claudeMd;
  for (const dropped of [
    "Simplicity first",
    "Surgical changes",
    "Verify before claiming done",
    "No dead code",
  ])
    expect(md).not.toContain(dropped);
  // …while the bullets that describe a QUIET failure no gate fires on all survive.
  for (const kept of ["Fail closed", "Single source of truth", "Keep names and comments honest"])
    expect(md).toContain(kept);
});

test("CLAUDE.md always tells the repo to add .shepherd-* to .prettierignore, even when prettier is already present", async () => {
  // Prettier present → the formatter guardrail is satisfied and emits no adopt-step,
  // but the artifact note must still render (this is the higher-impact case: an
  // existing prettier would otherwise reformat Shepherd's scratch files).
  pkg({
    name: "has-prettier",
    devDependencies: { prettier: "^3" },
    scripts: { format: "prettier --write ." },
  });
  write(".prettierrc", "{}");
  const r = await analyzeReadiness(dir);
  expect(present("formatter", r)).toBe(true);
  expect(r.claudeMd).toContain(".shepherd-*");
  expect(r.claudeMd).toContain(".prettierignore");
  expect(r.claudeMd).toContain("echo '.shepherd-*' >> .prettierignore");
});

test("adopt-list (absent guardrails sorted by leverage) leads with pre-push CI mirror", async () => {
  pkg({ name: "empty-ish" });
  const r = await analyzeReadiness(dir);
  const adopt = r.checks
    .filter((c) => !c.present)
    .sort((a, b) => b.weight - a.weight)
    .map((c) => c.id);
  expect(adopt[0]).toBe("pre_push_ci");
});

test("prescription lists PM-correct install commands for missing guardrails (bun)", async () => {
  pkg({ name: "bare" });
  write("bun.lock", "");
  const r = await analyzeReadiness(dir);
  expect(r.claudeMd).toContain("$ bun add -d eslint @eslint/js");
  expect(r.claudeMd).toContain("$ bun add -d prettier");
  expect(r.claudeMd).toContain("$ bunx husky init");
});

test("prescription uses the npm verbs when the repo is npm", async () => {
  pkg({ name: "bare" });
  write("package-lock.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(r.claudeMd).toContain("$ npm i -D eslint @eslint/js");
  expect(r.claudeMd).not.toContain("bun add");
});

test("a bare bun repo emits exactly the installable-guardrail commands, all bun", async () => {
  pkg({ name: "bare" });
  write("bun.lock", "");
  const r = await analyzeReadiness(dir);
  const cmdLines = r.claudeMd
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("$ "));
  // Derived from the source of truth — no magic count to drift.
  const expected = UNCONDITIONAL.flatMap((g) => INSTALL_STEPS[g.id](PM_VERBS.bun)).map(
    (c) => `$ ${c}`,
  );
  expect(cmdLines.sort()).toEqual(expected.sort());
  expect(INSTALL_STEPS.ci(PM_VERBS.bun)).toEqual([]);
  expect(INSTALL_STEPS.agent_instructions(PM_VERBS.bun)).toEqual([]);
  expect(INSTALL_STEPS.dependency_automation(PM_VERBS.bun)).toEqual([]);
});

test("dependabot note prescribes the bun ecosystem for a bun repo", async () => {
  pkg({ name: "bare" });
  write("bun.lock", "");
  const r = await analyzeReadiness(dir);
  expect(r.claudeMd).toContain('package-ecosystem: "bun"');
  expect(r.claudeMd).not.toContain('package-ecosystem: "npm"');
  // Text lockfile already present — no migration hint.
  expect(r.claudeMd).not.toContain("--save-text-lockfile");
});

test("dependabot note prescribes the npm ecosystem for npm and pnpm repos", async () => {
  pkg({ name: "bare" });
  write("package-lock.json", "{}");
  expect((await analyzeReadiness(dir)).claudeMd).toContain('package-ecosystem: "npm"');
  expect((await analyzeReadiness(dir)).claudeMd).not.toContain('package-ecosystem: "bun"');
  rmSync(join(dir, "package-lock.json"));
  write("pnpm-lock.yaml", "");
  expect((await analyzeReadiness(dir)).claudeMd).toContain('package-ecosystem: "npm"');
});

test("dependabot note adds the text-lockfile migration hint for bun.lockb-only repos", async () => {
  pkg({ name: "bare" });
  write("bun.lockb", "");
  const r = await analyzeReadiness(dir);
  expect(r.claudeMd).toContain('package-ecosystem: "bun"');
  expect(r.claudeMd).toContain("bun install --save-text-lockfile");
});

test("no dependabot note when dependency automation is already present", async () => {
  pkg({ name: "bare" });
  write("bun.lock", "");
  write(".github/dependabot.yml", "version: 2");
  const r = await analyzeReadiness(dir);
  expect(present("dependency_automation", r)).toBe(true);
  expect(r.claudeMd).not.toContain("package-ecosystem");
});

test("a present guardrail emits no install command for itself", async () => {
  pkg({ name: "x", devDependencies: { eslint: "^9" }, scripts: { lint: "eslint ." } });
  write("package-lock.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(r.claudeMd).not.toContain("$ npm i -D eslint @eslint/js");
});

// ── intent-shaped issue templates (#2158) ────────────────────────────────────
// The intake shape is stack-independent, so the detector is forge-shaped, not language-shaped.

test("issue templates: detects the GitHub directory, the legacy single file, and GitLab", async () => {
  const cases: [string, string][] = [
    [".github/ISSUE_TEMPLATE/task.md", ".github/ISSUE_TEMPLATE (1)"],
    [".github/ISSUE_TEMPLATE/bug.yml", ".github/ISSUE_TEMPLATE (1)"],
    [".github/ISSUE_TEMPLATE.md", ".github/ISSUE_TEMPLATE.md"],
    [".gitlab/issue_templates/Task.md", ".gitlab/issue_templates (1)"],
  ];
  for (const [file, evidence] of cases) {
    // One repo per case (the shared `dir` is per-test, and evidence counts must not accumulate).
    const repo = mkdtempSync(join(tmpdir(), "shepherd-readiness-tpl-"));
    const put = (rel: string) => {
      const full = join(repo, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, "## Problem");
    };
    put("package.json");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x" }));
    put(file);
    const check = (await analyzeReadiness(repo)).checks.find((c) => c.id === "issue_templates");
    expect(check?.present).toBe(true);
    expect(check?.evidence).toContain(evidence);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("issue templates: the chooser config alone is not a template", async () => {
  pkg({ name: "x" });
  write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false");
  expect(present("issue_templates", await analyzeReadiness(dir))).toBe(false);
});

test("issue templates: a repo without any scores the guardrail absent and reports it", async () => {
  pkg({ name: "x" });
  write(".github/workflows/ci.yml", "name: ci"); // a .github dir alone is not a template
  const r = await analyzeReadiness(dir);
  expect(r.checks.find((c) => c.id === "issue_templates")?.present).toBe(false);
  expect(r.hasIssueTemplates).toBe(false);
});

test("the prescribed template is the intent shape, and rides the generated house rules", async () => {
  pkg({ name: "x" });
  const r = await analyzeReadiness(dir);
  for (const heading of ["Problem", "Outcome", "Constraints", "Non-goals", "Open questions"]) {
    expect(r.issueTemplate).toContain(`## ${heading}`);
  }
  // Absent guardrail → the adopt list tells the agent where to put it.
  expect(r.claudeMd).toContain(".github/ISSUE_TEMPLATE/task.md");
});

test("the artifact ships whether or not the repo has templates; only the prescription differs", async () => {
  // hasIssueTemplates gates the ADOPT prescription (and the panel note), never the artifact — the
  // template stays visible to copy from either way.
  pkg({ name: "x" });
  write(".github/ISSUE_TEMPLATE/existing.md", "## Anything");
  const r = await analyzeReadiness(dir);
  expect(r.hasIssueTemplates).toBe(true);
  expect(r.issueTemplate).toContain("## Problem");
  // Guardrail satisfied ⇒ the adopt list no longer names the file to create.
  expect(r.claudeMd).not.toContain(".github/ISSUE_TEMPLATE/task.md");
});

test("a not-applicable repo reports no template rather than a stray artifact", async () => {
  const r = await analyzeReadiness(dir); // no package.json / Cargo.toml written
  expect(r.applicable).toBe(false);
  expect(r.issueTemplate).toBe("");
  expect(r.hasIssueTemplates).toBe(false);
});

// ── env_schema: conditional on an env surface ────────────────────────────────

test("env_schema is omitted (not scored) when the repo has no env surface", async () => {
  pkg({ name: "lib" });
  const r = await analyzeReadiness(dir);
  expect(r.checks.map((c) => c.id)).not.toContain("env_schema");
  expect(r.claudeMd).not.toContain("varlock");
});

test("an .env.example makes env_schema apply, absent, and prescribed", async () => {
  pkg({ name: "app" });
  write("bun.lock", "");
  write(".env.example", "API_URL=");
  const r = await analyzeReadiness(dir);
  const check = r.checks.find((c) => c.id === "env_schema");
  expect(check).toEqual({ id: "env_schema", present: false, weight: 3, evidence: [] });
  expect(r.claudeMd).toContain("$ bun add -d varlock");
  expect(r.claudeMd).toContain("$ bunx varlock init --agent");
  expect(r.claudeMd).toContain("varlock audit");
});

test("env_schema is present from a committed .env.schema", async () => {
  pkg({ name: "app" });
  write(".env.example", "API_URL=");
  write(".env.schema", "# @defaultRequired=false\nAPI_URL=");
  const r = await analyzeReadiness(dir);
  expect(present("env_schema", r)).toBe(true);
  expect(r.checks.find((c) => c.id === "env_schema")?.evidence).toEqual([".env.schema"]);
});

test("a varlock dependency alone makes env_schema apply and present", async () => {
  pkg({ name: "app", devDependencies: { varlock: "^1.20.0" } });
  const r = await analyzeReadiness(dir);
  expect(present("env_schema", r)).toBe(true);
  expect(r.checks.find((c) => c.id === "env_schema")?.evidence).toEqual(["varlock"]);
});

test("an env template in a package subdirectory makes env_schema apply", async () => {
  write("ui/package.json", JSON.stringify({ name: "ui" }));
  write("ui/.env.sample", "X=");
  const r = await analyzeReadiness(dir);
  expect(r.checks.map((c) => c.id)).toContain("env_schema");
  expect(present("env_schema", r)).toBe(false);
});

test("#3107: a package.json two levels down (apps/web) makes the repo applicable", async () => {
  write("apps/web/package.json", JSON.stringify({ name: "web", scripts: { lint: "eslint ." } }));
  write("node_modules/x/package.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(present("linter", r)).toBe(true);
});

test("#3107: a first-level manifest short-circuits the second-level search", async () => {
  write("ui/package.json", JSON.stringify({ name: "ui" }));
  write("apps/web/package.json", JSON.stringify({ name: "web", scripts: { lint: "eslint ." } }));
  const r = await analyzeReadiness(dir);
  expect(r.applicable).toBe(true);
  expect(present("linter", r)).toBe(false); // apps/web is not scanned
});

test("#3107: a root Cargo.toml beside a nested JS tool (rust-analyzer layout) stays rust", async () => {
  write("Cargo.toml", '[package]\nname = "ra"\n');
  write("editors/code/package.json", JSON.stringify({ name: "vscode-ext" }));
  const r = await analyzeReadiness(dir);
  expect(r.ecosystem).toBe("rust");
  expect((await scanEcosystem(dir)).ecosystem).toBe("rust");
});

test("#3107: a depth-2 Cargo.toml only is found by the deep pass", async () => {
  write("crates/core/Cargo.toml", '[package]\nname = "core"\n');
  expect((await analyzeReadiness(dir)).ecosystem).toBe("rust");
});

test("#3109: bootstrap checklist renders every JS guardrail with the readiness install steps", () => {
  const list = bootstrapGuardrailChecklist("js-ts", "bun");
  for (const g of GUARDRAILS)
    for (const cmd of INSTALL_STEPS[g.id](PM_VERBS.bun)) expect(list).toContain(`$ ${cmd}`);
  expect(list).toContain('package-ecosystem: "bun"');
  expect(list).toContain("ISSUE_TEMPLATE/task.md");
});

test("#3109: bootstrap checklist for rust uses the cargo tooling", () => {
  const list = bootstrapGuardrailChecklist("rust", "bun");
  expect(list).toContain("$ rustup component add clippy");
  expect(list).toContain("cargo machete");
  expect(list).not.toContain("husky init");
});

test("#3109: the generated CLAUDE.md still carries the shared blind-spots section", async () => {
  write("package.json", JSON.stringify({ name: "x" }));
  expect((await analyzeReadiness(dir)).claudeMd).toContain(GUARDRAIL_BLIND_SPOTS);
});

// ── #4080: ts_strict — tsconfig strictness ──────────────────────────────────────

function tsStrict(report: ReadinessReport) {
  return report.checks.find((c) => c.id === "ts_strict");
}

function tsRepo(tsconfig: string) {
  pkg({ name: "ts", devDependencies: { typescript: "^6" } });
  write("tsconfig.json", tsconfig);
}

test("#4080: analyzeReadiness is async (no sync tsconfig reads on the server loop)", async () => {
  tsRepo('{ "compilerOptions": { "strict": true } }');
  const pending = analyzeReadiness(dir);
  expect(pending).toBeInstanceOf(Promise);
  expect(tsStrict(await pending)?.present).toBe(true);
});

test("#4080: strict: true → ts_strict present with evidence", async () => {
  tsRepo('{ "compilerOptions": { "strict": true } }');
  const c = tsStrict(await analyzeReadiness(dir));
  expect(c?.present).toBe(true);
  expect(c?.weight).toBe(6);
  expect(c?.evidence).toEqual(["tsconfig.json strict"]);
});

test("#4080: strict: false → absent, prescription names the reason and the fix", async () => {
  tsRepo('{ "compilerOptions": { "strict": false } }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(present("type_checker", r)).toBe(true);
  expect(r.claudeMd).toContain("`tsconfig.json`: strict: false.");
  expect(r.claudeMd).toContain('Set `"strict": true` in `compilerOptions`');
});

test("#4080: strict unset → absent (TypeScript default is off)", async () => {
  tsRepo('{ "compilerOptions": { "target": "ESNext" } }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("strict not set (TypeScript default: off)");
});

test("#4080: typescript dep without a tsconfig → applies, absent", async () => {
  pkg({ name: "ts", devDependencies: { typescript: "^6" } });
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("No tsconfig.json found");
});

test("#4080: a pure-JS repo is not scored on ts_strict", async () => {
  pkg({ name: "js" });
  expect(tsStrict(await analyzeReadiness(dir))).toBeUndefined();
});

test("#4080: JSONC (comments, trailing commas) is parsed", async () => {
  tsRepo(`{
  // server config
  "compilerOptions": {
    /* the bar */
    "strict": true,
    "noUncheckedIndexedAccess": true,
  },
}`);
  const c = tsStrict(await analyzeReadiness(dir));
  expect(c?.present).toBe(true);
  expect(c?.evidence).toEqual(["tsconfig.json strict", "tsconfig.json noUncheckedIndexedAccess"]);
});

test("#4080: a local extends chain is followed (suffix-less relative base)", async () => {
  tsRepo('{ "extends": "./config/base" }');
  write("config/base.json", '{ "extends": "../strict.json" }');
  write("strict.json", '{ "compilerOptions": { "strict": true } }');
  expect(tsStrict(await analyzeReadiness(dir))?.present).toBe(true);
});

test("#4080: the child's own strict: false overrides a strict base", async () => {
  tsRepo('{ "extends": "./base.json", "compilerOptions": { "strict": false } }');
  write("base.json", '{ "compilerOptions": { "strict": true } }');
  expect(tsStrict(await analyzeReadiness(dir))?.present).toBe(false);
});

test("#4080: an unresolvable package base → strictness unknown, never a pass", async () => {
  tsRepo('{ "extends": "@tsconfig/strictest/tsconfig.json" }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain(
    "extends `@tsconfig/strictest/tsconfig.json` (package base, not resolved)",
  );
});

test("#4080: a package base with an explicit child strict: true passes", async () => {
  tsRepo('{ "extends": "@sveltejs/kit/tsconfig", "compilerOptions": { "strict": true } }');
  expect(tsStrict(await analyzeReadiness(dir))?.present).toBe(true);
});

test("#4080: a missing generated base (.svelte-kit) is unknown", async () => {
  tsRepo('{ "extends": "./.svelte-kit/tsconfig.json" }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("extends `./.svelte-kit/tsconfig.json`: not found");
});

test("#4080: array extends — the later base wins", async () => {
  write("strict.json", '{ "compilerOptions": { "strict": true } }');
  write("loose.json", '{ "compilerOptions": { "strict": false } }');
  tsRepo('{ "extends": ["./strict.json", "./loose.json"] }');
  expect(tsStrict(await analyzeReadiness(dir))?.present).toBe(false);
  write("tsconfig.json", '{ "extends": ["./loose.json", "./strict.json"] }');
  expect(tsStrict(await analyzeReadiness(dir))?.present).toBe(true);
});

test("#4080: an extends cycle is unknown, not a hang", async () => {
  tsRepo('{ "extends": "./a.json" }');
  write("a.json", '{ "extends": "./tsconfig.json", "compilerOptions": {} }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("extends cycle");
});

test("#4080: a base outside the repo is never read", async () => {
  const outside = mkdtempSync(join(tmpdir(), "shepherd-readiness-outside-"));
  try {
    writeFileSync(join(outside, "strict.json"), '{ "compilerOptions": { "strict": true } }');
    tsRepo(JSON.stringify({ extends: `../${basename(outside)}/strict.json` }));
    const r = await analyzeReadiness(dir);
    expect(tsStrict(r)?.present).toBe(false);
    expect(r.claudeMd).toContain("outside the repository");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("#4080: the extends chain is bounded", async () => {
  tsRepo('{ "extends": "./b1.json" }');
  for (let i = 1; i < 12; i++) write(`b${i}.json`, `{ "extends": "./b${i + 1}.json" }`);
  write("b12.json", '{ "compilerOptions": { "strict": true } }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("extends chain exceeds 8 configs");
});

test("#4080: an oversized tsconfig is unknown", async () => {
  tsRepo(`{ "compilerOptions": { "strict": true } }${" ".repeat(256 * 1024)}`);
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("`tsconfig.json`: larger than 256 KiB.");
});

test("#4080: unparseable tsconfig is unknown", async () => {
  tsRepo("{ not json");
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("`tsconfig.json`: unparseable JSONC.");
});

test("#4080: multi-root — one loose package tsconfig fails the check", async () => {
  write("ui/package.json", JSON.stringify({ devDependencies: { typescript: "^6" } }));
  write("ui/tsconfig.json", '{ "compilerOptions": { "strict": true } }');
  write("ext/package.json", JSON.stringify({ name: "ext" }));
  write("ext/tsconfig.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("`ext/tsconfig.json`: strict not set");
  write("ext/tsconfig.json", '{ "compilerOptions": { "strict": true } }');
  expect(tsStrict(await analyzeReadiness(dir))?.evidence).toEqual([
    "ext/tsconfig.json strict",
    "ui/tsconfig.json strict",
  ]);
});

const VITE_SOLUTION = `{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
}`;

test("#4080: a solution-style root (create-vite) is judged by its references", async () => {
  tsRepo(VITE_SOLUTION);
  write("tsconfig.app.json", '{ "compilerOptions": { "strict": true } }');
  write("tsconfig.node.json", '{ "compilerOptions": { "strict": true } }');
  expect(tsStrict(await analyzeReadiness(dir))?.evidence).toEqual([
    "tsconfig.app.json strict",
    "tsconfig.node.json strict",
  ]);
});

test("#4080: a loose referenced project fails and is named, not the solution root", async () => {
  tsRepo(VITE_SOLUTION);
  write("tsconfig.app.json", '{ "compilerOptions": { "strict": true } }');
  write("tsconfig.node.json", "{}");
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("`tsconfig.node.json`: strict not set");
  expect(r.claudeMd).not.toContain("`tsconfig.json`:");
});

test("#4080: a missing reference is unknown; a directory reference means its tsconfig.json", async () => {
  tsRepo('{ "files": [], "references": [{ "path": "./packages/core" }] }');
  let r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("`packages/core/tsconfig.json`: not found.");
  write("packages/core/tsconfig.json", '{ "compilerOptions": { "strict": true } }');
  r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.evidence).toEqual(["packages/core/tsconfig.json strict"]);
});

test("#4080: an Nx-style root (include: [], files absent or empty) compiles nothing", async () => {
  for (const shape of ['"include": []', '"files": [], "include": []']) {
    tsRepo(`{ ${shape}, "references": [{ "path": "./tsconfig.lib.json" }] }`);
    write("tsconfig.lib.json", '{ "compilerOptions": { "strict": true } }');
    const r = await analyzeReadiness(dir);
    expect(tsStrict(r)?.evidence).toEqual(["tsconfig.lib.json strict"]);
    write("tsconfig.lib.json", "{}");
    const loose = await analyzeReadiness(dir);
    expect(loose.claudeMd).toContain("`tsconfig.lib.json`: strict not set");
    expect(loose.claudeMd).not.toContain("`tsconfig.json`:");
  }
});

test("#4080: a referenced solution-style config is unknown, naming its references", async () => {
  tsRepo('{ "files": [], "references": [{ "path": "./packages" }] }');
  write(
    "packages/tsconfig.json",
    '{ "files": [], "references": [{ "path": "./a" }], "compilerOptions": { "strict": true } }',
  );
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain(
    "`packages/tsconfig.json`: solution-style config; its references (`packages/a/tsconfig.json`) are not followed.",
  );
});

test("#4080: an absolute reference is never read", async () => {
  tsRepo('{ "files": [], "references": [{ "path": "/etc/tsconfig.json" }] }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toMatch(/`\/etc\/tsconfig\.json`: (not found|outside the repository)\./);
});

test("#4080: a root with references that also compiles files must be strict itself", async () => {
  tsRepo('{ "references": [{ "path": "./tsconfig.node.json" }] }');
  write("tsconfig.node.json", '{ "compilerOptions": { "strict": true } }');
  const r = await analyzeReadiness(dir);
  expect(tsStrict(r)?.present).toBe(false);
  expect(r.claudeMd).toContain("`tsconfig.json`: strict not set");
});

test("#4080: Shepherd's own repo scores ts_strict present", async () => {
  const c = tsStrict(await analyzeReadiness(join(import.meta.dir, "..")));
  expect(c?.present).toBe(true);
  expect(c?.evidence).toContain("tsconfig.json strict");
});

// ── swallowed_errors: config-text evidence, conditional on an ESLint config (#4081) ──

const SWALLOW = "swallowed_errors" as const;
const check = (r: Awaited<ReturnType<typeof analyzeReadiness>>) =>
  r.checks.find((c) => c.id === SWALLOW);

test("swallowed_errors is omitted when the repo has no ESLint config", async () => {
  pkg({ name: "lib", devDependencies: { eslint: "^9" } });
  expect(check(await analyzeReadiness(dir))).toBeUndefined();
});

test("an .eslintrc.yml alone (linter absent) does not make swallowed_errors apply", async () => {
  pkg({ name: "lib" });
  write(".eslintrc.yml", "extends: eslint:recommended\nrules:\n  promise/catch-or-return: error\n");
  expect(present("linter", await analyzeReadiness(dir))).toBe(false);
  expect(check(await analyzeReadiness(dir))).toBeUndefined();

  pkg({ name: "lib", devDependencies: { eslint: "^9" } });
  expect(check(await analyzeReadiness(dir))?.present).toBe(true);
});

test("recommended + no-floating-promises in the config text → present, evidence from both groups", async () => {
  pkg({ name: "app", devDependencies: { eslint: "^9" } });
  write(
    "eslint.config.js",
    `import js from "@eslint/js";\nexport default [js.configs.recommended, { rules: { "@typescript-eslint/no-floating-promises": "error" } }];\n`,
  );
  expect(check(await analyzeReadiness(dir))).toEqual({
    id: SWALLOW,
    present: true,
    weight: 3,
    evidence: ["mentions eslint recommended (no-empty)", "mentions no-floating-promises"],
  });
});

test("only the empty-catch group → applies, absent, prescribed with the snippet and verify note", async () => {
  pkg({ name: "app", devDependencies: { eslint: "^9" } });
  write("eslint.config.mjs", `export default [{ rules: { "no-empty": "error" } }];\n`);
  const r = await analyzeReadiness(dir);
  expect(check(r)).toEqual({ id: SWALLOW, present: false, weight: 3, evidence: [] });
  expect(r.claudeMd).toContain("Swallowed-error lint rules");
  expect(r.claudeMd).toContain("verify");
  expect(r.claudeMd).toContain("CallExpression[callee.property.name='catch']");
  expect(r.claudeMd).toContain("best-effort");
  expect(INSTALL_STEPS[SWALLOW](PM_VERBS.bun)).toEqual([]);
});

test("no-empty + a no-restricted-syntax .catch selector → present", async () => {
  pkg({ name: "app", devDependencies: { eslint: "^9" } });
  write(
    "eslint.config.js",
    `export default [{ rules: { "no-empty": "error", "no-restricted-syntax": ["error", { selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression" }] } }];\n`,
  );
  expect(check(await analyzeReadiness(dir))?.evidence).toEqual([
    "mentions no-empty",
    "mentions no-restricted-syntax .catch selector",
  ]);
});

test("no-empty-function does not count as the empty-catch rule", async () => {
  pkg({ name: "app", devDependencies: { eslint: "^9" } });
  write(
    "eslint.config.js",
    `export default [{ rules: { "no-empty-function": "error", "no-floating-promises": "error" } }];\n`,
  );
  expect(check(await analyzeReadiness(dir))?.present).toBe(false);
});

test("an .eslintrc.json in a package subdirectory is read", async () => {
  write("ui/package.json", JSON.stringify({ name: "ui", devDependencies: { eslint: "^8" } }));
  write(
    "ui/.eslintrc.json",
    JSON.stringify({
      extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended-type-checked"],
    }),
  );
  expect(check(await analyzeReadiness(dir))?.present).toBe(true);
});

test("a rule mentioned past the 64 KiB read cap is not detected", async () => {
  pkg({ name: "app", devDependencies: { eslint: "^9" } });
  write(
    "eslint.config.js",
    `// "no-empty"\n${"/".repeat(70 * 1024)}\n// no-floating-promises\nexport default [];\n`,
  );
  expect(check(await analyzeReadiness(dir))?.present).toBe(false);
});

test("Shepherd's own repo scores swallowed_errors present", async () => {
  expect(check(await analyzeReadiness(join(import.meta.dir, "..")))?.present).toBe(true);
});

test("bootstrap checklist prescribes the swallowed-error lint rules", () => {
  expect(bootstrapGuardrailChecklist("js-ts", "bun")).toContain("Swallowed-error lint rules");
});
