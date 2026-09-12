# Shepherd

Five packages, each with its own deps and lockfile: root (herdr/server, `bun`), `ui/` (SvelteKit),
`extension/`, `docs-site/` (Astro Starlight, docs.shepherd.run) and `site/` (Astro, the marketing
site).

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

## Verify

**Always `bun run test`, never bare `bun test`.** Root's script scopes to `./test`; `ui/` and
`extension/` run `vitest`. Bare `bun test` invokes Bun's runner over the wrong file set and
"passes" without running the suite you meant.

| Package      | Lint/check      | Test           |
| ------------ | --------------- | -------------- |
| Root         | `bun run lint`  | `bun run test` |
| `ui/`        | `bun run check` | `bun run test` |
| `extension/` | `bun run check` | `bun run test` |

Run both halves when a change spans server + UI.

Deps for those three install themselves — the `ensure-deps.sh` SessionStart hook runs
`bun install` in root, `ui/` and `extension/` when `node_modules` is absent. It does **not**
cover `docs-site/` or `site/`: run `bun install` there by hand before building or checking
either.

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
