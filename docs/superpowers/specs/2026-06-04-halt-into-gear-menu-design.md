# Halt e-stop → gear menu

**Date:** 2026-06-04
**Status:** Approved (design), pending implementation plan

## Problem

The "halt the herd" emergency stop currently renders inline in the top bar's right
cluster (`TopBar.svelte`), appearing only while `working > 0`. Its optics never
settled — it competes with the status badges and the arm→confirm pill reflows the
row. We move it off the bar and into a small menu hung off the settings gear.

## Decision summary

- Placement: **gear → small popup menu** (not inside the Settings modal).
- The gear **always** opens the menu (even when `working = 0`, where the menu holds
  only "Settings…"). No stateful/hybrid behavior.
- Discovery: **reword** the existing `halt-the-herd` announcement (no new entry, no
  coachmark).
- Commit label: **`fix(ui)`** (does not arm the feature-catalog gate).

## Behavior

Clicking `⚙` opens a menu anchored below-right of the gear:

```
┌────────────────────┐
│ ⬡ Halt 3 agents  ⚠ │  ← only when working>0; destructive; arm→confirm in-row
├────────────────────┤
│ Settings…          │  ← opens the existing Settings modal (onsettings)
└────────────────────┘
```

When `working = 0` the menu shows only the "Settings…" row.

### Halt row (arm → confirm)

Reuses today's two-step state machine, relocated into the menu row:

- First activation **arms**: row goes red, label switches to `halt_arm` (`Halt {count}?`).
- Second activation **commits**: calls `onhalt()`, then closes the menu.
- Disarms on: 4s timeout, Escape, outside-click, menu-close, or `working → 0`.

The octagon glyph (`M8 2 H16 L22 8 V16 L16 22 H8 L2 16 V8 Z`) moves from the deleted
inline button into this row.

### Settings row

Calls `onsettings()` and closes the menu. Reuses `settings_title` for the label.

### Gear pip

While `working > 0` the gear shows a small **red** pip (mirrors the existing green
`.gear-dot` herdr pattern) — the only at-rest cue that something is haltable. On
mobile, where the gear may also carry the green herdr-update dot, the red halt pip
takes the corner; the green offsets so both stay legible.

## Accessibility (menu-button pattern)

House rule requires complete ARIA for new interactive widgets.

- Gear button: `aria-haspopup="menu"`, `aria-expanded={menuOpen}`. Conditional
  `aria-label`: `topbar_menu_aria` ("Open menu") when `working > 0`, else
  `topbar_settings_aria` ("settings").
- Menu container: `role="menu"`, `aria-label` = `topbar_menu_label`. Items
  `role="menuitem"`.
- Keyboard: open → focus first item; ↑/↓ cycle items; Escape closes and returns
  focus to the gear; outside-click closes.

## Internationalization (EN + DE both)

New keys (snake_case, component-prefixed):

- `halt_menu_item` — `Halt herd · {count}` (resting label of the halt row;
  count-agnostic `· {count}` phrasing so it stays plural-safe at count = 1).
- `topbar_menu_aria` — `Open menu` (gear aria-label when haltable).
- `topbar_menu_label` — menu `role="menu"` label.

Reused: `settings_title`, `halt_arm`, `halt_all_aria`, `halt_arm_aria`.

Reworded (EN + DE): `feat_halt_body` — drop "in the top bar"; describe the gear-menu
home. `feat_halt_title` unchanged.

## Discovery

No new `feature-announcements.ts` entry and no coachmark. The existing
`halt-the-herd` announcement's body (`feat_halt_body`) is reworded so it stops
pointing at the old location.

## Files touched

- `ui/src/lib/components/TopBar.svelte` — delete inline `.halt` button block + its
  CSS (incl. the two `.hud.mobile .halt` / responsive blocks); add menu markup,
  menu open/close + focus state, red gear pip, relocated arm→confirm logic.
- `ui/messages/en.json`, `ui/messages/de.json` — add 3 keys; reword `feat_halt_body`.
- (No change to `feature-announcements.ts` structure — only the reworded message it
  references.)

## Untouched

`haltHerd()` / `onhalt` wiring and the halt POST in `+page.svelte`; all halt toasts
(`halt_confirm` / `halt_done` / `halt_failed`).

## Test / verify

- `cd ui && bun run check` (svelte-check + tsc), `bun run check:i18n` (catalog
  parity), `bun run test` (vitest), `bun run lint`.
- Manual: menu opens/closes via mouse + keyboard; arm→confirm fires `onhalt`; pip
  shows only while working; idle menu shows just Settings; Settings row opens modal.
