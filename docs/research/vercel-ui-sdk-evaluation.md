# Should Shepherd adopt Vercel's UI SDK (`vercel-labs/ui`)?

**Verdict: not now — in none of the three places. Watch it; re-evaluate at GA (or at the first
non-beta `0.x`).** It is the most interesting headless-behaviour library in the Svelte 5 space —
real runes/snippets, native Popover API + CSS anchor positioning, ~37 behaviours and ~70 unstyled
components, plus a WebMCP agent layer nobody else has. But it is **10 days old**, ships several
betas a day, is effectively **three humans**, has **~9k weekly Svelte downloads** (vs ~700k for
core/React), and two of its open issues land squarely on Shepherd's hot path. Migrating ~100
hand-rolled widgets onto that is the wrong trade today.

> Research snapshot, **2026-11-22**, against `@ui-sdk/core` / `@ui-sdk/svelte`
> **0.1.0-beta.13** (npm `latest`; beta.14 published 2026-11-21) and Shepherd at `204e31320`.
> Repo source was read, not built or run. A recommendation, not a committed plan; this document is
> the entire diff.

---

## 1. What it is

`vercel-labs/ui` ("UI SDK", <https://ui-sdk.dev>, Apache-2.0, repo created 2026-10-26, first npm
publish 2026-11-12) is a **headless behaviour library**: keyboard navigation, focus, selection,
dismissal, popups, drag-and-drop and their ARIA live in `@ui-sdk/core` (zero runtime deps), with
adapters for React, Vue, Svelte, Solid and Web Components.

| Aspect      | Finding                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Svelte      | **Svelte 5 only**: `$props`/`$bindable`/`Snippet` throughout `packages/svelte/src`; peer `svelte >=5.33`. No Svelte 4 syntax.                                                                                                                                                                                                                     |
| SvelteKit   | SSR supported, no provider/portal root needed; ids are patched on hydration; per-request state via context; an inline `<Preferences>` script that takes a CSP `nonce`.                                                                                                                                                                            |
| Tailwind 4  | Documented: `@layer ui-sdk;` before `@import "tailwindcss"`, optional `web.css` as `layer(components)`.                                                                                                                                                                                                                                           |
| Surface     | ~37 `create*` behaviours (popup, roving/grid focus, focus recovery, typeahead, selection/lasso, listbox, DnD incl. tree reorder, resize, swipe, virtualizer, undo stack, sticky-bottom). **Plus ~70 ready-made unstyled components** (combobox, menu, menubar, dialog, drawer, popover, tooltip, hover-card, tabs, select, command, toast, tree). |
| Positioning | Native Popover API (top layer) + CSS anchor positioning where supported, own JS fallback. **No floating-ui.**                                                                                                                                                                                                                                     |
| Size        | Repo size budgets (gzip assumed): svelte/popover ≈ 39.5 KB, tooltip ≈ 38 KB, menu ≈ 51.5 KB.                                                                                                                                                                                                                                                      |
| Agent skill | `packages/core/skills/ui-sdk/SKILL.md` — a coding guide, not a runtime. Points agents at bundled `llms.txt`; rule: "don't hand-roll what we ship" (a `div role="menu"` next to ui-sdk is a bug).                                                                                                                                                  |
| "MCP"       | **No MCP server.** It is **WebMCP**: `createAgent()` + `registerTools()` expose `snapshot`/`query`/`act` over the page's components via `document.modelContext`, with permission hooks and `data-agent-confirm`; a no-op where the browser lacks that API.                                                                                        |

### Maturity

- **Churn:** beta.1 → beta.14 in 10 days, often multiple per day; beta.11 is in the changelog but
  was never published. All entries are "Patch Changes", nothing labelled `breaking` — but it is
  pre-1.0 beta, so no stability promise. ~1,020 APIs tagged `@stable`, ~365 `@experimental`.
- **Bus factor:** 591 / 66 / 37 commits from three people (shadcn, benjamincanac, shuding); rest
  are bots.
- **Adoption:** 6.5k stars; weekly downloads core 696k, react 599k, **svelte 9.1k**. Svelte is a
  ~1% side-adapter.
- **Issues:** 98 open. No open Svelte-specific ones (several fixed, e.g. #690 pre-hydration typing
  erased). No GA date stated.
- **Beta terms:** the README puts it under Vercel's public beta agreement, whose literal text
  (internal use only, no derivatives, no published benchmarks, terminate at will) fits proprietary
  products, not Apache-2.0 code; its §3 defers OSS components to their own licence. Practical
  reading: "no warranty, API churn". Not legal advice — the wording conflict is real.

## 2. Where Shepherd stands today

`ui/` is SvelteKit + Svelte 5 + Tailwind 4 with **528 `.svelte` files**, and every widget is
hand-rolled:

| Pattern                                       | Files |
| --------------------------------------------- | ----: |
| `role="dialog"` / `aria-modal`                |    75 |
| — of which use the shared `use:dialog` action |    55 |
| `role="menu" / "listbox" / "combobox"`        |    27 |
| `role="tablist"`                              |     5 |
| Arrow-key handling                            |    33 |
| Native `popover=` attribute                   |    19 |

Shared building blocks: `ui/src/lib/a11yDialog.ts` (focus trap, Escape, focus restore,
`openDialogs` count), `ui/src/lib/tooltips/` (`TooltipExplanation`/`TooltipBody`/`statusTip`, a
house rule in `CLAUDE.md`), `@floating-ui/dom`, `svelte-dnd-action`. `git log` shows **157
commits** mentioning a11y / focus trap / keyboard nav / roving / aria — the hand-rolling has a
real, ongoing cost. That is the honest case _for_ a headless library.

## 3. The three candidate placements

### a) In Shepherd's own UI — **no, not now**

1. **Hot-path risk.** Open issue **#543**: positioning wakes _every open popup on any DOM change in
   the document_. Shepherd's HUD is a single page with streaming xterm output, live session cards
   and WS-driven re-renders — constant DOM mutation. Open issue **#1001**: after hydration,
   idle-time `registerProperty` calls and injected stylesheets restyle/re-layout the whole page.
   Both are exactly the "UI freezes while typing" class of regression Shepherd has already paid for
   (single-loop work, PR #437).
2. **All-or-nothing by design.** The skill treats a hand-rolled `role="menu"` beside ui-sdk as a
   bug, so partial adoption puts agents in permanent conflict with the 27 existing menus/listboxes.
   A real adoption is a migration of ~100 components plus the tooltip house rule, the glossary
   popover (which already hit a native-popover `display` trap, PR #1006) and their browser tests.
3. **Churn × autonomy.** Shepherd agents drain issues unattended against pinned majors. A
   dependency shipping several betas a day with three maintainers and a 1%-share Svelte adapter
   will produce Dependabot noise and agent breakage faster than the a11y savings repay.
4. **Weight.** ~40–50 KB gz per popup-class entry versus today's small actions; the PWA/phone path
   cares.

If the a11y maintenance cost becomes the priority before ui-sdk matures, **bits-ui** (2.22.0, peer
`svelte ^5.33`, ~1.8M weekly downloads, shadcn-svelte's base) or **Ark UI / Zag** (`@ark-ui/svelte`
5.25.1, `@zag-js/svelte` 1.48.0) are the mature Svelte 5 options today. `melt` (next-gen melt-ui)
is pre-1.0 and stalled since 2026-01. That would be its own evaluation.

### b) Bootstrap (House Stack) — **no; and it would currently break bootstrap**

The House Stack (`src/house-stack.ts`) is the operator's standing package list, resolved to
current stable versions and written into new projects' `CLAUDE.md` as hard pins. Resolution is
**all-or-nothing** and requires a stable `x.y.z` (`STABLE_RE`, `stableOrThrow` at
`src/house-stack.ts:52,222`). `@ui-sdk/svelte`'s `latest` is `0.1.0-beta.13`, so adding it today
fails the **whole** pin run with "no stable version". It also shouldn't be a default: bootstrap
serves arbitrary greenfield projects, and a UI-behaviour library is a per-project choice, not a
baseline. Revisit once it publishes a stable version — then it's a one-line operator setting, no
code change.

### c) Readiness — **no, wrong category**

The Readiness analyzer (`src/readiness.ts`) scores **deterministic guardrails** (formatter,
linter, type checker, hooks, CI, tests, dead-code audit, …) — mechanical checks that coach agents
without a human. Which component library a repo uses isn't a guardrail. The adjacent "Framework
majors" drift check (`src/readiness-drift-core.ts`) only tracks House Stack packages, so (b)
gates it anyway.

## 4. What is worth watching

- **WebMCP agent layer.** `snapshot`/`query`/`act` over semantically known components is a
  cleaner surface than screenshot-driving for agents testing a UI (Shepherd's shared-browser /
  `agent-browser` flows). Only useful once `document.modelContext` ships in the browsers we drive.
- **The skill pattern** (bundled `llms.txt` + a "don't hand-roll" rule) is a good model for how
  Shepherd's own `ui/src/lib/tooltips/` rule is taught to agents.

## 5. Re-evaluation triggers

Re-open this when **any** of: ui-sdk reaches GA or a non-beta release; #543 and #1001 are closed;
`@ui-sdk/svelte` weekly downloads and contributor count grow materially; or the operator decides
to replace the hand-rolled widgets regardless (then compare ui-sdk against bits-ui / Ark head to
head, with a pilot on one menu + one dialog measured against the live HUD).

## Sources

- Repo + README: <https://github.com/vercel-labs/ui> (`packages/svelte/package.json`,
  `packages/core/src/index.ts`, `foundation/platform/anchoring.ts`, `scripts/size.mjs`,
  `packages/core/skills/ui-sdk/SKILL.md`)
- Docs: <https://ui-sdk.dev/docs> (SvelteKit server rendering, installation, agents/WebMCP)
- Issues #543, #1001, #690 on `vercel-labs/ui`
- npm registry: `@ui-sdk/core`, `@ui-sdk/svelte`, `bits-ui`, `melt`, `@ark-ui/svelte`,
  `@zag-js/svelte` (versions, publish times, weekly downloads 2026-11-15..21)
- Vercel public beta agreement: <https://vercel.com/docs/release-phases/public-beta-agreement>
- Shepherd: `ui/package.json`, `ui/src/lib/a11yDialog.ts`, `ui/src/lib/tooltips/`,
  `src/house-stack.ts`, `src/readiness.ts`, `src/readiness-drift-core.ts`
