---
paths:
  - "ui/src/lib/glossary.ts"
  - "ui/src/lib/components/**/*"
  - "ui/messages/*.json"
---

# Glossary (REQUIRED when marking UI terms)

Shepherd UI text can mark defined terms with a dashed underline; hovering or tapping opens a tooltip. The registry (`ui/src/lib/glossary.ts`) is the single source of truth. **Any new Shepherd-specific or non-obvious term introduced in UI text must have a registry entry and EN+DE message keys in the same PR as the first marker.**

1. **Add a registry entry** in `ui/src/lib/glossary.ts`: `{ id, kind: "internal" | "external", termKey: "gloss_<id>_term", bodyKey: "gloss_<id>_def", wikipedia?: { en, de } }`. Internal terms (Shepherd concepts) carry an in-app definition only. External (industry-standard) terms additionally require a per-locale Wikipedia article slug (`wikipedia.en` + `wikipedia.de`).
2. **Add `gloss_<id>_term` and `gloss_<id>_def`** to **both** `ui/messages/en.json` and `de.json`.
3. **Mark terms in plain-text message values** using `[[id|Label]]` — e.g. `"...your [[epic|epic]] is now..."`. No HTML, no `{@html}`; `<GlossaryText>` parses the markers at render time and emits `<GlossaryTerm>` components.
4. **Confirm the definition before it ships.** The author proposes the EN and DE definition text; the reviewer (or the Critic agent) explicitly confirms it is accurate and well-phrased before the PR merges. Good UX depends on getting the explanation right — **no gate can catch a misleading definition.**

## Gate

`scripts/check-glossary.mjs` enforces referential integrity: every `[[id|…]]` marker resolves to a registry entry, every `termKey`/`bodyKey` exists in both locale catalogs, and every `external` term has both Wikipedia slugs. Structure only — prose quality is on author + review.
