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

### Pre-push (full suite)

The `pre-push` hook runs the **same checks as CI** so failures surface before a PR:

1. `bash scripts/check-branch-hygiene.sh` (branch hygiene — linear off `main`, no merge commits)
2. `bash scripts/check-feature-catalog.sh` (feature-catalog completeness — a `feat` touching UI
   ships its announcement entry)
3. `prettier --check .`
4. `bun run lint` (eslint)
5. `bun run typecheck` (root `tsc --noEmit`)
6. `cd ui && bun run check` (svelte-check typecheck)
7. `cd ui && bun run check:i18n` (i18n catalog parity, en ↔ de)
8. `bun test ./test` (core tests)
9. `cd ui && bun run test` (ui tests)
10. `cd ui && bun run build` (ui build)
11. `bunx fallow@2.100.0 audit --base origin/main --fail-on-issues` (delta dead-code/complexity
    audit vs `origin/main`; version pinned — see note below)

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
- Ensure the pre-push suite passes locally (CI runs the identical gate on every PR).
- Update docs (`README.md`, `PRD.md`, this file) when you change public behavior,
  config, CLI flags, or the contribution flow.

## Reporting bugs & proposing features

Open a GitHub issue. For features, state how the behavior is achievable purely by
_typing into a real interactive terminal_ — that's the bar every feature must clear.

## License

Shepherd is licensed under [Apache-2.0](./LICENSE). By submitting a contribution
you agree it is licensed under the same terms.
