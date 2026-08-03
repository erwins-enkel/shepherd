---
paths:
  - "ui/src/**/*.svelte"
  - "ui/src/**/*.css"
  - "ui/src/**/*.ts"
---

# Design system (REQUIRED for any UI work)

The UI has a **semantic token layer** (`ui/src/app.css` — `--color-*` surfaces/text/accents, the `--fs-*` type scale, `--status-*`/`--wash-*`) and a live reference page that documents it plus the canonical component recipes: **`/design-system`** (`ui/src/routes/design-system/+page.svelte`). It exists to stop **design drift** — every session re-inventing buttons, spacing and colors.

**No automated gate flags off-token colors.** This rule and review are the only enforcement.

1. **Consult `/design-system` first.** It renders the live tokens (swatches read straight off `app.css`, so they can't drift) plus the button / form-field / badge / panel / scrim recipes, each with a when-to-use note and copy-paste markup.
2. **Use the tokens, never literals.** Every color is `var(--color-*)`; every font size is `var(--fs-*)`. **Never** introduce a raw hex, `rgba()`, or ad-hoc `px` font size — if you reach for one, the token you need already exists (or belongs in `app.css`).
3. **Reuse a recipe before authoring a new component.** Match the existing `.gbtn` / field / `.badge` / `.panel` conventions; don't grow a per-element Tailwind utility stack for headings or buttons.
4. Accent hues are **semantic, not decorative** — pick by meaning. `--color-green` is reserved for genuinely actionable-complete (READY); a finished-but-parked session is slate (`--status-done`), never green.
5. **Every _blocking_ (modal) dialog/drawer dims _and_ blurs what's behind it** — when a surface seizes interaction and app content stays visible behind it, that surface must read as the focus (desktop and mobile alike). Use the canonical backdrop from `app.css`: the global `.scrim` class (full primitive) for a new backdrop, or `class="overlay"` for modal overlays (which inherit the same blur). Never ship such a surface with a fully-lit background or a hand-rolled backdrop without the blur. See the **Modal & scrim** recipe on `/design-system`. Two scope notes so the rule isn't over-applied:
   - _Exempt — opaque full-cover view-swaps:_ an `aria-modal` surface that fully covers its area (e.g. BacklogView's mobile master→detail `.mobile-detail-overlay`, a solid `--color-inset` panel that replaces the list in-place) — there is nothing visible behind it to dim, and a translucent scrim would only let the covered view bleed through. The rule is about visible-background floating surfaces, not full-bleed navigation.
   - _Exempt — small anchored, non-blocking popovers:_ a `role="dialog"` that is **not** `aria-modal` and floats anchored to a trigger (e.g. AutomationPanel's `.auto-pop`, EmojiPicker's `.ep`) does not seize the app or warrant a full-screen backdrop — no scrim, dismiss on outside-click/Esc instead.

The `/design-system` page is a developer/agent-facing internal reference (unlinked from the app), so it is **exempt from i18n** and the feature catalog.
