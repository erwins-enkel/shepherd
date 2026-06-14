// AI-readiness analyzer (Backlog "Readiness" mode).
//
// Scores how well a target repo's *deterministic guardrails* coach an AI agent
// so a human is not pulled in to re-explain mechanical defects. The baseline is
// exactly what Shepherd dogfoods in `.husky/pre-push` — we recommend outward what
// we enforce inward. Detection is cheap, deterministic file/script inspection;
// it never executes the target repo's code.
//
// Scope: the JS/TS baseline we dogfood (presence of a package.json — at the
// root or exactly one directory level down — gates applicability; deeper
// layouts like `apps/web/package.json` are not detected). Other stacks
// (Python/ruff/mypy) are a later generalization.

import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

export type GuardrailId =
  | "formatter"
  | "linter"
  | "type_checker"
  | "commit_lint"
  | "git_hooks"
  | "pre_push_ci"
  | "lint_staged"
  | "test_runner"
  | "dead_code_audit"
  | "ci"
  | "dependency_automation"
  | "agent_instructions";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface GuardrailCheck {
  id: GuardrailId;
  /** True when the guardrail is configured in the target repo. */
  present: boolean;
  /** Leverage-to-cut-AI-churn — higher means more human↔AI back-and-forth removed. */
  weight: number;
  /** Matched markers (file names / package fields). Verbatim data — not translated. */
  evidence: string[];
}

export interface ReadinessReport {
  /** False when the repo isn't a JS/TS project (no package.json at the root or one level down) — baseline N/A. */
  applicable: boolean;
  /** Weighted percentage (0–100) of present guardrails, derived from `checks`. */
  score: number;
  checks: GuardrailCheck[];
  /** Whether the repo already ships agent house-rules (CLAUDE.md/AGENTS.md). */
  hasAgentInstructions: boolean;
  /** Generated, stack-tailored house-rules snippet. Verbatim artifact — exempt from i18n. */
  claudeMd: string;
}

/** Inspection context built once per repo, so each detector is cheap. */
interface RepoScan {
  dir: string;
  deps: Set<string>;
  scripts: Record<string, string>;
  has: (rel: string) => boolean;
  /** Returns matching basenames in `subdir` (empty if missing). */
  glob: (subdir: string, test: (name: string) => boolean) => string[];
  /** Detected package manager — drives the install verbs in the prescription. */
  pm: PackageManager;
}

interface GuardrailDef {
  id: GuardrailId;
  weight: number;
  detect: (s: RepoScan) => string[];
}

const dep = (s: RepoScan, name: string) => s.deps.has(name);
const anyDep = (s: RepoScan, prefix: string) => [...s.deps].some((d) => d.startsWith(prefix));

/**
 * The dogfooded baseline. Order is leverage-ranked (also reflected by `weight`),
 * so the adopt-list — absent guardrails sorted by weight — leads with the hooks
 * that turn review from a human linter pass into substance-only review.
 */
export const GUARDRAILS: GuardrailDef[] = [
  {
    // The CI-mirror that lets the agent self-correct before a human ever sees it.
    id: "pre_push_ci",
    weight: 10,
    detect: (s) => {
      const ev: string[] = [];
      if (s.has(".husky/pre-push")) ev.push(".husky/pre-push");
      if (s.has("lefthook.yml") || s.has("lefthook.yaml")) ev.push("lefthook (pre-push)");
      return ev;
    },
  },
  {
    id: "git_hooks",
    weight: 9,
    detect: (s) => {
      const ev: string[] = [];
      if (s.has(".husky")) ev.push(".husky/");
      if (dep(s, "husky")) ev.push("husky");
      if (s.has("lefthook.yml") || s.has("lefthook.yaml") || dep(s, "lefthook"))
        ev.push("lefthook");
      if (s.has(".pre-commit-config.yaml")) ev.push("pre-commit");
      return ev;
    },
  },
  {
    id: "type_checker",
    weight: 9,
    detect: (s) => {
      const ev: string[] = [];
      if (s.has("tsconfig.json")) ev.push("tsconfig.json");
      if (dep(s, "typescript")) ev.push("typescript");
      if (s.scripts.typecheck || /tsc\b/.test(s.scripts["check"] ?? ""))
        ev.push("typecheck script");
      return ev;
    },
  },
  {
    id: "linter",
    weight: 8,
    detect: (s) => {
      const ev: string[] = [];
      if (s.has("eslint.config.js") || s.has("eslint.config.mjs") || s.has("eslint.config.ts"))
        ev.push("eslint.config");
      if (
        s.has(".eslintrc") ||
        s.has(".eslintrc.json") ||
        s.has(".eslintrc.cjs") ||
        s.has(".eslintrc.js")
      )
        ev.push(".eslintrc");
      if (dep(s, "eslint")) ev.push("eslint");
      if (s.scripts.lint) ev.push("lint script");
      return ev;
    },
  },
  {
    id: "formatter",
    weight: 8,
    detect: (s) => {
      const ev: string[] = [];
      if (s.glob(".", (n) => n.startsWith(".prettierrc")).length) ev.push("prettier config");
      if (dep(s, "prettier")) ev.push("prettier");
      if (s.scripts.format) ev.push("format script");
      return ev;
    },
  },
  {
    id: "test_runner",
    weight: 8,
    detect: (s) => {
      const t = s.scripts.test ?? "";
      // The npm-init placeholder ("no test specified") is not a real test runner.
      return t && !/no test specified/.test(t) ? ["test script"] : [];
    },
  },
  {
    id: "agent_instructions",
    weight: 8,
    detect: (s) => {
      const ev: string[] = [];
      if (s.has("CLAUDE.md")) ev.push("CLAUDE.md");
      if (s.has("AGENTS.md")) ev.push("AGENTS.md");
      if (s.has(".cursorrules")) ev.push(".cursorrules");
      return ev;
    },
  },
  {
    id: "ci",
    weight: 6,
    detect: (s) => {
      const ev: string[] = [];
      const wf = s.glob(".github/workflows", (n) => n.endsWith(".yml") || n.endsWith(".yaml"));
      if (wf.length) ev.push(`.github/workflows (${wf.length})`);
      if (s.has(".gitlab-ci.yml")) ev.push(".gitlab-ci.yml");
      return ev;
    },
  },
  {
    id: "dependency_automation",
    weight: 5,
    detect: (s) => {
      const ev: string[] = [];
      if (s.has(".github/dependabot.yml") || s.has(".github/dependabot.yaml"))
        ev.push("dependabot.yml");
      if (
        s.has("renovate.json") ||
        s.has("renovate.json5") ||
        s.has(".github/renovate.json") ||
        s.has(".github/renovate.json5") ||
        s.glob(".", (n) => n.startsWith(".renovaterc")).length
      )
        ev.push("renovate config");
      return ev;
    },
  },
  {
    id: "lint_staged",
    weight: 5,
    detect: (s) => {
      const ev: string[] = [];
      if (dep(s, "lint-staged")) ev.push("lint-staged");
      if (s.glob(".", (n) => n.startsWith(".lintstagedrc")).length) ev.push("lint-staged config");
      return ev;
    },
  },
  {
    id: "commit_lint",
    weight: 4,
    detect: (s) => {
      const ev: string[] = [];
      if (s.glob(".", (n) => n.startsWith("commitlint.config")).length)
        ev.push("commitlint.config");
      if (anyDep(s, "@commitlint/")) ev.push("@commitlint");
      if (s.has(".husky/commit-msg")) ev.push(".husky/commit-msg");
      return ev;
    },
  },
  {
    id: "dead_code_audit",
    weight: 3,
    detect: (s) => {
      const ev: string[] = [];
      if (s.glob(".", (n) => n.startsWith(".fallowrc")).length) ev.push("fallow config");
      if (dep(s, "fallow") || dep(s, "knip") || dep(s, "ts-prune")) ev.push("dead-code tool");
      return ev;
    },
  },
];

/**
 * Package roots relative to `dir`: `""` when the root has a manifest, else
 * first-level subdirectories with one (mixed-stack repos whose JS/TS lives in
 * a subproject, e.g. `ui/` next to Python). Empty → not a JS/TS repo.
 *
 * Known limits, accepted to keep the scan cheap: detection descends exactly
 * one level (`apps/web/package.json` is missed), and a root manifest
 * short-circuits the subproject scan — a workspaces-only root whose tooling
 * lives in subpackages is scored from the root manifest alone.
 */
function findPackageRoots(dir: string): string[] {
  if (existsSync(join(dir, "package.json"))) return [""];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .filter((n) => existsSync(join(dir, n, "package.json")))
    .sort();
}

/**
 * Resolves the target repo's package manager from its `packageManager` field
 * (highest authority), else a root lockfile, else `npm` (universal fallback).
 * Pure: `has(rel)` is the scan's root-aware existence probe, so detection spans
 * the repo root and any package subdir without re-reading the tree.
 */
export function pickPackageManager(
  field: string | undefined,
  has: (rel: string) => boolean,
): PackageManager {
  const name = field?.split("@")[0]?.trim();
  if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json")) return "npm";
  return "npm";
}

/** Merges one package.json's deps + scripts (+ first packageManager) into the accumulators. */
function collectManifest(
  file: string,
  deps: Set<string>,
  scripts: Record<string, string>,
  meta: { packageManager?: string },
) {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    packageManager?: string;
  } = {};
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Malformed package.json (findPackageRoots guarantees the file exists):
    // still a JS/TS repo, just no resolvable deps/scripts.
  }
  for (const d of Object.keys(pkg.dependencies ?? {})) deps.add(d);
  for (const d of Object.keys(pkg.devDependencies ?? {})) deps.add(d);
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) scripts[name] ??= cmd;
  meta.packageManager ??= pkg.packageManager;
}

function scanRepo(dir: string): RepoScan | null {
  const pkgRoots = findPackageRoots(dir);
  if (pkgRoots.length === 0) return null; // not a JS/TS repo → baseline N/A

  const deps = new Set<string>();
  const scripts: Record<string, string> = {};
  const meta: { packageManager?: string } = {};
  for (const root of pkgRoots)
    collectManifest(join(dir, root, "package.json"), deps, scripts, meta);

  // Repo-level markers (.husky, .github/workflows, CLAUDE.md) stay at the
  // root, so file checks span the repo root + each package dir.
  const roots = pkgRoots[0] === "" ? pkgRoots : ["", ...pkgRoots];
  const has = (rel: string) => roots.some((root) => existsSync(join(dir, root, rel)));
  const glob = (subdir: string, test: (name: string) => boolean) => {
    const names = new Set<string>();
    for (const root of roots) {
      try {
        for (const n of readdirSync(join(dir, root, subdir)).filter(test)) names.add(n);
      } catch {
        // missing dir in this root
      }
    }
    return [...names];
  };
  return { dir, deps, scripts, has, glob, pm: pickPackageManager(meta.packageManager, has) };
}

export function analyzeReadiness(dir: string): ReadinessReport {
  const scan = scanRepo(dir);
  if (!scan) {
    return { applicable: false, score: 0, checks: [], hasAgentInstructions: false, claudeMd: "" };
  }

  const checks: GuardrailCheck[] = GUARDRAILS.map((g) => {
    const evidence = g.detect(scan);
    return { id: g.id, present: evidence.length > 0, weight: g.weight, evidence };
  });

  // Score derived from the checks array — never a hardcoded denominator.
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.present ? c.weight : 0), 0);
  const score = total === 0 ? 0 : Math.round((100 * got) / total);

  const hasAgentInstructions = checks.find((c) => c.id === "agent_instructions")?.present ?? false;

  return {
    applicable: true,
    score,
    checks,
    hasAgentInstructions,
    claudeMd: generateClaudeMd(scan, checks),
  };
}

/**
 * A repo-tailored house-rules snippet encoding the surgical/mechanical posture
 * (generalized from Shepherd's own `<shepherd-house-rules>` + Karpathy posture),
 * plus a prescription of the missing tooling. Returned verbatim — it's a generated
 * artifact for the *target* repo, not app chrome, so it is exempt from i18n.
 */
function generateClaudeMd(scan: RepoScan, checks: GuardrailCheck[]): string {
  const isTs = scan.deps.has("typescript") || scan.has("tsconfig.json");
  const stack = isTs ? "TypeScript" : "JavaScript";
  const missing = checks.filter((c) => !c.present).sort((a, b) => b.weight - a.weight);

  const adoptLines = missing.length
    ? missing.map((c) => `- ${TOOLING_LABEL[c.id]} — ${CHURN_PLAIN[c.id]}`).join("\n")
    : "- None — your deterministic guardrails already cover the baseline.";

  return `# House rules for AI agents (${stack})

Generated by Shepherd's AI-readiness analyzer. The goal: let an agent ship here
with minimal human back-and-forth by having deterministic guardrails do the
coaching — the gate fails, the agent self-corrects, a human is never pulled in to
re-explain a mechanical defect.

## Engineering posture (surgical & mechanical)

- **Simplicity first.** Write the minimum code that solves the stated problem —
  no speculative features, abstractions for single use, or config nobody asked for.
- **Surgical changes.** Every changed line traces to the request. Don't refactor,
  reformat, or polish adjacent code; match existing style. Delete only what your
  change orphaned; surface pre-existing dead code rather than silently expanding the diff.
- **Fail closed.** Render error/unreachable paths as explicit failures; never let a
  swallowed error, empty result, or zero count masquerade as success.
- **Single source of truth.** Derive counts, totals, and dimensions from the data
  (array length, column count) — never hardcode a magic number that silently drifts.
- **Keep names and comments honest.** When you change a function's behavior, update
  its name, doc comment, and inline comments to match — no stale comment left behind.
- **No dead code.** Delete unreachable branches and unused fields/params, or wire
  them to a real path, before opening a PR.
- **Verify before claiming done.** Run the gate; show the output. Evidence before assertions.

## Adopt these guardrails (highest leverage first)

${adoptLines}
`;
}

/** Short tool name per guardrail, used in the generated prescription (verbatim artifact). */
const TOOLING_LABEL: Record<GuardrailId, string> = {
  pre_push_ci: "A pre-push hook that mirrors CI (husky/lefthook)",
  git_hooks: "A git-hook manager (husky/lefthook/pre-commit)",
  type_checker: "A type-checker (tsc/mypy) in the hook",
  linter: "A linter (eslint/ruff)",
  formatter: "A formatter (prettier/ruff fmt) + lint-staged",
  test_runner: "A test runner wired into the hook",
  agent_instructions: "A CLAUDE.md/AGENTS.md house-rules file",
  ci: "A CI workflow",
  dependency_automation: "Dependency automation (Dependabot/Renovate)",
  lint_staged: "lint-staged on staged files",
  commit_lint: "Conventional-commit lint (commitlint)",
  dead_code_audit: "A dead-code/complexity audit (fallow/knip)",
};

/** Plain-text "back-and-forth this removes" per guardrail (verbatim artifact). */
const CHURN_PLAIN: Record<GuardrailId, string> = {
  pre_push_ci:
    "without it the agent pushes red and waits on a human CI round-trip to learn what broke.",
  git_hooks: "without a hook manager, none of the checks below run automatically before a push.",
  type_checker:
    "without it you catch type errors in review that the agent could have caught itself.",
  linter: "without it you flag lint nits by hand instead of letting the gate do it.",
  formatter: "without it you hand-fix style in review; adopt prettier + lint-staged.",
  test_runner:
    "without tests in the hook, regressions reach you instead of failing the agent first.",
  agent_instructions: "without house rules, you re-explain the same posture in chat every task.",
  ci: "without CI, nothing independently re-checks what the agent self-reported.",
  dependency_automation:
    "without it dependency bumps pile up as manual busywork and stale-dep bugs reach you instead of an automated PR.",
  lint_staged:
    "without it the whole tree is re-checked or skipped; staged-only keeps the hook fast.",
  commit_lint: "without it you correct commit message format by hand.",
  dead_code_audit: "without it dead exports and unused deps accrete and you spot them by eye.",
};
