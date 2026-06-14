# Shepherd

Two packages, each with own deps: root (herdr/server, `bun`) + `ui/` (SvelteKit).

## Running checks in a fresh worktree

Shepherd worktrees start without `node_modules`. Install per package before linting/checking/testing:

| Package   | Install                       | Lint/check      | Test       |
| --------- | ----------------------------- | --------------- | ---------- |
| Root      | `bun install`                 | `bun run lint`  | `bun test` |
| UI        | `cd ui && bun install`        | `bun run check` | `bun test` |
| Extension | `cd extension && bun install` | `bun run check` | `bun test` |

Run both halves when a change spans server + UI.

## Branch hygiene (one feature, linear off main)

Every PR branch must be cut from the **latest `main`** and kept **linear**:

- Branch from `origin/main` — never from another feature branch or a shared "dev-integration" branch.
- **Rebase** onto main to update; never `git merge main` into your branch (no merge commits).
- One feature per branch — only this change's commits.

A branch that merges other branches drags their commits + a bloated diff into the PR. The gate `scripts/check-branch-hygiene.sh` fails any branch with merge commits relative to main; it runs in the **PR hygiene** CI workflow and the pre-push hook. To fix a polluted branch, re-create it off main with just your change (`git checkout -b <branch> origin/main` then cherry-pick / `rebase --onto origin/main`).

## Design system (REQUIRED for any UI work)

The UI has a **semantic token layer** (`ui/src/app.css` — `--color-*` surfaces/text/accents, the `--fs-*` type scale, `--status-*`/`--wash-*`) and a live reference page that documents it plus the canonical component recipes: **`/design-system`** (`ui/src/routes/design-system/+page.svelte`). It exists to stop **design drift** — every session re-inventing buttons, spacing and colors. Before authoring any UI:

1. **Consult `/design-system` first.** It renders the live tokens (swatches read straight off `app.css`, so they can't drift) plus the button / form-field / badge / panel / scrim recipes, each with a when-to-use note and copy-paste markup.
2. **Use the tokens, never literals.** Every color is `var(--color-*)`; every font size is `var(--fs-*)`. **Never** introduce a raw hex, `rgba()`, or ad-hoc `px` font size — if you reach for one, the token you need already exists (or belongs in `app.css`).
3. **Reuse a recipe before authoring a new component.** Match the existing `.gbtn` / field / `.badge` / `.panel` conventions; don't grow a per-element Tailwind utility stack for headings or buttons.
4. Accent hues are **semantic, not decorative** — pick by meaning. `--color-green` is reserved for genuinely actionable-complete (READY); a finished-but-parked session is slate (`--status-done`), never green.
5. **Every _blocking_ (modal) dialog/drawer dims _and_ blurs what's behind it** — when a surface seizes interaction and app content stays visible behind it, that surface must read as the focus (desktop and mobile alike). Use the canonical backdrop from `app.css`: the global `.scrim` class (full primitive) for a new backdrop, or `class="overlay"` for modal overlays (which inherit the same blur). Never ship such a surface with a fully-lit background or a hand-rolled backdrop without the blur. See the **Modal & scrim** recipe on `/design-system`. Two scope notes so the rule isn't over-applied:
   - _Exempt — opaque full-cover view-swaps:_ an `aria-modal` surface that fully covers its area (e.g. BacklogView's mobile master→detail `.mobile-detail-overlay`, a solid `--color-inset` panel that replaces the list in-place) — there is nothing visible behind it to dim, and a translucent scrim would only let the covered view bleed through. The rule is about visible-background floating surfaces, not full-bleed navigation.
   - _Exempt — small anchored, non-blocking popovers:_ a `role="dialog"` that is **not** `aria-modal` and floats anchored to a trigger (e.g. AutomationPanel's `.auto-pop`, EmojiPicker's `.ep`) does not seize the app or warrant a full-screen backdrop — no scrim, dismiss on outside-click/Esc instead.

The `/design-system` page is a developer/agent-facing internal reference (unlinked from the app), so it is **exempt from i18n** and the feature catalog. No automated gate flags off-token colors yet — this directive + review are the enforcement.

## Internationalization (REQUIRED for any UI work)

The UI is fully internationalized with Paraglide JS (EN + DE). **Never hardcode user-facing text.** Every display string — labels, buttons, placeholders, `title`/`aria-label`, empty/error/loading states, toast text, and **server-side notification payloads** — must route through a message:

1. Add the key to **both** `ui/messages/en.json` and `ui/messages/de.json`. Keys are snake_case and component-prefixed (`viewport_diff_tab`, `broadcast_failed`, `prbadge_open`); use `{param}` for interpolation.
2. Import and call it: `import { m } from "$lib/paraglide/messages"` → `m.my_key()` / `m.my_key({ count })`.
3. Reuse existing keys where one fits (e.g. `common_close`, `common_loading`).

Data passed through verbatim (tool-use summaries, PR titles, designations like `TASK-07`) is **not** translated — only chrome the app itself authors.

**Gate:** `cd ui && bun run check:i18n` enforces that all locale catalogs share an identical, non-empty key set (Paraglide silently falls back to EN for a missing key, so an incomplete `de.json` would otherwise ship looking fine). It runs in CI `verify` and the pre-push hook — a PR that adds an EN key without its DE counterpart fails. It does not detect hardcoded strings that skip the catalog entirely; that's on you and review.

**Merge conflicts auto-resolve.** Because every PR appends keys to the same `ui/messages/*.json` + `extension/messages/*.json`, concurrent branches used to collide on the tail hunk on every rebase. A custom **union merge driver** (`scripts/json-union-merge.mjs`, bound in `.gitattributes`, registered per-clone by `scripts/register-merge-driver.mjs` from the root `prepare` script) now merges these catalogs **by key**: additive and one-sided edits resolve silently; only a genuine same-key-different-value clash falls through as a normal conflict. It activates on the next `bun install`; no action needed when rebasing. If you ever do see a catalog conflict, it's a real one — two branches gave the **same** key different values.

## Feature discovery (REQUIRED for user-facing features)

New user-facing capabilities surface to users through the What's-New drawer + first-view coachmarks, both driven by the catalog `ui/src/lib/feature-announcements.ts`. **A `feat` that ships UX but skips the catalog rots it silently** — it builds, passes CI, and deploys while the discovery system stops reflecting reality. So every shipped user-facing feature adds **one** catalog entry **in the same PR as the feature**:

1. Append a `FeatureAnnouncement` to `featureAnnouncements` in `ui/src/lib/feature-announcements.ts` with: `id` (stable kebab slug), `sinceVersion` (the release it ships in), `titleKey` + `bodyKey`.
2. Add `titleKey`/`bodyKey` to **both** `ui/messages/en.json` and `de.json` (see Internationalization above — `check:i18n` enforces parity).
3. Optionally set `targetId` and put `use:coachTarget={"<id>"}` on the anchor element so the coachmark can point at it.

Server-only, internal-plumbing, or mislabeled-`feat` changes that ship **no** user-facing UX are exempt — opt out by putting `[no-feature-entry]` in a commit subject or the PR body.

**Gate:** `scripts/check-feature-catalog.sh` is a pragmatic heuristic — if a `feat(...)` commit in the branch's range touches user-facing UI (`ui/src/lib/components/**`, `ui/src/routes/**`) it asserts that `feature-announcements.ts` was modified in the same range, else fails with a fix hint. The `[no-feature-entry]` opt-out skips the check **loudly** (it echoes what it skipped). It runs in the **PR hygiene** CI workflow and the pre-push hook, alongside branch-hygiene + `check:i18n`. Like those, it asserts presence, not content quality — an accurate, well-written entry is on you and review.

It's a heuristic with deliberate holes — review still has to catch what it can't:

- **Conventional-commit dependency.** Only `feat(...)` (incl. `feat!:`) subjects arm the gate. A user-facing feature mislabeled `fix:`/`chore:` slips by entirely. Label features correctly.
- **UI-glob scope.** Only `ui/src/lib/components/**` + `ui/src/routes/**` count as user-facing. A feature surfacing UX purely through other `ui/src/lib/` code (`api.ts`, stores, actions) without touching those paths is **not** detected.
- **Opt-out is branch-global.** A single `[no-feature-entry]` anywhere in the range (any commit subject or body) disables the gate for the **whole PR range**, not just the commit carrying it — so don't use it on a branch that also ships a real surfacing feature.
- **Range-level, so it can over-fire.** The check doesn't bind the UI diff to the specific `feat` commit. A branch mixing a server-only `feat:` with an unrelated UI-touching `fix:` trips the gate even though the feature ships no UX. This is fail-safe (it errs toward demanding an entry) and recoverable — add the entry, or use `[no-feature-entry]` if neither change truly surfaces UX.

## Glossary (REQUIRED when marking UI terms)

Shepherd UI text can mark defined terms with a dashed underline; hovering or tapping opens a tooltip. The glossary registry (`ui/src/lib/glossary.ts`) is the single source of truth. **Any new Shepherd-specific or non-obvious term introduced in UI text must have a registry entry and EN+DE message keys in the same PR as the first marker.**

1. **Add a registry entry** in `ui/src/lib/glossary.ts`: `{ id, kind: "internal" | "external", termKey: "gloss_<id>_term", bodyKey: "gloss_<id>_def", wikipedia?: { en, de } }`. Internal terms (Shepherd concepts) carry an in-app definition only. External (industry-standard) terms additionally require a per-locale Wikipedia article slug (`wikipedia.en` + `wikipedia.de`).
2. **Add `gloss_<id>_term` and `gloss_<id>_def`** to **both** `ui/messages/en.json` and `de.json` (the same parity rule as Internationalization above — `check:i18n` enforces it).
3. **Mark terms in plain-text message values** using `[[id|Label]]` — e.g. `"...your [[epic|epic]] is now..."`. No HTML, no `{@html}`; `<GlossaryText>` parses the markers at render time and emits `<GlossaryTerm>` components.
4. **Confirm the definition before it ships.** The author proposes the EN and DE definition text; the reviewer (or the Critic agent) explicitly confirms it is accurate and well-phrased before the PR merges. Good UX depends on getting the explanation right — automated gates cannot catch misleading definitions.

**Gate:** `scripts/check-glossary.mjs` enforces referential integrity: every `[[id|…]]` marker must resolve to a registry entry, every `termKey`/`bodyKey` referenced in the registry must exist in both locale catalogs, and every `external` term must have both `wikipedia.en` and `wikipedia.de` slugs. It runs in the **PR hygiene** CI workflow and the pre-push hook. It asserts presence and structure, not prose quality — that's on author + review.
