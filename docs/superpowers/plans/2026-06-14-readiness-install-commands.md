# Readiness Install Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Amend the readiness analyzer's generated `CLAUDE.md` prescription so each missing guardrail carries the exact package-manager-aware shell commands to install it.

**Architecture:** Server-side only. Detect the target repo's package manager (`packageManager` field → root lockfile → `npm` fallback), then fold per-guardrail install commands into the existing "Adopt these guardrails" section of the verbatim `claudeMd` snippet that the panel's Copy / Send-to-task buttons already carry. The "Adopt" section already lists only absent guardrails, so the output is already score-adaptive. One feature-discovery catalog entry is added per house rules.

**Tech Stack:** TypeScript, Bun test runner. Files: `src/readiness.ts`, `test/readiness.test.ts`, `ui/src/lib/feature-announcements.ts`, `ui/messages/{en,de}.json`.

---

## Context for the implementer

- `src/readiness.ts` scans a repo and returns a `ReadinessReport`. `scanRepo(dir)` builds a `RepoScan` (`deps`, `scripts`, `has`, `glob`); `analyzeReadiness` runs the `GUARDRAILS` detectors and calls `generateClaudeMd(scan, checks)` to produce the verbatim prescription.
- The `claudeMd` snippet is an **i18n-exempt verbatim artifact** (its doc comment says so) — the install commands ride inside it, so **no message keys** are added for the commands.
- Tables `TOOLING_LABEL` and `CHURN_PLAIN` are exhaustive `Record<GuardrailId, …>`. The new `INSTALL_STEPS` table follows the same shape so a future guardrail is forced to declare its steps.
- Root tests run with `bun test ./test`. `GUARDRAILS` is already exported and used by the test file.

---

## Task 1: Package-manager detection

**Files:**
- Modify: `src/readiness.ts` (add `PackageManager` type + `pickPackageManager` export; capture `packageManager` field in `collectManifest`; add `pm` to `RepoScan` and compute it in `scanRepo`)
- Test: `test/readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/readiness.test.ts` (extend the import on line 5 to include `pickPackageManager`):

```ts
import {
  analyzeReadiness,
  GUARDRAILS,
  pickPackageManager,
  type GuardrailId,
} from "../src/readiness";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/readiness.test.ts`
Expected: FAIL — `pickPackageManager` is not exported / not a function.

- [ ] **Step 3: Implement detection in `src/readiness.ts`**

Add the type near the top exports (after the `GuardrailId` union, around line 29):

```ts
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";
```

Add the `pm` field to the `RepoScan` interface (after `glob`, around line 60):

```ts
  /** Detected package manager — drives the install verbs in the prescription. */
  pm: PackageManager;
```

Add the pure resolver (place it just above `scanRepo`, around line 270):

```ts
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
```

Extend `collectManifest` to capture the field. Change its signature and body (currently lines 253-268):

```ts
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
```

Rewrite `scanRepo` (currently lines 270-298) so `has`/`glob` are locals reused for `pm`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/readiness.test.ts`
Expected: PASS (all three new `pickPackageManager` tests, plus the existing suite still green).

- [ ] **Step 5: Commit**

```bash
git add src/readiness.ts test/readiness.test.ts
git commit -m "feat(readiness): detect target repo package manager"
```

---

## Task 2: Per-guardrail install commands in the prescription

**Files:**
- Modify: `src/readiness.ts` (add `PM_VERBS` + `INSTALL_STEPS` exports; amend `generateClaudeMd`)
- Test: `test/readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the import to add `INSTALL_STEPS, PM_VERBS`, then append:

```ts
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
  // No-package guardrails (ci / agent_instructions / dependency_automation) contribute none.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/readiness.test.ts`
Expected: FAIL — `INSTALL_STEPS` / `PM_VERBS` not exported; `claudeMd` has no `$` command lines.

- [ ] **Step 3: Implement in `src/readiness.ts`**

Add the verb map + steps table next to `TOOLING_LABEL` / `CHURN_PLAIN` (after line 386):

```ts
/** Dev-add + exec verbs per package manager (verbatim — feed the generated artifact). */
export const PM_VERBS: Record<PackageManager, { add: string; exec: string }> = {
  bun: { add: "bun add -d", exec: "bunx" },
  pnpm: { add: "pnpm add -D", exec: "pnpm dlx" },
  yarn: { add: "yarn add -D", exec: "yarn dlx" },
  npm: { add: "npm i -D", exec: "npx" },
};

/**
 * Concrete install steps per guardrail for the detected package manager. An empty
 * array means there is no package to install — the guardrail is satisfied by
 * creating a file (a CI workflow, a CLAUDE.md, a dependabot config), so the
 * prescription keeps only its prose line. Exhaustive Record so a new guardrail is
 * forced to declare its steps (matches TOOLING_LABEL / CHURN_PLAIN).
 */
export const INSTALL_STEPS: Record<
  GuardrailId,
  (v: { add: string; exec: string }) => string[]
> = {
  pre_push_ci: (v) => [`${v.add} husky`, `${v.exec} husky init`],
  git_hooks: (v) => [`${v.add} husky`, `${v.exec} husky init`],
  type_checker: (v) => [`${v.add} typescript`, `${v.exec} tsc --init`],
  linter: (v) => [`${v.add} eslint @eslint/js`],
  formatter: (v) => [`${v.add} prettier`],
  test_runner: (v) => [`${v.add} vitest`],
  lint_staged: (v) => [`${v.add} lint-staged`],
  commit_lint: (v) => [`${v.add} @commitlint/cli @commitlint/config-conventional`],
  dead_code_audit: (v) => [`${v.add} fallow`],
  agent_instructions: () => [],
  ci: () => [],
  dependency_automation: () => [],
};
```

Amend `generateClaudeMd` (currently lines 333-370) — only the `adoptLines` construction changes; pull the verbs from `scan.pm`:

```ts
function generateClaudeMd(scan: RepoScan, checks: GuardrailCheck[]): string {
  const isTs = scan.deps.has("typescript") || scan.has("tsconfig.json");
  const stack = isTs ? "TypeScript" : "JavaScript";
  const missing = checks.filter((c) => !c.present).sort((a, b) => b.weight - a.weight);
  const verbs = PM_VERBS[scan.pm];

  const adoptLines = missing.length
    ? missing
        .map((c) => {
          const head = `- ${TOOLING_LABEL[c.id]} — ${CHURN_PLAIN[c.id]}`;
          const cmds = INSTALL_STEPS[c.id](verbs);
          return cmds.length ? `${head}\n${cmds.map((cmd) => `    $ ${cmd}`).join("\n")}` : head;
        })
        .join("\n")
    : "- None — your deterministic guardrails already cover the baseline.";

  return `# House rules for AI agents (${stack})
```

(Leave the entire template literal body from `# House rules…` through the closing `` ` `` and `}` unchanged — only the lines above the `return` were edited.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/readiness.test.ts`
Expected: PASS (new command tests + existing suite green).

- [ ] **Step 5: Commit**

```bash
git add src/readiness.ts test/readiness.test.ts
git commit -m "feat(readiness): fold install commands into the prescription"
```

---

## Task 3: Feature-discovery catalog entry

**Files:**
- Modify: `ui/src/lib/feature-announcements.ts` (append one entry)
- Modify: `ui/messages/en.json`, `ui/messages/de.json` (add title + body keys)

- [ ] **Step 1: Append the catalog entry**

Add as the last element of the `featureAnnouncements` array in `ui/src/lib/feature-announcements.ts` (after the `epic-landing-pr` entry):

```ts
  {
    // No targetId: the prescription lives in the Backlog → Readiness panel's
    // generated-snippet block (Copy / Send-to-task), several clicks deep — surface
    // via the What's-New drawer only. 1.29.0 is the latest released tag, so this
    // ships in 1.30.0.
    id: "readiness-install-commands",
    sinceVersion: "1.30.0",
    titleKey: "feat_readiness_install_commands_title",
    bodyKey: "feat_readiness_install_commands_body",
  },
```

- [ ] **Step 2: Add the EN keys**

In `ui/messages/en.json`, add alongside the other `feat_*` keys:

```json
  "feat_readiness_install_commands_title": "Copy-paste setup commands in Readiness",
  "feat_readiness_install_commands_body": "The Readiness prescription now lists the exact install commands for your repo's package manager, so each missing guardrail can be adopted without looking the steps up."
```

- [ ] **Step 3: Add the DE keys**

In `ui/messages/de.json`, add the matching keys (same key names — parity is enforced):

```json
  "feat_readiness_install_commands_title": "Kopierfertige Setup-Befehle in Readiness",
  "feat_readiness_install_commands_body": "Die Readiness-Empfehlung listet jetzt die exakten Installationsbefehle für den Paketmanager deines Repos auf, sodass jede fehlende Schutzregel ohne Nachschlagen übernommen werden kann."
```

- [ ] **Step 4: Verify i18n parity**

Run: `cd ui && bun install && bun run check:i18n`
Expected: PASS — EN/DE catalogs share an identical key set.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/feature-announcements.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(readiness): announce install commands in What's-New"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Root install + lint + types + tests**

Run:
```bash
bun install
bun run lint
bunx tsc --noEmit
bun test ./test
```
Expected: all PASS. The readiness suite includes the new detection + command tests.

- [ ] **Step 2: UI check**

Run:
```bash
cd ui && bun install && bun run check && bun run check:i18n
```
Expected: PASS (svelte-check clean, catalog parity holds).

- [ ] **Step 3: Dead-code / complexity gate**

Run: `bunx fallow audit --base origin/main --fail-on-issues`
Expected: no new dead code or cognitive-complexity regressions. (`INSTALL_STEPS`, `PM_VERBS`, `pickPackageManager` are all wired into a real path + tests.)

- [ ] **Step 4: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --fill
```
The PR description should note: server-only readiness enrichment; the `claudeMd` snippet is the i18n-exempt verbatim artifact that gains the commands; one What's-New entry added.

---

## Self-Review (completed)

- **Spec coverage:** PM detection (Task 1) ✓; verb map + INSTALL_STEPS + amended `generateClaudeMd` (Task 2) ✓; no-package guardrails return `[]` and stay one-line (Task 2, asserted) ✓; i18n-exempt artifact, single catalog entry + EN/DE keys (Task 3) ✓; tests for detection + command emission + no-spurious-commands (Tasks 1-2) ✓; verification incl. fallow (Task 4) ✓.
- **Placeholders:** none — every code/JSON step shows full content.
- **Type consistency:** `PackageManager`, `pickPackageManager(field, has)`, `RepoScan.pm`, `PM_VERBS`, `INSTALL_STEPS[id](v)` used identically across tasks and tests. `generateClaudeMd(scan, checks)` signature unchanged (reads `scan.pm`).
