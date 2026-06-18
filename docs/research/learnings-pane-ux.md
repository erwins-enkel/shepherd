# Learnings pane — full UX pass

**Scope:** the Learnings drawer (`ui/src/lib/components/LearningsDrawer.svelte`, 783 lines) and its
helpers/data path (`learnings-drawer.ts`, `learnings.svelte.ts`, `src/server.ts` learnings routes,
`src/house-rules.ts`). This is a review-only document — no product code changes. It prioritises the two
problems raised on commission (budget triage and weak repo separation), then covers the rest of the
surface.

**Bottom line:** the drawer is clean, consistent, and well-tokenised — but it's a **flat scroll with no
triage layer**. Every decision the operator makes (which repo is over budget, which rule to drop, which
rule is broken) requires reading numbers rule-by-rule down a single column. The fix is not a redesign of
the components; it's adding a **summary/triage band at the top**, **sticky repo headers**, and **making
"over budget" a visible state instead of a number you have to compute**. Most of this is additive and
low-risk.

---

## The two commissioned problems

### Problem 1 — Budget triage is buried (the headline issue)

Walk the current path when an operator is told "you're over budget":

1. Open the drawer (global button, or a repo chip).
2. Scroll through **every** repo group, top to bottom.
3. For each repo, read the meter string — `learnings_budget_meter` renders
   `"{used}/{budget} chars · {injected}/{total} injected"` (`en.json:434`), e.g. `4280/4000 chars · 6/8
injected`. The operator must **mentally compare `used` vs `budget`** to notice it's over, and **subtract
   `injected` from `total`** to learn 2 rules were dropped.
4. Find the over-budget repo's section, then scroll to the **bottom** of its injected list — the planner
   returns `injected` first, `dropped` last (`server.ts:910`), so the rules that actually need attention
   are the least visible.
5. Spot the `⊘ Over budget` badges (`LearningsDrawer.svelte:329`).
6. Decide what to cut — with no signal about which rule costs the most chars, and no action other than
   **Dismiss** (which deletes the rule permanently; see Problem 1c).

Every step is manual scanning. Concretely, four things are missing:

**1a. There is no top-level "what needs attention" view.** `mergeRepoGroups` (`learnings-drawer.ts:47`)
orders repos first-seen-proposed, then injectable-only — it **never floats over-budget or flagged repos to
the top**. The global Learnings button _does_ carry a `curate` count (`queue-strip.ts` `globalLearningsCounts`),
but the moment you open the drawer that prioritisation is gone. You're back to a flat list.

**1b. "Over budget" is a number, not a state.** `.meter` is `color: var(--color-muted)` unconditionally
(`LearningsDrawer.svelte:708`) — it looks identical at `1200/4000` and `4280/4000`. The only over-budget
signal is the per-rule `⊘ Over budget` badge buried at the bottom of a repo. There is no repo-level "OVER
BY 280 chars · 2 dropped" headline, no colour, no progress bar. The single most important fact in this
pane is the hardest to see.

**1c. The only remedy is destructive.** The over-budget tooltip says _"Dismiss an active rule to free up
room"_ (`learnings_overbudget_title`, `en.json:440`). But Dismiss **permanently deletes** the rule (it's
the same `ondismiss` used to reject a proposal) with **no confirmation**. To get under budget you must
throw rules away — there's no "park this rule" / "keep but don't inject" intermediate state, and no manual
priority control (injection priority is auto, by `lastEvidenceAt`, in `house-rules.ts prioritize`). So the
operator's only lever for a budget problem is irreversible deletion.

**1d. The budget is global but presented as if per-repo.** Every repo is measured against the same
`config.houseRulesBudgetChars` (default 4000, `config.ts:376`; flows through `server.ts:887`). Nothing in
the drawer tells the operator the budget is a single global ceiling, that it's configurable, or what a
healthy fill looks like. An operator fighting a recurring over-budget repo has no visible path to "raise
the budget" as an alternative to "delete rules."

### Problem 2 — Repo boundaries are not obvious

A repo group is delimited by exactly: a header with a `border-bottom: 1px solid var(--color-line)` under
the repo name (`.ghead`, line 512) and an 8px gap to the next group (`.group` gap, line 510). There is **no
group container, no background, no sticky header**. Inside a group there are _also_ bordered cards
(`.rule`, `.irule`) and an `Injected house rules` subsection — so at a glance the page is a uniform stack
of bordered boxes, and the one line that means "new repo starts here" looks much like the boxes around it.

When you scroll into a repo with several rules, the header scrolls away and **you lose track of which repo
you're acting on** — dangerous, because Approve/Dismiss/Promote are irreversible and repo-scoped. The
operator's own words: _"the separation where one repo ends and one begins isn't very obvious."_ Confirmed.

---

## Design & UX scores

Scored as an **internal, information-dense operator tool** — the goal is scan-speed and decision-safety,
not decorative flair, so "Visual Atmosphere" is weighted low by intent.

| Category                 | Score     | Notes                                                                                                                                                                          |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typography               | 3/4       | Consistent `--fs-*` scale, tabular-nums on the meter and designators. Good.                                                                                                    |
| Color & Theme            | 3/4       | Fully tokenised; semantic hues (green=actionable, amber=attention, red=broken) used correctly. Loses a point because the **most important state (over budget) has no colour**. |
| Motion & Interaction     | 3/4       | Tasteful fly-in with `prefers-reduced-motion` honoured (line 114); caret rotations. Nothing gratuitous.                                                                        |
| Spatial Composition      | 2/4       | Single flat column; weak grouping; no sticky context; triage targets at the bottom of lists. This is the core problem.                                                         |
| Visual Atmosphere        | 2/4       | Flat surfaces by design — fine for the tool, but groups need one more layer of depth to read as containers.                                                                    |
| Information Architecture | 2/4       | No triage/summary layer; budget math offloaded to the operator; destructive action is the only budget remedy.                                                                  |
| **Overall**              | **15/24** | Solid, disciplined component work sitting on an IA that doesn't scale past a few repos.                                                                                        |

---

## Critical issues (fix first)

1. **Add a triage summary band at the top of the drawer.** Above the repo list, render a compact
   "needs attention" strip: one chip per repo that is over budget and/or has flagged rules, each a
   jump-link that `scrollIntoView`s the repo section (the anchor machinery already exists —
   `repoAnchorId` in `learnings-drawer.ts:14`, and the `focusRepo` deep-link effect, line 136). Show the headline number on
   each chip: `acme-web · 280 over · 2 dropped` / `api · 3 not working`. This collapses Problem 1's
   step 2–5 scan into a single glance + click. Hide the band entirely when nothing needs attention.

2. **Make "over budget" a visible repo-level state.** When `usedChars > budgetChars`, colour the meter
   amber and lead with the deficit, e.g. `OVER BY 280 · 2 dropped · 4280/4000 chars`. Optionally a thin
   fill bar that turns amber past 100%. Today `.meter` (line 708) is unconditionally muted — the operator
   reads two ratios and does the subtraction. (Mirror the existing `.filter-toggle[aria-pressed]` amber
   pattern, lines 438–441, so it's on-token.)

3. **Float over-budget / flagged repos to the top.** `mergeRepoGroups` (`learnings-drawer.ts:47`)
   currently preserves first-seen order. Add a stable sort key: repos with `usedChars > budget` first,
   then repos with flagged rules, then the rest — so the work is always at the top of the scroll, matching
   what the global button promised.

4. **Surface the dropped rules, don't bury them.** Within an over-budget repo, render the `dropped`
   (over-budget) rules **first** under a clear sub-label ("Not injected — over budget"), or pin them above
   the injected ones. Right now they're last (`server.ts:910`), i.e. the rules you came to fix are the
   furthest to scroll.

5. **Give the budget remedy a non-destructive path + a confirm.** Dismiss permanently deletes with no
   confirmation and is the _only_ suggested over-budget remedy (`en.json:440`). Two options, not mutually
   exclusive: (a) add a confirm step to Dismiss on an _active/promoted_ rule (proposals can stay one-click);
   (b) introduce a "park / don't inject" toggle so an operator can drop a rule out of the budget without
   losing it. At minimum, surface that the budget itself is configurable so deletion isn't the only lever.

## Sticky-header fix (Problem 2)

6. **Make `.ghead` sticky and give each group a container.** Set `.ghead { position: sticky; top: 0;
z-index: 1; background: var(--color-panel); }` so the repo name stays pinned while you act inside it
   (the drawer is the scroll container, line 402 — sticky will anchor to it cleanly). Pair it with a faint
   group surface — a left accent border or `background: var(--color-head)` on `.group` — so a new repo
   reads as a new _container_, not just another bordered box. This directly answers "where does one repo
   end and the next begin." Keep the sticky header height minimal so it doesn't eat the narrow 520px panel.

## Quick wins (high impact, low effort)

7. **Clarify the meter string.** `"{used}/{budget} chars · {injected}/{total} injected"` packs two
   ratios with different denominators. Split into a labelled budget line + an "N injected, M dropped"
   line, or add units/labels. (i18n: edit `learnings_budget_meter` in both `en.json` + `de.json` —
   parity gate enforced.)

8. **Add an "over budget" filter to match "Not working."** The header already has a flagged-only toggle
   (lines 158–167). A sibling "Over budget" filter lets the operator isolate exactly the repos/rules that
   need trimming — same pattern, same place.

9. **Disambiguate the two destructive/positive action clusters.** Proposed rules show `Dismiss | Approve`;
   active rules show `Optimize | Dismiss | Promote`. Dismiss sits inline next to a positive primary in both
   — easy mis-click on a permanent delete. Add spacing/visual de-emphasis to Dismiss, or move it behind a
   small overflow affordance on active/promoted rules.

10. **Label the global budget context.** One line in the (already-good) "What is this?" explainer: rules
    are injected per repo up to a shared character budget; over-budget rules are skipped. Sets the mental
    model so the meter makes sense the first time.

## Recommendations (larger improvements)

11. **A budget "cost" cue per rule.** When a repo is over budget, the decision "which rule to cut" is
    blind — nothing shows a rule's char cost or its injection priority. Show a small char count (and/or a
    "low priority — stale evidence" hint, from `lastEvidenceAt`) on each rule so the operator can cut the
    cheapest-to-lose rule, not guess.

12. **Consider splitting the two mental modes.** The drawer fuses two jobs: _curating proposals_ (editable,
    Approve/Dismiss) and _managing active house rules_ (read-only, budget/promote/optimize). They have
    different cadences and different operators-in-the-moment. A segmented top control ("Proposed N ·
    Active M") that filters the view would reduce the scroll and make each mode's actions unambiguous —
    without losing the per-repo grouping inside each.

13. **Empty-after-filter and loading states.** Verify the flagged/over-budget filters show a graceful
    "nothing flagged" state rather than a blank scroll, and that the initial three-fetch load
    (`learnings.svelte.ts load()`) has a skeleton/spinner rather than a flash of the empty message.

## What's working well (keep)

- **Full tokenisation** — no raw hex/px; clean alignment with the design-system contract.
- **Semantic colour discipline** — green = actionable-complete, amber = needs attention, red = broken.
  Extending amber to the over-budget _state_ (issue 2) is consistent with this, not a new convention.
- **Accessibility fundamentals** — `role="dialog"`/`aria-modal`, `aria-pressed`/`aria-expanded` toggles,
  reduced-motion handling, badge state carried in **text** (glyph + word), not colour alone.
- **The "What is this?" explainer** — collapsible, remembered, default-open. A genuinely good
  onboarding touch; build on it (issue 10).
- **Deep-link + anchor machinery** (`repoAnchorId`, `focusRepo`) already exists — the triage band
  (issue 1) and floated sort (issue 3) are cheap because the scroll-to plumbing is in place.
- **Health banners** for stalled distiller/optimizer — good fail-visible behaviour.

---

## Suggested implementation order

A pragmatic sequencing — each step is independently shippable and most are additive:

1. **Sticky headers + group container** (issue 6) — pure CSS, immediate clarity win, zero data changes.
2. **Over-budget as a visible state** (issue 2) — small derived flag + meter restyle.
3. **Float over-budget/flagged repos up** (issue 3) — sort key in `mergeRepoGroups`.
4. **Triage summary band** (issue 1) — reuses existing anchor/scroll plumbing.
5. **Surface dropped rules + per-rule cost cue** (issues 4, 11).
6. **Non-destructive budget remedy + confirm** (issue 5) — needs a data/model decision (park vs delete),
   so it's last and warrants its own design note.

Items 1–4 alone resolve both commissioned problems. Item 5 is the one that touches the data model and
should be specced separately.
