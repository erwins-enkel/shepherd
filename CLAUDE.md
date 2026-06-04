# Shepherd

Two packages, each with own deps: root (herdr/server, `bun`) + `ui/` (SvelteKit).

## Running checks in a fresh worktree

Shepherd worktrees start without `node_modules`. Install per package before linting/checking/testing:

| Package | Install                | Lint/check      | Test       |
| ------- | ---------------------- | --------------- | ---------- |
| Root    | `bun install`          | `bun run lint`  | `bun test` |
| UI      | `cd ui && bun install` | `bun run check` | `bun test` |

Run both halves when a change spans server + UI.

## Branch hygiene (one feature, linear off main)

Every PR branch must be cut from the **latest `main`** and kept **linear**:

- Branch from `origin/main` — never from another feature branch or a shared "dev-integration" branch.
- **Rebase** onto main to update; never `git merge main` into your branch (no merge commits).
- One feature per branch — only this change's commits.

A branch that merges other branches drags their commits + a bloated diff into the PR. The gate `scripts/check-branch-hygiene.sh` fails any branch with merge commits relative to main; it runs in the **PR hygiene** CI workflow and the pre-push hook. To fix a polluted branch, re-create it off main with just your change (`git checkout -b <branch> origin/main` then cherry-pick / `rebase --onto origin/main`).

## Internationalization (REQUIRED for any UI work)

The UI is fully internationalized with Paraglide JS (EN + DE). **Never hardcode user-facing text.** Every display string — labels, buttons, placeholders, `title`/`aria-label`, empty/error/loading states, toast text, and **server-side notification payloads** — must route through a message:

1. Add the key to **both** `ui/messages/en.json` and `ui/messages/de.json`. Keys are snake_case and component-prefixed (`viewport_diff_tab`, `broadcast_failed`, `prbadge_open`); use `{param}` for interpolation.
2. Import and call it: `import { m } from "$lib/paraglide/messages"` → `m.my_key()` / `m.my_key({ count })`.
3. Reuse existing keys where one fits (e.g. `common_close`, `common_loading`).

Data passed through verbatim (tool-use summaries, PR titles, designations like `TASK-07`) is **not** translated — only chrome the app itself authors.

**Gate:** `cd ui && bun run check:i18n` enforces that all locale catalogs share an identical, non-empty key set (Paraglide silently falls back to EN for a missing key, so an incomplete `de.json` would otherwise ship looking fine). It runs in CI `verify` and the pre-push hook — a PR that adds an EN key without its DE counterpart fails. It does not detect hardcoded strings that skip the catalog entirely; that's on you and review.

## Feature discovery (REQUIRED for user-facing features)

New user-facing capabilities surface to users through the What's-New drawer + first-view coachmarks, both driven by the catalog `ui/src/lib/feature-announcements.ts`. **A `feat` that ships UX but skips the catalog rots it silently** — it builds, passes CI, and deploys while the discovery system stops reflecting reality. So every shipped user-facing feature adds **one** catalog entry **in the same PR as the feature**:

1. Append a `FeatureAnnouncement` to `featureAnnouncements` in `ui/src/lib/feature-announcements.ts` with: `id` (stable kebab slug), `sinceVersion` (the release it ships in), `titleKey` + `bodyKey`.
2. Add `titleKey`/`bodyKey` to **both** `ui/messages/en.json` and `de.json` (see Internationalization above — `check:i18n` enforces parity).
3. Optionally set `targetId` and put `use:coachTarget={"<id>"}` on the anchor element so the coachmark can point at it.

Server-only, internal-plumbing, or mislabeled-`feat` changes that ship **no** user-facing UX are exempt — opt out by putting `[no-feature-entry]` in a commit subject or the PR body.

**Gate:** `scripts/check-feature-catalog.sh` is a pragmatic heuristic — if a `feat(...)` commit in the branch's range touches user-facing UI (`ui/src/lib/components/**`, `ui/src/routes/**`) it asserts that `feature-announcements.ts` was modified in the same range, else fails with a fix hint. The `[no-feature-entry]` opt-out skips the check **loudly** (it echoes what it skipped). It runs in the **PR hygiene** CI workflow and the pre-push hook, alongside branch-hygiene + `check:i18n`. Like those, it asserts presence, not content quality — an accurate, well-written entry is on you and review.
