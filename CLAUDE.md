# Shepherd

Five Bun/Node packages, each with its own deps and lockfile: root (herdr/server, `bun`), `ui/`
(SvelteKit), `extension/`, `docs-site/` (Astro Starlight, docs.shepherd.run) and `site/` (Astro,
the marketing site). Plus `native/`, a Swift package (`ShepherdKit`) generated from
`contracts/openapi.swift.yaml` (derived from `contracts/openapi.yaml` by
`bun run gen:contract-swift`) — build and test it with `swift build --package-path native` and
targeted `swift test --package-path native --filter <test>`, never with `bun`. See `native/README.md`. And `cli/`, the Rust
`shepherd` CLI (Cargo crate), whose client is generated at build time from
`contracts/openapi.rust.yaml` — see `docs/cli.md`.

> Conventions for UI, i18n, feature announcements and the glossary live in `.claude/rules/` and
> load automatically when you touch the files they govern. They are published under
> **Reference** on the docs site.

Explanatory hover text must be scannable: **a descriptive title, a short summary,
and labelled sections with one idea each**. Use lists for genuinely parallel choices
and emphasize costs, consequences and next steps. Plain strings are for short action
or status labels, not multi-sentence explanations. Reuse `ui/src/lib/tooltips/`
(`TooltipExplanation`, `TooltipBody`, `statusTip`) instead of adding local markup,
HTML/Markdown strings or native `title` essays. Keep all copy in EN + DE catalogs.
The module's typed interface documents this rule at the call site; live examples
and copy-paste usage live at `/design-system`. Preserve hover-to-panel reading,
Escape dismissal, keyboard/touch access and viewport-safe wrapping when changing
an explanation surface. Longer instructions belong in a disclosure or docs.

**Every iOS build distributed through TestFlight must include build-specific release notes in
App Store Connect's `What to Test` field**, readable in the TestFlight app. This applies to
nightly, after-merge, manual and preview uploads. Summarize changes since the previous
distributed build, fixes and relevant testing instructions; a GitHub changelog or CI artifact
alone does not satisfy this requirement. Verify the notes on the matching version/build before
considering the release complete. See [the TestFlight release checklist](native/docs/testflight-ios.md#release-notes-required-for-every-build).

## Verify

**Locally, run only affected tests with explicit file paths or test filters.** Select tests
for the changed behavior, its callers and regressions; when server + UI are affected, select
tests in both packages. Leave full suites (including browser suites) and `clippy --all-targets`
to GitHub CI unless the user explicitly requests a full local run. For documentation-only
changes, relevant static checks suffice. Report which tests ran and which checks remain in CI.

| Package      | Targeted local test command (replace placeholders)                         |
| ------------ | -------------------------------------------------------------------------- |
| Root         | `bun test ./test/<file>.test.ts` (multiple explicit files allowed)         |
| `ui/`        | `bun run test <path>` from `ui/`; optionally `--project node` or `browser` |
| `extension/` | `bun run test <path>` from `extension/`                                    |
| `native/`    | `swift test --package-path native --filter <TestClass/testMethod>`         |
| `cli/`       | `cargo test --locked --manifest-path cli/Cargo.toml <testfilter>`          |

Never run unqualified `bun test`: it discovers the wrong file set, and UI/extension tests
require Vitest. Do not use root `bun run test <file>` to narrow a run: that script already
includes all of `./test`. In UI/extension, `bun run test <path>` forwards the selection to
`vitest run`. Check the runner output to confirm the intended tests actually ran.

Run relevant lint/check commands for changed code: scope ESLint and Prettier to changed files;
use `bun run typecheck` at root or `bun run check` in UI/extension when type checks are needed.
`native/` is Swift: use `swift build --package-path native` and filtered Swift tests, never Bun.
`cli/` is Rust: use Cargo, never Bun; Rust contract changes need relevant CLI checks too.
`bash scripts/check-cli.sh` is the full CI gate (fmt, all-target clippy, full tests), not the
local default. The `Shepherd.app` shell has its own scripts under `native/scripts/`; see
`native/README.md`.

The pre-push hook runs lint, type/build and consistency checks, but no test suites or full
CLI gate. Run affected tests explicitly before pushing; CI supplies full coverage. Keep the
hook enabled and do not treat a successful push as proof that the CI suite passed.

Deps for those three install themselves — the `ensure-deps.sh` SessionStart hook runs
`bun install` in root, `ui/` and `extension/` when `node_modules` is absent. It does **not**
cover `docs-site/` or `site/`: run `bun install` there by hand before building or checking
either.

## Always work in a worktree

The main checkout stays on a clean `main`: never edit, commit, build or test there. Every task
gets its own git worktree on its own branch — create one under `.claude/worktrees/<name>`
(gitignored) with `git worktree add -b <branch> .claude/worktrees/<name> origin/main`. A session
that already starts inside a worktree (Shepherd-spawned, `claude --worktree`, Codex) stays in it.
Parallel agents never share a worktree. Remove it (`git worktree remove`) once its PR is merged.

## Branch hygiene

Cut every branch from **`origin/main`** — never from another feature branch or a shared
"dev-integration" branch. **Rebase** to update; never `git merge main` into your branch. One
feature per branch. A branch that merges other branches drags their commits and a bloated diff
into the PR.

## Locale-catalog merge conflicts are real

`ui/messages/*.json` and `extension/messages/*.json` go through a union merge driver
(`scripts/json-union-merge.mjs`) that merges them **by key**, so the usual additive tail
collisions resolve silently during rebase. If you _do_ see a conflict in one of these files, it
is a genuine one — two branches gave the **same** key different values. Resolve it on the merits;
don't just take one side.
