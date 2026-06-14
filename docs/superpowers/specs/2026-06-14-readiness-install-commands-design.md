# Readiness prescription: package-manager-aware install commands

## Problem

The Backlog "Readiness" panel scores a target repo's guardrails and generates a
verbatim `CLAUDE.md` prescription (`src/readiness.ts` → `generateClaudeMd`),
surfaced via the panel's **Copy** and **Send to task** buttons. The "Adopt these
guardrails" section names each missing guardrail and the AI↔human churn it
removes, but it is **descriptive, not executable** — it says _"A linter
(eslint/ruff)"_, never the command to install it. A user (or the agent the
prescription is sent to) still has to figure out the exact `add`/`init` steps.

## Goal

Amend the existing generated prescription so each **missing** guardrail carries
the exact shell commands to install it, for the target repo's **detected package
manager**. Because the "Adopt" section already lists only absent guardrails, the
output is already score-adaptive: a high score (e.g. 83%) yields a short command
list, a low score (40%) a long one — no extra branching needed.

## Non-goals

- No config-file scaffolds (eslint.config.js bodies, hook script contents). The
  prescription tells you what to install, not the full config — commands only.
- No new panel UI. `ReadinessPanel.svelte` already renders `claudeMd` verbatim in
  its `<pre>` block and carries it through Copy / Send-to-task, so enriching the
  artifact is sufficient. The adopt-list rows stay as-is.
- No separate "install instructions" surface; we amend the existing copy-paste /
  create-task prescription, not add a parallel one.
- No new stacks. Stays on the dogfooded JS/TS baseline (same scope as the
  existing analyzer).

## Design

### 1. Package-manager detection (`src/readiness.ts`, `scanRepo`)

Add `pm: PackageManager` (`"bun" | "pnpm" | "yarn" | "npm"`) to `RepoScan`,
resolved in priority order:

1. `packageManager` field in the (first) package.json — parse the leading name
   (`"pnpm@9.0.0"` → `pnpm`).
2. Lockfile at the repo root: `bun.lock` / `bun.lockb` → `bun`;
   `pnpm-lock.yaml` → `pnpm`; `yarn.lock` → `yarn`; `package-lock.json` → `npm`.
3. Fallback: `npm` (the universal default for an undetermined JS/TS repo).

`collectManifest` already parses the root package.json; extend it (or add a small
sibling read) to capture the `packageManager` field. Detection is cheap,
deterministic file inspection — consistent with the analyzer's existing posture
(never executes target code).

### 2. PM verb mapping + command table

A small helper maps a `PackageManager` to its dev-add and exec verbs:

| pm   | add (dev)     | exec        |
| ---- | ------------- | ----------- |
| bun  | `bun add -d`  | `bunx`      |
| pnpm | `pnpm add -D` | `pnpm dlx`  |
| yarn | `yarn add -D` | `yarn dlx`  |
| npm  | `npm i -D`    | `npx`       |

A new const `INSTALL_STEPS: Record<GuardrailId, (pm) => string[]>` returns the
command line(s) per guardrail (empty array = no package to install):

- `pre_push_ci` → `<add> husky`, `<exec> husky init`
- `git_hooks` → `<add> husky`, `<exec> husky init`
- `type_checker` → `<add> typescript`, `<exec> tsc --init`
- `linter` → `<add> eslint @eslint/js`
- `formatter` → `<add> prettier`
- `test_runner` → `<add> vitest`
- `lint_staged` → `<add> lint-staged`
- `commit_lint` → `<add> @commitlint/cli @commitlint/config-conventional`
- `dead_code_audit` → `<add> fallow`
- `agent_instructions` → `[]` (you create a CLAUDE.md/AGENTS.md file, not install)
- `ci` → `[]` (you add a workflow file)
- `dependency_automation` → `[]` (you add a dependabot/renovate config file)

Fail-closed: a guardrail with no command returns `[]` and keeps only its existing
prose line — no fabricated command, no crash. The map is keyed by every
`GuardrailId` (exhaustive `Record`) so adding a guardrail forces an entry,
matching the existing `TOOLING_LABEL` / `CHURN_PLAIN` pattern.

### 3. Amend `generateClaudeMd`

For each missing guardrail in `adoptLines`, append its commands (from
`INSTALL_STEPS`) as an indented block beneath the existing
`- {label} — {churn}` line, each command prefixed `$ `:

```
- A linter (eslint/ruff) — without it you flag lint nits by hand instead of letting the gate do it.
    $ bun add -d eslint @eslint/js
```

Guardrails returning `[]` stay single-line. The "None — already covered" branch
and the rest of the snippet are unchanged. Still returned verbatim; still
i18n-exempt (see below).

### 4. i18n / feature discovery

- The `claudeMd` snippet is an explicitly **i18n-exempt verbatim artifact** (per
  its doc comment — generated for the _target_ repo, not app chrome). Commands
  ride inside it, so **no message keys** are added for the commands themselves.
- This is a user-facing improvement to a shipped feature, so add **one**
  `FeatureAnnouncement` to `ui/src/lib/feature-announcements.ts` (stable slug,
  next unreleased `sinceVersion`, `titleKey` + `bodyKey`) and the matching
  EN/DE keys in `ui/messages/{en,de}.json` — the only message keys this change
  introduces. (`check:i18n` enforces EN/DE parity.)

## Testing

Extend `test/readiness.test.ts`:

- **PM detection:** fixtures with each lockfile and with a `packageManager`
  field resolve to the right `pm`; field beats lockfile; none → `npm` fallback.
- **Commands present:** for a repo missing a given guardrail, the generated
  `claudeMd` contains the expected PM-correct command (`bun add -d eslint …` for
  a bun repo, `npm i -D eslint …` for an npm repo).
- **No spurious commands:** present guardrails emit no `$` line for themselves;
  no-package guardrails (`ci`, `agent_instructions`, `dependency_automation`)
  never emit a `$` line even when missing.

## Files touched

- `src/readiness.ts` — PM detection, verb map, `INSTALL_STEPS`, amend
  `generateClaudeMd`.
- `test/readiness.test.ts` — detection + command-emission cases.
- `ui/src/lib/feature-announcements.ts` + `ui/messages/{en,de}.json` — one
  discovery entry.

No change to `ReadinessPanel.svelte`, `readiness-view.ts`, the API, or types.

## Open questions

None.
