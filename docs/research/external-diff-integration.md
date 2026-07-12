# Research: a fancier Diff tab via diffs.com / hunk.dev

**TL;DR — the two things you named are the same engine.** `diffs.com` is the
docs/marketing site for **`@pierre/diffs`**, Pierre's open-source diff-rendering
library. `hunk.dev` (a review-first _terminal_ diff viewer) is **built on that
same `@pierre/diffs` engine**. So "integrate diffs.com or hunk.dev" reduces to
one real question: **do we adopt `@pierre/diffs`?** hunk itself is terminal-only
(OpenTUI, no DOM target) and cannot render inside our web Diff tab — but it's a
useful design north-star for review-first, agent-authored-changeset UX.

**Recommendation:** treat this as a **build-vs-adopt** decision with two credible
adopt candidates. If the goal is _fancy + agent-review-native_, prototype
**`@pierre/diffs`** (the literal thing asked for; reuses our Shiki setup; ships a
comments/annotations framework tailor-made for agent review). If the goal is
_lowest-friction Svelte-native fit_, **`@git-diff-view/svelte`** consumes our
existing structured `DiffResult` almost verbatim. A near-identical-stack
reference implementation already exists in the wild — **PaperMC's `diffs.dev`**
(SvelteKit + Svelte 5 + Tailwind 4 + Shiki + jsdiff + virtua) — proving the
approach works in exactly our stack. Do a half-day spike of each before
committing; **no code was changed for this report.**

---

## What we have today

The Diff tab is a small, custom, server-fed renderer — worth understanding
before deciding what a "fancier" version buys us:

- **Data:** `GET /api/sessions/:id/diff` → `git diff --no-color <base>...HEAD` in
  the session worktree, **parsed server-side** (`src/diff.ts`) into a structured
  `DiffResult` (`files[] → hunks[] → lines[]` with `kind` add/del/ctx +
  old/new line numbers). Caps: 2000 lines/file, 100k total; binary/truncated
  flagged. Polls every 15s while the tab is visible.
- **Render:** hand-written Svelte (`DiffPanel.svelte` + `DiffFileBlock.svelte`,
  ~370 lines) with **Shiki** (`ui/src/lib/highlight.ts`) for highlighting, lazy
  per-file on expand. Custom `shepherd-dark`/`shepherd-light` Shiki themes whose
  hexes mirror our `--color-*` tokens.
- **Have:** unified view, per-file collapse, syntax highlighting, summary bar,
  stale-base warning, live polling, large-diff caps, theme-aware.
- **Missing (the "fancier" wishlist):** side-by-side view, **word/intra-line
  diff**, file-tree sidebar, DOM virtualization, expand-context,
  **line-level comments/annotations**, in-diff search.

Critically, the structured `DiffResult` API + server parser are **reusable
as-is** by any of the options below — no new endpoint needed.

---

## The three named artifacts, evaluated

| Artifact      | What it actually is                                                     | Web-embeddable?                                             | License                    | Verdict for our tab                                      |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| **diffs.com** | Docs site for **`@pierre/diffs`** (npm)                                 | **Yes** — vanilla JS + React, built on Shiki                | Apache-2.0 (published pkg) | **Adopt candidate #1**                                   |
| **hunk.dev**  | Review-first **terminal** diff viewer (OpenTUI), _uses_ `@pierre/diffs` | **No** — TUI-only, no DOM                                   | MIT                        | **Inspiration only** (design north-star; not embeddable) |
| **diffs.dev** | PaperMC's hosted **SvelteKit** diff viewer (you likely meant this)      | Source public but **`license: None`** → all-rights-reserved | none                       | **Reference architecture only** — do not copy code       |

Notes that matter:

- **hunk is a dead end for the web tab** but a great _reference for the UX
  bar_: a persistent changeset sidebar, split view with inline **AI
  annotations rendered beside the code they describe**, and watch-mode reload.
  That "AI reasoning lives in the diff, not another tab" philosophy is exactly
  what an agent-session diff tab wants. Its engine is `@pierre/diffs`, so
  adopting that library gets us the same substrate hunk builds on. (A separate,
  out-of-scope idea: hunk could run as a _terminal-side_ companion inside a
  session's PTY — but that's not "the Diff tab.")
- **diffs.dev is the strongest existence proof.** PaperMC solved our exact
  problem in our exact stack (SvelteKit + Svelte 5 + Tailwind 4 + Shiki +
  `diff@9`/jsdiff + **`virtua` for virtualization**), with a file sidebar,
  split/unified, search, and smooth large-diff scrolling. We **cannot lift
  their code** (unlicensed), but it validates the "hand-rolled on Shiki + jsdiff
  - virtua" path and shows the perf technique (DOM windowing) our current
    renderer lacks.

---

## Realistic integration options

Ranked for a Svelte 5 app that wants: split+unified toggle, word-level diff,
Shiki reuse, virtualization, and a file sidebar.

### Option A — Adopt `@pierre/diffs` (the "diffs.com/hunk" engine)

- **npm** `@pierre/diffs` (v1.2.x, actively published) — vanilla-JS + optional
  React (React is a _peer_ dep, not required), plus SSR + Worker entries. Core
  `@pierre/precision-diffs` exists too. Built on **Shiki** (adapts to Shiki
  themes) + **jsdiff** (word-level). Apache-2.0.
- **Features (superset of our wishlist):** split/stacked, Shiki highlighting,
  inline char/word diff, merge-conflict UI, **annotation/comments framework**,
  BYO accept/reject UI, line selection, token-hover callbacks, custom fonts.
- **Fit:** it's literally what was asked for, and the annotations framework is a
  standout for **agent review UX** (attach an agent's rationale to a line).
- **The catch — Shadow DOM:** it renders via CSS Grid **inside Shadow DOM** to
  minimize nodes. That _isolates_ it from `app.css` `--color-*` tokens, so our
  design-token theming can't cascade in. Mitigation: it "adapts to Shiki
  themes," and we already have `shepherd-dark`/`shepherd-light` Shiki
  themes — we'd theme it by **passing those in**, not via our token cascade.
  Needs validation that light/dark switching and our exact palette come through
  cleanly. No first-party Svelte wrapper → drive the vanilla API from a Svelte
  action/component.

### Option B — Adopt `@git-diff-view/svelte` (best Svelte-native fit)

- **npm** `@git-diff-view/svelte` + `@git-diff-view/core` + `@git-diff-view/shiki`
  (v0.1.x, very active, ~700★, MIT). Truly framework-agnostic core with a
  **real Svelte 5 wrapper** (not a port).
- **Consumes our data almost verbatim:** `data = { oldFile, newFile, hunks }`
  where `hunks` is unified-hunk strings — a thin serialization of our existing
  `DiffResult`. **Reuses Shiki** via `@git-diff-view/shiki`. Split+unified,
  word diff, collapsible hunks, expand-context, a **widget system** for
  per-line comments, Web-Worker offload. Renders to **light DOM** → our tokens
  and theming apply normally.
- **Gap:** **no built-in file sidebar** (build from our per-file JSON — trivial,
  and we'd want our own UX anyway) and **no DOM virtualization** (fine unless we
  routinely render single files with tens of thousands of changed lines; our
  server already caps at 2000 lines/file, so largely moot).

### Option C — `@codemirror/merge` (best virtualization)

Framework-agnostic, MIT, best-in-class viewport windowing + word diff,
split+unified, collapse-unchanged. **Costs us Shiki** (CodeMirror/Lezer
highlighting instead), wants two full document strings (reconstruct old/new from
our model), and carries editor semantics for a read-only tab. Pick only if
virtualizing multi-MB single files is a hard requirement.

### Option D — Extend the in-house renderer

Add side-by-side + word-level (via `diff@9`/jsdiff, matching diffs.dev/pierre) +
a sidebar + `virtua` windowing to our existing ~370-line renderer. Keeps full
token/i18n/theming control and zero Shadow-DOM friction; costs the most bespoke
work and we re-implement what a library gives free. Reasonable if we want ~one
new capability (e.g. just side-by-side) rather than the whole fancy set.

### Option E — diff2html (low-effort baseline)

Unified-string in, HTML out; side-by-side + word diff + file summary in an
afternoon. But **highlight.js not Shiki**, no virtualization, no comments. The
"good enough, minimal effort" floor — likely a downgrade on highlighting vs what
we already ship.

---

## Shepherd-specific integration considerations

Whatever we pick has to clear these house-rule gates:

1. **Design tokens / Shadow DOM.** Option A's Shadow DOM is the biggest unknown:
   it bypasses `app.css`. Options B/D/E render to light DOM and honor
   `--color-*`/`--fs-*` directly. Any adopted component must render as one of
   our themes in _both_ light and dark, and must not introduce raw hex — for A
   that means proving the Shiki-theme bridge; for B it's native.
2. **i18n.** New chrome (view toggle, sidebar labels, "expand context", comment
   affordances, empty/error states) must route through Paraglide (`en.json` +
   `de.json`, `check:i18n` gate). Note: today's `DiffFileBlock.svelte` already
   has **hardcoded English** ("binary file", "large file — view in terminal",
   "no textual changes") — fix these in the same PR if we touch it.
3. **Reuse the existing pipeline.** Keep `GET /api/sessions/:id/diff` + the
   server parser; feed any library from `DiffResult`. Don't add a client-side
   git/diff round-trip.
4. **Agent-review opportunity.** The differentiator vs a generic diff viewer is
   agent context: attach the agent's per-line rationale, or link a hunk to the
   plan step / tool call that produced it (Pierre's annotations or git-diff-view's
   widgets both support this). This is where hunk's philosophy pays off and where
   a plain library swap would _under_-deliver.
5. **Licensing.** `@pierre/diffs` Apache-2.0 ✓, `@git-diff-view/*` MIT ✓,
   `@codemirror/merge` MIT ✓, diff2html MIT ✓. **PaperMC diffs.dev is
   unlicensed — reference only, never copy.** (`@pierre/diffs`'s _repo_ has no
   top-level LICENSE though the _published package_ declares Apache-2.0 — worth a
   quick confirm before adoption.)
6. **Bundle / perf.** All are Shiki-based except CM/diff2html; A and B both let
   us keep our single Shiki instance. Lazy-load the diff renderer (we already
   lazy-import highlighting), and consider `virtua`-style windowing if we lift
   the per-file line cap.
7. **Feature-discovery + design-system.** A visibly fancier Diff tab is a
   user-facing feature → needs a `feature-announcements` entry and a pass on
   `/design-system` recipes in the shipping PR.

---

## Recommendation & next steps

1. **Two-prong spike (≈half a day each), decision-gated:**
   - **`@pierre/diffs`** — mount the vanilla renderer in a throwaway Svelte
     component, feed one real session's diff, and answer the deciding question:
     **can Shadow DOM + Shiki-theme injection reproduce our exact light/dark
     palette?** If yes, it's the fanciest, most on-brand-with-the-request path
     and unlocks agent annotations.
   - **`@git-diff-view/svelte`** — serialize `DiffResult → { oldFile, newFile,
hunks }`, render with `@git-diff-view/shiki`, confirm tokens/theming apply
     natively. This is the low-risk baseline.
2. **Compare on:** theming fidelity, effort to reach split+word-diff+sidebar,
   large-diff behavior, and how cleanly per-line agent annotations attach.
3. **Then pick:** `@pierre/diffs` if the Shadow-DOM/theming spike passes and we
   want the review-first ceiling; otherwise `@git-diff-view/svelte`.
4. **Explicitly reject:** embedding hunk (terminal-only) and copying diffs.dev
   (unlicensed) — use both as UX/architecture references only.

## Open questions

- Fancy-viewer priority: **side-by-side + word-diff** only, or the full
  review-first experience (sidebar + line annotations)? Scopes A-vs-B/D.
- Is **per-line agent annotation** (rationale/tool-call linkage) in scope, or a
  later phase? It's the main reason to prefer `@pierre/diffs` over a plain swap.
- Do we ever hit single files big enough to _need_ virtualization, given the
  2000-line/file server cap? If never, Option A/B's lack of windowing is moot.
- Confirm `@pierre/diffs` repo-level license (package says Apache-2.0; repo root
  has no LICENSE) before adoption.

---

### Sources

- `@pierre/diffs` — https://diffs.com · https://www.npmjs.com/package/@pierre/diffs · https://github.com/pierrecomputer/pierre/tree/main/packages/diffs
- hunk — https://www.hunk.dev/ · https://github.com/modem-dev/hunk
- PaperMC diffs.dev — https://diffs.dev/ · https://github.com/PaperMC/diff-viewer
- `@git-diff-view` — https://github.com/MrWangJustToDo/git-diff-view · https://mrwangjusttodo.github.io/git-diff-view/
- `@codemirror/merge` — https://github.com/codemirror/merge
- diff2html — https://github.com/rtfpessoa/diff2html
