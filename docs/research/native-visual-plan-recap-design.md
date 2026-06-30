# Native visual plan / recap for Shepherd — design research

**Decision (settled):** a SaaS dependency is off the table. BuilderIO's [`visual-plan` / `visual-recap`](https://github.com/BuilderIO/skills) skills are thin wrappers around a hosted app (`plan.agent-native.com`) reached over an MCP connector — exactly what Shepherd's spawns forbid (`--safe-mode` blocks MCP, `--disable-slash-commands` drops skills, the netns egress allowlist firewalls off-box hosts, in-app LLM is a subscription spawn). The renderer is MIT and self-hostable, but standing up a separate React/Nitro/SQL app + MCP connector to duplicate surfaces we already own is the wrong trade. _Short form of the prior evaluation; kept as the rationale of record._

**This document is the pivot:** how to rebuild the **experience** — a scannable, structured visual review made of typed blocks (diagrams, file-trees, annotated diffs, schema/API cards, wireframes) — **natively inside Shepherd**, reusing what's already in the UI, with no new external dependency and no change to spawn isolation.

The headline finding: **Shepherd already has the expensive half built.** Syntax highlighting (`shiki` via `ui/src/lib/highlight.ts`), a complete git-diff renderer with a hunk/line model (`DiffPanel` + `DiffFileBlock.svelte`), and the semantic token layer (`ui/src/app.css`) are all in place. The gap is a **block schema**, a **shared renderer**, and a handful of **new block components** — plus the prompt/persistence plumbing to carry blocks. This is an additive feature, not a platform.

Sources: [BuilderIO/skills](https://github.com/BuilderIO/skills) (MIT), [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native) (renderer, MIT). Full extracted block spec + wireframe token bar in §1 / Appendix.

---

## 1. What we're replicating (condensed block model)

The Agent-Native model is a **document of typed blocks**, optionally topped by a **visual surface** (wireframe canvas / prototype). A _plan_ is built toward a change; a _recap_ is built from a diff — same blocks, opposite direction. The renderer owns the look; the author owns content + semantic structure. Full catalog is 20 blocks; the load-bearing ones:

| Block                 | Renders                                                                            | Recap role                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `rich-text`           | Prose (markdown: headings, lists, code, links)                                     | The "why" / narrative / risk read — the **only** place the model writes freely                        |
| `diff`                | GitHub-style before/after, split or unified, with line `annotations` + a `summary` | The headline code primitive — grouped under `## Key changes` in a horizontal `tabs`, one file per tab |
| `annotated-code`      | Line-numbered code with anchored margin notes                                      | A brand-new file or a load-bearing file with no meaningful "before"                                   |
| `file-tree`           | VS Code-style tree from slash paths, per-file `change` badge + `note`              | The change footprint                                                                                  |
| `data-model`          | ERD entity cards, typed fields, PK/FK flags, `change`/`was`                        | Schema / migration changes                                                                            |
| `api-endpoint`        | Method pill + path, collapsible params/request/responses                           | Route / contract changes                                                                              |
| `diagram` / `mermaid` | 2-D architecture/flow (HTML+SVG, or mermaid source)                                | Architecture shifts                                                                                   |
| `wireframe`           | HTML mockup of a screen, renderer-themed                                           | UI changes (canvas, top surface)                                                                      |
| `callout`             | Toned note (`info`/`decision`/`risk`/`warning`/`success`)                          | Settled decisions, assumptions, risks                                                                 |
| `table` / `checklist` | Scannable structure                                                                | Comparisons, task lists                                                                               |
| `question-form`       | The single bottom Open-Questions form (single/multi/freeform)                      | **Plans only** — the one place open questions live                                                    |

**The load-bearing correctness rule (steal this verbatim):** structured blocks are _true by construction_ only if derived from the **actual changed lines** — real paths, real fields, real method/path, real before/after text — never inferred or invented. The model writes only the prose. "A confidently wrong recap is dangerous: a reviewer who trusts the summary may skip the very line the summary got wrong." When the diff doesn't contain a fact, leave it out; mark anything inferred (not extracted) as inferred. Plus: redact secrets in any diff/snippet/endpoint (`sk-•••`, `<redacted>`), and never auto-publish (recaps expose unreleased schema/internal endpoints). This rule maps **directly** onto a native design that joins LLM-chosen blocks with the **real git diff Shepherd already has** (see §3.2).

## 2. What Shepherd already has (the reuse inventory)

| Need                | Already in repo                                                                                                                                                                                                 | Reuse verdict                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Syntax highlighting | `ui/src/lib/highlight.ts` — shiki singleton, Shepherd light/dark themes, `highlightLines(contents, path, theme)`, 13 langs                                                                                      | **Reuse as-is** for `code` / `annotated-code` / `diff`                                                                                                                    |
| Git diff rendering  | `DiffPanel.svelte` + `DiffFileBlock.svelte` — expandable per-file, status glyphs, +/- counts, lazy per-line highlight, binary/truncated states; `DiffFile`/`DiffHunk`/`DiffLine` model in `ui/src/lib/types.ts` | **Reuse / factor out** the per-file diff view into the `diff` block                                                                                                       |
| Markdown prose      | `marked` + `dompurify` lazy pattern in `DoneRecapPanel`, `PlanPanel`, `SessionRecap`                                                                                                                            | **Reuse** for the `rich-text` block                                                                                                                                       |
| Design tokens       | `ui/src/app.css` — `--color-*` surfaces/text/accents, `--fs-*` scale, `--status-*`/`--wash-*` (truly global); `.scrim`/`.overlay` are the only global class recipes                                             | **Map** `--wf-*` → the tokens (§3.3). NB: `.gbtn`/`.badge`/`.panel` are documented on `/design-system` but are **per-component scoped styles**, not importable — see §3.4 |
| Host panels         | `DoneRecapPanel.svelte`, `SessionRecap.svelte` (recap); `PlanPanel.svelte` (plan) — all already render the flat markdown body                                                                                   | **Extension slots** for the shared block renderer (§3.4)                                                                                                                  |
| Verdict plumbing    | `src/recap-core.ts` (`parseRecapVerdict`, prompt), `src/plan-gate.ts` (`RawPlanVerdict`, prompt); `Recap`/`PlanGate` rows in `src/types.ts`                                                                     | **Extend** with an optional `blocks` field (§3.1)                                                                                                                         |

What's **missing** and must be built new: `file-tree`, `data-model`, `api-endpoint`, `diagram`/`mermaid`, `wireframe`, `callout`, `table`, `checklist`, `question-form` components; the block schema + parser; the shared `<VisualReview>` renderer; the secure-HTML sandbox for wireframe/diagram.

## 3. Native design

### 3.1 Block schema — JSON, not MDX

BuilderIO uses MDX as a repo-friendly authoring surface and JSON as the runtime. **Shepherd should use JSON only** — a discriminated union the spawn emits and Svelte components render. No MDX parser, no `{@html}` of LLM prose-as-markup. Render structured fields through normal Svelte interpolation (safe by default); the only HTML that ever reaches `{@html}` is (a) sanitized markdown in `rich-text`, exactly as today, and (b) the explicitly-sandboxed `wireframe`/`diagram` HTML (§3.5).

```ts
// src/visual-blocks.ts (shared by server + ui via the existing types path)
type VisualBlock =
  | { type: "rich-text"; id: string; markdown: string }
  | {
      type: "callout";
      id: string;
      tone: "info" | "decision" | "risk" | "warning" | "success";
      markdown: string;
    }
  | {
      type: "file-tree";
      id: string;
      title?: string;
      entries: {
        path: string;
        change: "added" | "modified" | "removed" | "renamed";
        note?: string;
      }[];
    }
  | {
      type: "diff";
      id: string;
      path: string;
      summary: string; // content joined server-side (§3.2)
      annotations?: { lines: string; label?: string; note: string; side?: "before" | "after" }[];
    }
  | {
      type: "annotated-code";
      id: string;
      filename?: string;
      language?: string;
      code: string;
      annotations?: { lines: string; label?: string; note: string }[];
    }
  | {
      type: "data-model";
      id: string;
      inferred?: boolean;
      entities: {
        id: string;
        name: string;
        fields: {
          name: string;
          type: string;
          pk?: boolean;
          fk?: string;
          nullable?: boolean;
          change?: "added" | "modified" | "removed" | "renamed";
          was?: string;
        }[];
      }[];
      relations?: { from: string; to: string; kind: string }[];
    }
  | {
      type: "api-endpoint";
      id: string;
      method: string;
      path: string;
      summary?: string;
      change?: string;
      deprecated?: boolean;
      inferred?: boolean;
      params?: { name: string; in: string; type: string; required?: boolean; note?: string }[];
      responses?: { status: number; description?: string; example?: string }[];
    }
  | { type: "mermaid"; id: string; source: string; caption?: string; inferred?: boolean }
  | { type: "table"; id: string; columns: string[]; rows: string[][] }
  | {
      type: "checklist";
      id: string;
      items: { id: string; label: string; note?: string; checked?: boolean }[];
    }
  // phase 3:
  | {
      type: "wireframe";
      id: string;
      surface: "browser" | "desktop" | "mobile" | "popover" | "panel";
      html: string;
      caption?: string;
    }
  | {
      type: "question-form";
      id: string;
      questions: { /* plans only */ }[];
    };
```

Add `blocks?: VisualBlock[]` (optional) to `Recap` and `PlanGate`. **Absent → render flat markdown body, exactly as today.** Old rows and a spawn that emits no blocks both keep working — the block layer is a strict superset. Parser is a per-variant validator (drop unknown/malformed blocks, never throw — fail closed to the markdown body).

### 3.2 Grounding: the server joins blocks with the real diff

The single best native move. Shepherd's recap spawn already runs read-only under `dontAsk` with only `Write`, in a tmpdir, reading the live worktree — and the **server already computes the real git diff** (`changedFiles`, and `DiffPanel` fetches a parsed `DiffFile[]` via API). So:

- The LLM emits **lightweight, selective** blocks: _which_ files to feature, the one-line `summary`, a few `annotations`, per-file `note`s, the prose, and the extracted `data-model`/`api-endpoint`/`mermaid`.
- For `diff` and `file-tree`, the **server supplies the authoritative content** by joining the block's `path` against the real `DiffFile[]` it already has. The LLM never re-types diff hunks (which is where invented lines creep in); it only chooses and annotates.

This enforces "true by construction" _structurally_, not by trusting the model — added/removed lines are the real ones; only `data-model`/`api-endpoint`/`mermaid` remain genuinely model-extracted, so those carry an `inferred?` flag the renderer surfaces as a small "inferred" tag. Keeps spawn output small (cheaper, faster) and keeps the diff authoritative.

> **Plan-side resolution (shipped, #799 / closes the §7 grounding open question).** The join above is a _recap_ mechanism — a recap is built _from_ a diff. A **plan is built _toward_ a change, so there is no diff yet**, and the diff-join cannot apply. Plans therefore use a separate, simpler grounding path, `groundPlanBlocks()` (in `src/visual-blocks.ts`): it **drops `diff`/`code`/`annotated-code`** (no real content exists to join), passes `file-tree` through **as authored** (the entries are _intended_ paths, never reconciled against any diff), forces `inferred:true` on `data-model`/`api-endpoint`/`mermaid` (proposed designs), and passes the remaining model-authored blocks (`rich-text`/`callout`/`table`/`checklist`/`mermaid`/`wireframe`/`question-form`) through. So plan blocks are model-authored only — true by _authoring_, not by diff-derivation — and the UI frames the whole plan surface as "Proposed — not yet built · the plan text below is authoritative."
>
> **Plan block source — the `.shepherd-plan-blocks.json` sidecar (shipped, #799).** Unlike recaps (a dedicated read-only spawn emits `.shepherd-recap.json` with its `blocks`), the plan gate has **no block-emitting spawn**: the live planning agent authors the plan. So the agent optionally writes a **sidecar** — a bare JSON array of `VisualBlock`s — to **`.shepherd-plan-blocks.json`** next to `.shepherd-plan.md`, instructed by `planBlockInstructions()` appended to the plan-gate directives (`src/service.ts`). The agent must write/update the sidecar **in the same turn as — and re-write it on every revision of — `.shepherd-plan.md`** (the server captures blocks at plan-review _begin_, keyed to the reviewed plan hash; a sidecar written afterward is missed). `PlanGateService.begin()` reads the sidecar via `defaultReadPlanBlocks` (= `parseVisualBlocks` → `groundPlanBlocks`), snapshots it into the in-flight review, and `buildGate()` persists it on `PlanGate.blocks`. `PlanPanel` then renders `<VisualReview>` **above** (not instead of) the reviewed markdown plan. The sidecar is an optional **visual-rendering aid**, never the authoritative plan and never a place to park decisions/questions.

### 3.3 Token mapping (`--wf-*` → Shepherd `--color-*`)

The wireframe/diagram system themes entirely off `--wf-*` tokens (no raw hex, no `font-family`, no decorative shadow — the renderer owns the look). Map them onto Shepherd's existing tokens so blocks theme correctly in light/dark with zero new color decisions:

| `--wf-*`      | Shepherd token                 |     | `--wf-*`           | Shepherd token                |
| ------------- | ------------------------------ | --- | ------------------ | ----------------------------- |
| `--wf-ink`    | `--color-ink-bright`           |     | `--wf-accent`      | `--color-amber`               |
| `--wf-muted`  | `--color-muted`                |     | `--wf-accent-fg`   | `--color-bg`                  |
| `--wf-line`   | `--color-line`                 |     | `--wf-accent-soft` | `color-mix(amber 20%, panel)` |
| `--wf-paper`  | `--color-bg`                   |     | `--wf-warn`        | `--color-red`                 |
| `--wf-card`   | `--color-panel`                |     | `--wf-ok`          | `--color-green`               |
| `--wf-radius` | `2px` (Shepherd's flat radius) |     |                    |                               |

Ship these as a small `wf-tokens.css` injected into the wireframe/diagram sandbox only (§3.5). This is the cleanest part — Shepherd's flat, token-pure, shadow-light aesthetic _already matches_ the wireframe quality bar ("flat, bordered surfaces, no decorative shadow").

### 3.4 Rendering — one shared component

A single `ui/src/lib/components/VisualReview.svelte` takes `blocks: VisualBlock[]` + `diffFiles: DiffFile[]` (for the diff join) + `theme` and dispatches each block to its component. Host panels gain one extension slot each:

- `DoneRecapPanel` / `SessionRecap`: render `<VisualReview>` in place of (or above) the flat markdown body when `recap.blocks` is present.
- `PlanPanel`: render `<VisualReview>` in the verdict/plan section.

Each block is its own small component (`FileTreeBlock`, `DataModelBlock`, `ApiEndpointBlock`, `CalloutBlock`, …). `DiffBlock` factors out the existing `DiffFileBlock` per-file view; `CodeBlock`/`AnnotatedCodeBlock` wrap `highlightLines()`. All consume the global `--color-*`/`--fs-*` tokens directly — no new design language.

**One styling caveat (not free reuse):** only the design _tokens_ and the `.scrim`/`.overlay` classes are global in `app.css`. The `.gbtn`/`.badge`/`.panel` "recipes" documented on `/design-system` are **per-component scoped Svelte styles** (re-declared in `design-system/+page.svelte`, `Settings.svelte`, `Herd.svelte`, etc.) — Svelte scopes a component's `<style>`, so another component cannot `class="panel"` its way to them. So each new block component must **re-author the recipe markup in its own scoped `<style>`** (copy-paste from `/design-system`, built on the shared tokens). The _look_ is reused; the CSS is not. Budget per-component styling, not zero-cost. If a recipe (e.g. `.badge`) ends up repeated across several block components, consider promoting it to a global class in `app.css` as part of this work — but that's a deliberate, separately-reviewed change, not an assumed given.

### 3.5 Security — the only sharp edge

Structured blocks render through Svelte interpolation = safe. Three blocks carry raw HTML and need real isolation:

- **`wireframe` / `diagram` (HTML+SVG):** render inside a **sandboxed `<iframe sandbox>`** (no `allow-scripts`), with the `wf-tokens.css` + a fixed stylesheet injected, and the LLM HTML run through a **strict DOMPurify allowlist** (structural tags + `style`/`class`/`data-*` only; strip `<script>`/`<style>`/event handlers/`href`). BuilderIO sanitizes wireframe HTML on every write and sandboxes `custom-html` in an iframe — mirror that. Diff content still gets secret-redaction at the source per the grounding rule.
- **`mermaid`:** prefer mermaid over freeform diagram HTML where a flow/sequence fits — it's a constrained text grammar, far less injection surface and less invented-architecture risk. Render with `securityLevel: 'strict'` (mermaid has a history of `{@html}` XSS). Adds one dependency to the **UI bundle only** (not the spawn) — acceptable; lazy-import it like marked.
- **No `custom-html` block.** BuilderIO's own escape hatch; we don't need it and it's the worst injection surface. Omit.

## 4. Phasing

| Phase       | Blocks                                                                       | New vs reuse                                                                    | Value                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP**     | `rich-text`, `file-tree`, `diff`, `callout`                                  | diff/markdown **reused**; file-tree + callout new (small)                       | A recap that shows the real change footprint + annotated real diff + narrative — already a large step over flat markdown, zero new deps |
| **Phase 2** | `annotated-code`, `code`, `data-model`, `api-endpoint`, `table`, `checklist` | code **reuses** highlight.ts; the cards are new (medium); carry `inferred` flag | Schema/API/contract changes become scannable cards                                                                                      |
| **Phase 3** | `mermaid`, `wireframe`, `question-form`                                      | new + sandbox + mermaid dep + token CSS                                         | Architecture diagrams, UI wireframes (recaps of UI work), open-questions form (plans)                                                   |

Each phase is shippable on its own; MVP alone is worth doing. Start with recaps (read-only, lower stakes) before plans.

## 5. Obligations when built (house rules)

- **Feature catalog:** user-facing → one `feature-announcements.ts` entry per shipped phase, `sinceVersion` = next unreleased.
- **i18n:** every label/empty/error/inferred-tag string through `m.*` with EN+DE parity (`check:i18n`). Block _content_ (diff text, paths, summaries) is passed-through data, not translated.
- **Design system:** tokens only — the `--wf-*` map lives in `app.css`; no raw hex. The wireframe sandbox is exempt from the scrim rule (it's content, not a modal).
- **Glossary:** "recap", "plan gate" likely already marked; no new terms expected.

## 6. Explicitly out of scope (vs BuilderIO)

These are what make their product big; we deliberately don't rebuild them now:

- **Reviewer-annotation round-trip** (comments on a hosted plan flowing back to the agent). Shepherd's plan-gate already steers findings back via PTY; recap is read-only. Skip.
- **Prototype mode** (clickable multi-step HTML prototypes with `data-goto`). Large, low ROI for review. Skip.
- **MDX authoring/export + canvas lanes / artboard placement.** JSON-only; no shareable-URL export. Skip.
- **Live block registry / `get-plan-blocks`.** Our block set is a fixed, code-defined union — no runtime tag discovery.

## 7. Open questions

- **RESOLVED (#799) — plan-side grounding & block source.** A plan has no diff, so plan blocks are not diff-grounded: they are model-authored only, grounded by `groundPlanBlocks()` (drops diff/code, marks inferred, passes `file-tree` of _intended_ paths through), and sourced from the live agent's `.shepherd-plan-blocks.json` sidecar (written in the same turn as `.shepherd-plan.md`), captured into `PlanGate.blocks` at plan-review begin and rendered _above_ the authoritative markdown in `PlanPanel`. See §3.2. The reviewer-annotation/answer round-trip for `question-form` remains out of scope (§6) — `question-form` ships read-only, offered only to the unattended (AUTO) planning variant.
- MVP scope: is `rich-text` + `file-tree` + `diff` enough to ship first, or pull `data-model`/`api-endpoint` forward (they're the highest-signal for backend recaps)?
- Wireframe block: worth the sandbox complexity at all, or is it only justified once Shepherd gains a UI-plan flow? (Recaps of UI changes are the only consumer.)
- Diff join: render the featured `diff` blocks from the server's parsed `DiffFile[]`, or have the spawn pass `before/after` strings (simpler wiring, weaker grounding)? Recommend the join.
- Mermaid: accept the new UI dependency + its XSS history (mitigated by `securityLevel:'strict'`), or render diagrams only as sandboxed HTML/SVG and skip mermaid?
- Does the recap spawn (tmpdir, `Write`-only) get the parsed diff handed in via the prompt, or does the server do the join post-spawn from data it already holds? Recommend post-spawn server join.

---

## Appendix — wireframe block quality bar (for the phase-3 implementer)

The `wireframe` block is an HTML mockup; the renderer owns theme/font/footprint. Authoring rules to encode in the prompt + sandbox, quoted from the skill's `wireframe.md`:

- **Surface presets** pick the footprint: `browser` / `desktop` / `mobile` / `popover` / `panel` — "a sidebar popover renders as a small surface, not a desktop page and a phone frame. Do not emit `desktop` + `mobile` variants unless responsive behavior actually changes the layout."
- **Color only via `--wf-*` tokens**, never hex/rgb/hsl; **never set `font-family`** (renderer owns the font); **no decorative shadows** ("mockups should read as flat, bordered surfaces").
- **Real layout via inline flex/grid** with `gap`; root container with `≥14–16px` padding, `box-sizing:border-box`, `height:100%`; chrome bars full-width; bottom bars pinned via `margin-top:auto`; single-line labels `white-space:nowrap`.
- **Helper classes** `.wf-card`/`.wf-box`/`.wf-pill`/`.wf-chip`/`.wf-muted`, `button.primary`/`[data-primary]`; **icons** via empty `<span data-icon="mail">` markers (renderer swaps a Tabler SVG) — never the word "mail".
- **Before/After** = a two-column layout with `Before`/`After` column headers; never bake the label into the frame; never hand-stack the pair.
- **Skeletons:** `skeleton:true` + textless placeholder geometry (`background:var(--wf-line)`), no copy.

Shepherd's renderer would honor the same contract by injecting the `wf-tokens.css` map (§3.3) + a fixed helper-class stylesheet into the sandbox iframe, and rejecting any HTML that sets `font-family`, a hex color, or a `box-shadow`.
