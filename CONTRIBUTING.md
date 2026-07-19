# Contributing to Shepherd

Thanks for your interest in Shepherd. This guide covers local setup, the quality
gates, and the conventions a PR needs to land.

> **The defining constraint:** Shepherd only ever _drives interactive terminal
> sessions_ — it never uses the Agent SDK or `claude -p`. If a feature can't be
> done by typing into a real terminal, it doesn't ship. See [`PRD.md`](./PRD.md)
> for the full ToS-compliance rationale before proposing anything that touches
> session control.

## Project layout

Shepherd is **two packages, each with its own dependencies and lockfile**:

| Package | Path  | Stack                                  |
| ------- | ----- | -------------------------------------- |
| Core    | `.`   | Bun + TypeScript HTTP/WebSocket server |
| UI      | `ui/` | SvelteKit 5 + Tailwind 4 SPA (static)  |

The repo directory is `tank/` for historical reasons; the product is **Shepherd**.

## Prerequisites

- [Bun](https://bun.sh) (the project pins `bun-version: latest` in CI)
- `git`

## Setup

Install dependencies in **both** packages — a fresh clone has no `node_modules`:

```bash
bun install            # root (core/server)
cd ui && bun install   # ui
```

The root `prepare` script wires up [Husky](https://typicode.github.io/husky/)
git hooks automatically on `bun install`.

## Quality gates

Gates run at three points. Don't bypass them — fix the underlying issue.

### Pre-commit (fast)

[`lint-staged`](https://github.com/lint-staged/lint-staged) runs on staged files only:

- `prettier --write` on `*.{ts,js,json,css,html,md,svelte}`
- `eslint --fix` on `*.{ts,svelte}`

### Commit message (commitlint)

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/).
A `commit-msg` hook rejects anything else.

```
<type>(<optional scope>): <subject>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`.

```bash
feat(ui): add status-light pulse on reconnect
fix(pty): demux stray OSC sequences before write
chore: bump svelte to 5.56
```

Keep subjects concise — sacrifice grammar for concision.

### Pre-push (parallel gate)

The `pre-push` hook runs the **same checks as CI** — but in concurrent **lanes**
(`scripts/pre-push.ts`, [#1030](https://github.com/erwins-enkel/shepherd/issues/1030))
rather than the old fully-sequential body that blew past the 120s agent command timeout
and failed pushes. Independent work runs in parallel (bounded by your core count), each
lane teeing to its own `.test-logs/` file, with a per-lane wall-clock **timeout backstop**
so a hung child can never wedge the push. The checks (per lane) are:

- **gates:** branch-hygiene · feature-catalog · generated-docs · glossary
- **prettier:** `prettier --check` over the push **delta** (see note)
- **eslint:** root + extension eslint over the push **delta** (see note)
- **tsc:** `bun run typecheck` (root `tsc --noEmit`)
- **root-tests:** `bun test ./test`
- **ui:** `bun run check` → `check:i18n` → `playwright install chromium` → `bun run test` → `scripts/check-ui-build.sh` (the ui build, plus a fail on Rollup's `INEFFECTIVE_DYNAMIC_IMPORT`; CI's **Build (ui)** step runs the same script)
- **ext:** `bun run check` → `check:i18n` → `bun run test` → `bun run build`
- then **`bunx fallow@2.100.0 audit --base origin/main --fail-on-issues`** (delta
  dead-code/complexity audit; version pinned — see note below)

> **CI remains the exhaustive whole-repo gate.** Two deliberate local-only differences from
> `.github/workflows/ci.yml` keep pushes fast without losing coverage:
>
> - **Delta-scoped lint.** prettier/eslint run only over files changed vs the `origin/main`
>   merge-base (near-instant vs ~30s whole-repo). CI keeps `prettier --check .` + full
>   `eslint`, so tree-wide drift is still caught before merge. (No `origin/main`, e.g.
>   offline? The hook falls back to whole-repo lint and skips fallow.)
> - **Same checks, different scoping.** Because the hook no longer shares `ci.yml`'s shell
>   body, the two gate definitions can drift — when you change a CI step, mirror it in
>   `scripts/pre-push.ts` (there's a sync banner in both files). Keep the `fallow@2.100.0`
>   pin in sync across the hook, `ci.yml`, and this file.
>
> **Concurrency is core-aware.** Lane fan-out and per-tool worker counts are bounded so
> `laneCap × workers ≤ cores` — no oversubscription on a modest box. Override the lane cap
> with `SHEPHERD_PREPUSH_LANES=<n>` (e.g. `=2` to simulate a small machine) and the per-lane
> timeout with `SHEPHERD_PREPUSH_LANE_TIMEOUT_MS=<ms>`.
>
> **Cold first-push caveat.** "Well under a minute" is a **warm** number. A fresh worktree's
> first push still pays one-time costs the hook can't parallelize away — the chromium
> download (~30–90s) and cold `.svelte-kit`/vite cache rebuilds inside the serial `ui`
> lane — and may still exceed the 120s timeout. Warm the caches once before your first push:
> `cd ui && bun install && bunx playwright install chromium && bun run build` (and raise the
> command timeout for that first push if needed).

> Lint and typecheck are separate gates: eslint catches lint rules, `tsc` catches
> type errors. Bun runs `.ts` by stripping types, so it never type-checks — only
> `tsc` does.

> **fallow is pinned to `2.100.0`** (not `@latest`) so analyzer changes are adopted
> deliberately, not on a random run. The synthetic Svelte `<template>` complexity metric
> (fallow 2.98+) is adopted via `health.thresholdOverrides` in `.fallowrc.jsonc`
> ([#851](https://github.com/erwins-enkel/shepherd/issues/851)) — a Tier-1 global bar
> (40 cyclomatic / 60 cognitive) plus per-file grandfathers for the known-large
> components. The bar exists because a template aggregates many conditional regions, so
> the library-default 20/15 fires on essentially every non-trivial Svelte component (a
> fresh ~25-conditional component trips at 20/15, passes at 40/60).
>
> **On [#756](https://github.com/erwins-enkel/shepherd/issues/756):** the line-shift
> mis-attribution that forced the old 2.97 pin (an inherited `<template>` finding scored
> as _introduced_ after lines moved) was re-tested against 2.100 and **does not
> reproduce** — fallow attributes inherited template findings correctly across line
> shifts and complexity changes; the audit's new-only gate fires only when a template is
> a finding in HEAD that was not one in the base. A genuinely new oversized template will
> still trip as _introduced_ (the gate working) — fix or grandfather it. Keep the version
> in sync with `.github/workflows/ci.yml` and `.husky/pre-push`.

Run any of these manually at any time:

```bash
bun run lint                 # eslint (root, covers ui/src too)
bun run typecheck            # root tsc --noEmit (src + test)
bun run format               # prettier --write across the repo
bun test ./test              # core test suite
cd ui && bun run check       # svelte-check (ui types)
cd ui && bun run check:i18n  # locale-catalog parity (en ↔ de)
cd ui && bun run test        # ui test suite (vitest)
cd ui && bun run build       # ui production build
bunx fallow@2.100.0 audit --base origin/main --fail-on-issues  # delta dead-code/complexity audit (version pinned)
```

## Tests

- **Core** tests live in `test/` and run under `bun test`.
- **UI** tests live in `ui/test/` and beside source as `*.test.ts`, run under `vitest`.

Add or update tests for any behavior you change. `test/server.test.ts` builds a
throwaway git repo under `SHEPHERD_REPO_ROOT`; the pre-push hook and CI point this
at a temp dir so your real working tree is never touched.

## Pull requests

- Branch off `main`; open a PR back into `main`. Don't commit to `main` directly.
- Keep PRs focused — one logical change.
- **The PR _title_ must itself be a [Conventional Commit](https://www.conventionalcommits.org/)** — `<type>(<scope>): <subject>`, same grammar as commit messages above. PRs land via **squash-merge**, so the PR title (not the branch's commits) becomes the single commit subject on `main`, and release-please builds the changelog by parsing it. A non-conventional title (e.g. `Pin repo filter chips` instead of `feat(ui): pin repo filter chips`) still parses as a commit but release-please **silently drops it from the release notes** — so a shipped feature vanishes from the changelog even though its commits were conventional. The `commit-msg` hook only gates commit _messages_; the PR title is gated separately by the **PR title** CI check (`.github/workflows/pr-title.yml`), which runs the _same_ `commitlint.config.js` against the title, so a non-conventional title fails the PR. If one still needs fixing at merge time, pass `gh pr merge --squash --subject "feat(scope): …"`.
- Ensure the pre-push suite passes locally (CI runs the identical gate on every PR).
- Update docs (`README.md`, `PRD.md`, this file) when you change public behavior,
  config, CLI flags, or the contribution flow.

## Reporting bugs & proposing features

Open a GitHub issue. For features, state how the behavior is achievable purely by
_typing into a real interactive terminal_ — that's the bar every feature must clear.

## License

Shepherd is licensed under the [Business Source License 1.1](./LICENSE). By
submitting a contribution you agree it is licensed under the same terms.
