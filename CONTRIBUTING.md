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

1. `prettier --check .`
2. `bun run lint` (eslint)
3. `bun run typecheck` (root `tsc --noEmit`)
4. `cd ui && bun run check` (svelte-check typecheck)
5. `bun test ./test` (core tests)
6. `cd ui && bun run test` (ui tests)
7. `cd ui && bun run build` (ui build)

> Lint and typecheck are separate gates: eslint catches lint rules, `tsc` catches
> type errors. Bun runs `.ts` by stripping types, so it never type-checks — only
> `tsc` does.

Run any of these manually at any time:

```bash
bun run lint                 # eslint (root, covers ui/src too)
bun run typecheck            # root tsc --noEmit (src + test)
bun run format               # prettier --write across the repo
bun test ./test              # core test suite
cd ui && bun run check       # svelte-check (ui types)
cd ui && bun run test        # ui test suite (vitest)
cd ui && bun run build       # ui production build
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
