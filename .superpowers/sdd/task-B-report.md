# Task B Report — Wire IssueFilterPopover + consolidate coachmarks + docs

## Commit

`16969892` feat(ui): wire IssueFilterPopover into IssuesPanel + PromptSources, consolidate coachmarks + docs

## Files changed

- `ui/src/lib/components/IssuesPanel.svelte` — replaced 3 `.filter-chip` buttons with `<IssueFilterPopover showMine={viewer != null} coachTargets />`, removed `coachTarget` import, removed `.filter-chip` CSS block
- `ui/src/lib/components/PromptSources.svelte` — imported `IssueFilterPopover`, replaced 3 chip buttons with `<IssueFilterPopover showMine={viewer != null} />`, removed `.filter-chip` CSS block (message-call imports for `issues_filter_*_label/title` also dropped)
- `ui/src/lib/feature-announcements.ts` — added `issue-filters-menu` entry; removed `targetId` from `issues-filter-mine`, `issues-filter-active`, `hide-sub-issues-default` entries; updated their code comments to reflect chips/targetId removed and filters now live in Filters menu
- `ui/messages/en.json` — added `feat_issue_filters_menu_title`/`feat_issue_filters_menu_body`; revised `feat_issues_filter_mine_body`, `feat_issues_filter_active_body`, `feat_issues_filter_subissues_body` to reference Filters menu
- `ui/messages/de.json` — same keys added and revised in German (faithful translations); note: DE file used Unicode typographic quotes as German quotation marks inside values, which required a Python fix to restore straight-ASCII delimiters that the Edit tool inadvertently replaced with curly quotes
- `ui/src/routes/design-system/+page.svelte` — added `IssueFilterPopover` import; added "Filter popover" recipe section with when/when-not note and live `<IssueFilterPopover showMine={true} />` demo
- `ui/src/lib/components/IssuesPanel.browser.test.ts` — updated "mine & unassigned filter" suite: helper functions changed from `mineChip()`/`activeChip()` (.filter-chip element queries) to `openPopover()` (click trigger button) + `checkboxByLabel(label)` (find checkbox in `[popover]` by row label text); all existing assertions preserved
- `ui/src/lib/components/PromptSources.browser.test.ts` — replaced "Issues tab: 'mine & unassigned' chip bar covers the rows behind it" with a new test: Filters trigger renders in `.ps-filter-bar`, opening shows checkboxes, toggling `hide-in-progress` drops the shepherd:active issue from the visible list; added `issuesFilter` import for state reset; preserved Commands tab sticky-covers test unchanged

## Announcement / i18n edits

### New keys (EN)
- `feat_issue_filters_menu_title`: "Issue filters grouped into a menu"
- `feat_issue_filters_menu_body`: "The Backlog and New Task issue lists now gather their filters — mine & unassigned, hide in progress, hide sub-issues — into a single Filters menu with an active-count badge, instead of a row of chips."

### New keys (DE)
- `feat_issue_filters_menu_title`: "Issue-Filter in einem Menü gebündelt"
- `feat_issue_filters_menu_body`: "Die Issue-Listen im Backlog und in „Neue Aufgabe" bündeln ihre Filter — meine & nicht zugewiesen, in Arbeit ausblenden, Unteraufgaben ausblenden — jetzt in einem einzigen Filters-Menü mit Aktivzähler-Badge, statt als Chip-Reihe."

### Revised bodies (EN → DE mirrors change faithfully)
- `feat_issues_filter_mine_body`: "Use the 'mine & unassigned' toggle to flip it off" → "Open the Filters menu and turn off 'mine & unassigned'"
- `feat_issues_filter_active_body`: "now offer a 'hide in progress' filter" → "now offer a 'hide in progress' filter in the Filters menu"
- `feat_issues_filter_subissues_body`: "Use the 'hide sub-issues' toggle to show them" → "Open the Filters menu and turn off 'hide sub-issues' to show them"

## Test updates

### IssuesPanel.browser.test.ts
Old: `mineChip()` / `activeChip()` — queried `.filter-chip` elements directly by label text
New: `openPopover()` clicks the trigger button in `.filter-bar`; `checkboxByLabel(label)` finds `input[type=checkbox]` inside `[popover]` whose closest `label` contains the text. Assertions about which issues are shown/hidden are unchanged. The no-click sub-issue default-ON test was untouched.

### PromptSources.browser.test.ts
Old: "Issues tab: 'mine & unassigned' chip bar covers the rows behind it" — tested sticky cover geometry (`assertStickyCovers()`)
New: "Issues tab: Filters trigger renders, opening it shows checkboxes, toggling hides in-progress issues" — seeds 1 active + 1 plain issue, confirms trigger button exists in `.ps-filter-bar`, opens popover, finds `hide in progress` checkbox by `m.issues_filter_active_label()`, toggles it, asserts the shepherd:active issue disappears. Resets `issuesFilter.setActive(false)` before and after.

## bun run check

```
1781979019205 COMPLETED 3025 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

## bun run check:i18n

```
✓ i18n: 2 locales in parity (1697 keys each)
```

## bun run test

```
 Test Files  127 passed (127)
      Tests  1800 passed (1800)
   Start at  20:10:29
   Duration  21.88s
```

## Final-review fix wave

### Fix 1 — focus-steal on mount (`IssueFilterPopover.svelte`)

Added `let wasOpen = false` (non-reactive plain var) alongside the existing `$effect` for focus management. The effect now only calls `btnEl?.focus()` when `wasOpen` is already true (genuine open→closed transition). On initial mount `wasOpen` is false and `open` is false → neither branch fires → no focus movement. When `open` becomes true, `wasOpen` is flipped to true; when `open` later becomes false and `wasOpen` is already true the trigger gets focus as before.

### Fix 2 — focus regression tests (`IssueFilterPopover.browser.test.ts`)

Added `localStorage.clear()` to `afterEach` for store isolation.

Added two new tests:
- `"mounting does NOT steal focus from a pre-focused element"` — creates an `<input>`, focuses it, renders the popover, waits 50ms (covers any `setTimeout(0)`), asserts `document.activeElement` is still the input. Fails against the pre-fix code because `btnEl?.focus()` fired unconditionally on mount.
- `"opening then closing the popover restores focus to the trigger button"` — opens via click, waits for focus effect + dismiss listeners, closes via Escape, asserts `document.activeElement === triggerBtn()`.

### Fix 3 — a11y aria-controls (`IssueFilterPopover.svelte`)

Added `const popoverId = $props.id()` (SSR-stable per-instance id, same pattern as InfoTip). Added `id={popoverId}` to the `<div popover>` panel and `aria-controls={popoverId}` to the trigger `<button>`.

### Fix 4 — stale describe name (`PromptSources.browser.test.ts`)

Renamed `describe("PromptSources sticky filter bar covers scrolling rows", …)` → `describe("PromptSources filter bar (popover + sticky coverage)", …)`. No assertion changes.

### Commands run and output

```
bun run check
→ 1781979598630 COMPLETED 3025 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS

bun run check:i18n
→ ✓ i18n: 2 locales in parity (1697 keys each)

bun run test
→ Test Files  127 passed (127)
→ Tests  1802 passed (1802)
→ Start at  20:20:07
→ Duration  22.29s

New focus regression tests (both green):
✓ IssueFilterPopover > mounting does NOT steal focus from a pre-focused element  52ms
✓ IssueFilterPopover > opening then closing the popover restores focus to the trigger button  105ms
```
