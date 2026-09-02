---
paths:
  - "ui/src/lib/components/**/*"
  - "ui/src/routes/**/*"
  - "ui/src/lib/feature-announcements/**/*"
---

# Feature discovery (REQUIRED for user-facing features)

New user-facing capabilities surface through the What's-New drawer + first-view coachmarks, driven by the catalog exported from `ui/src/lib/feature-announcements.ts`. Entries live as one-file fragments under `ui/src/lib/feature-announcements/entries/` so feature PRs don't all edit the same array tail.

**A `feat` that ships UX but skips the catalog rots it silently** — it builds, passes CI, and deploys while the discovery system stops reflecting reality. Every shipped user-facing feature adds **one** catalog entry **in the same PR as the feature**:

1. Add one fragment file in `ui/src/lib/feature-announcements/entries/` named `v<version>-<id>.ts` (for example `v1.41.0-quick-filter.ts`) with a default export satisfying `FeatureAnnouncement`: `id` (stable kebab slug), `sinceVersion`, `titleKey` + `bodyKey`. Use the same version string for both the filename and the `sinceVersion` field.
2. Add `titleKey`/`bodyKey` to **both** `ui/messages/en.json` and `de.json`.
3. Optionally set `targetId` and put `use:coachTarget={"<id>"}` on the anchor element so the coachmark can point at it.

**`<version>` is the NEXT (unreleased) version — run `bun run next-version`; NEVER read `package.json`.** Between releases `package.json` holds the _last released_ version (release-please only bumps it when its release PR merges), so stamping that makes the entry invisible forever: `feature-gate.ts` only surfaces `sinceVersion > the user's lastSeen`, and an upgraded user already saw the last release.

**No sequence-number prefix** — the filename is just `v<version>-<id>.ts`. The `id` is globally unique (enforced by the dup-id guard), so two concurrent PRs never collide on a filename; a shared `NNNN-` counter would reintroduce the merge-conflict hotspot this split removed. Entries sort by `sinceVersion` then filename, so a curated cross-file order is neither needed nor available.

Server-only, internal-plumbing, or mislabeled-`feat` changes that ship **no** user-facing UX are exempt — opt out with `[no-feature-entry]` in a commit subject or the PR body. The opt-out is **branch-global**: one occurrence anywhere in the range disables the check for the whole PR, so don't use it on a branch that also ships a real surfacing feature.

## Gates

- `scripts/check-feature-catalog.sh` — asserts a `feat(...)` commit touching user-facing UI also modified an entry fragment. Only `feat(...)` subjects arm it, so **label features correctly**; a user-facing feature mislabeled `fix:`/`chore:` slips by entirely.
- `scripts/check-announcement-versions.mjs` — fails an added fragment whose `sinceVersion` is `<=` the last released version, or whose filename prefix disagrees with the field. Fix by running `bun run next-version` and using that value for both.

Both assert presence, not content quality — an accurate, well-written entry is on you and review.

Unrelated to this catalog but easy to trip over from the same PRs: **editing a committed docs page can make a generated file stale.** `ui/scripts/gen-docs-manifest.ts` derives the command bar's Docs-group keywords from each page's frontmatter `description` + its H2/H3 headings into the committed `ui/src/lib/docs-manifest.ts`, and `docs-site/scripts/sync-docs.mjs` publishes `CLAUDE.md` and every `.claude/rules/*.md` as such a page alongside the docs-site content. Add or rename a heading (or change a `description`) in any of them and `check:docs-manifest` fails in `verify` until someone runs `bun run gen:docs` from `ui/` and commits the result — so commit it together with the page edit.
