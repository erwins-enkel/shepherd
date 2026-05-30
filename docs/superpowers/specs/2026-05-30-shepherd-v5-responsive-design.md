# Shepherd v5 — Responsive / Mobile (Design)

**Date:** 2026-05-30
**Feature:** v5 in `TODO.md` — make the Shepherd HUD work on mobile.
**Branch:** `feat/shepherd-v5-responsive`
**Scope:** Pure UI/layout. No backend, API, or data-flow changes.

## Problem

The HUD is desktop-only. `ui/src/routes/+page.svelte` uses a fixed
`max-width:1180px` shell with a 2-column grid (`1fr 1.15fr`) — herd list and
selected-unit viewport side by side. On a phone both can't fit; the layout is
unusable.

## Decisions (locked)

- **Breakpoint:** `768px`. `>768px` keeps today's desktop 2-col grid unchanged.
  `≤768px` is mobile (phones + small tablets portrait).
- **Mobile nav model:** drill-down + back. Herd list is the home screen; tap a
  unit → full-screen detail (the existing Viewport with its Terminal/To-Do/Issues
  tabs); a `‹ Herd` button returns to the list.
- **New Task on mobile:** full-screen sheet (slides up). Centered modal on desktop.
- **ActionBar on mobile:** only `+ New Task` (full-width), on the list screen
  only. Hide the non-functional `All`/`Focus` placeholders and the tech hint.
- **Mobile detail header:** show `‹ Herd` + designation + status badge + the
  Terminal/To-Do/Issues tab row. Hide branch, model hint, and elapsed timer to
  save vertical space.
- **Terminal font on mobile:** 13px (desktop stays 12.5px).
- **Don't regress desktop. Keep the HUD aesthetic** (tokens, brackets, scanline).

## Architecture

`+page.svelte` becomes the navigation controller. No new routes — a single SPA
page with reactive layout state.

### Navigation state (`+page.svelte`)

- `isMobile` — reactive `MediaQuery('(max-width: 768px)')` from
  `svelte/reactivity`. Single source of truth for layout mode.
- `mobileScreen: 'list' | 'detail'` — `$state`, initial `'list'`.
- Selecting a unit:
  - **Mobile:** set `selectedId` and `mobileScreen = 'detail'`.
  - **Desktop:** set `selectedId` only (both columns always visible).
- Back (mobile only): set `mobileScreen = 'list'` (keep `selectedId` so returning
  to detail shows the same unit).
- No auto-jump to detail on initial load. On mobile the app opens on the list.
  (Desktop keeps auto-selecting the first unit for the right column.)

### Render logic

- **Desktop (`!isMobile`):** unchanged — `.grid` with `Herd` + `Viewport`/empty.
- **Mobile (`isMobile`):**
  - `mobileScreen === 'list'` → render `Herd` (full-width) + `ActionBar`
    (`+ New Task` only).
  - `mobileScreen === 'detail'` → render `Viewport` (full-width) with
    `onback` wired; no `ActionBar` (the viewport footer "type to steer" stands in).
  - If `selectedId` resolves to no session while on detail, fall back to `'list'`.

### Responsive shell

- Desktop: `max-width:1180px; margin:0 auto; padding:22px` (as today).
- Mobile: full width, `padding:10px`, height `100dvh` (handles mobile browser
  chrome better than `100vh`).

## Component changes

| Component                                 | Change                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `+page.svelte`                            | Nav state (`isMobile`, `mobileScreen`); conditional render; responsive shell; pass `onback` to `Viewport` on mobile.                                                                                                                                                                                                                                         |
| `Viewport.svelte`                         | New optional `onback?: () => void` prop. When set, header renders `‹ Herd` and hides branch/model/elapsed. Header wraps to 2 rows ≤768px (row 1: back + desig + status; row 2: tab group). Tap-to-focus terminal so the mobile on-screen keyboard opens. Terminal `fontSize` 13 on mobile, 12.5 desktop. Verify FitAddon refits when detail becomes visible. |
| `TopBar.svelte`                           | Compact ≤768px: hide "Mission Control" label + a separator; tighten gaps; condensed tallies (`7 · ●3 · 2 · !1`); keep logo + clock.                                                                                                                                                                                                                          |
| `ActionBar.svelte`                        | ≤768px: show only `+ New Task` (full-width); hide `All`/`Focus`/hint.                                                                                                                                                                                                                                                                                        |
| `Herd.svelte`                             | Full-width on mobile; list scrolls within the screen.                                                                                                                                                                                                                                                                                                        |
| `UnitRow.svelte`                          | `min-height: 44px` tap target ≤768px; comfortable touch padding.                                                                                                                                                                                                                                                                                             |
| `NewTask.svelte`                          | ≤768px: full-screen sheet (inset 0, slide-up) instead of centered modal; larger field/tap sizing.                                                                                                                                                                                                                                                            |
| `RepoSelect.svelte`                       | ≤768px: larger control + dropdown option tap targets (≥40px rows).                                                                                                                                                                                                                                                                                           |
| `TodoPanel.svelte` / `IssuesPanel.svelte` | Confirm scroll + ≥40px interactive row/tap sizing inside full-screen detail.                                                                                                                                                                                                                                                                                 |
| `app.css`                                 | Touch niceties: `-webkit-tap-highlight-color: transparent`, `touch-action` where appropriate; adopt `100dvh` in shell. (768px literal in component `@media` — CSS can't read a `@theme` custom property inside a media query.)                                                                                                                               |

## Terminal at mobile width (key risk)

- FitAddon + ResizeObserver already exist in `Viewport.svelte`. When the detail
  screen mounts/becomes visible the mount goes from hidden (or absent) to sized;
  the ResizeObserver should fire and refit. Verify; if it doesn't refit reliably,
  call `fit()` + `conn.resize()` once after the detail becomes visible.
- xterm `xterm-viewport` is currently `overflow:hidden !important`; keep — scroll
  is driven by the terminal app, not native scroll.
- Tap-to-focus: a tap on the terminal must focus it to raise the soft keyboard.

## Out of scope (YAGNI)

- Making `All`/`Focus` buttons functional (still placeholders).
- A bottom-tab persistent shell or hybrid nav (rejected in brainstorming).
- PWA install/manifest, offline, push.
- Landscape-specific phone layouts beyond what the single-column flow gives.

## Testing / acceptance

- `cd ui && bun run check && bun run test && bun run build` green; root
  `bun run test && bun run lint && bunx tsc --noEmit` green.
- **Acceptance gate — `agent-browser` screenshots, actually viewed:**
  - **390×844** (iPhone): list, detail (terminal), New Task sheet, To-Do, Issues.
  - **768** (tablet edge): confirm the breakpoint flips cleanly.
  - **~1280** (desktop): regression — layout unchanged.
- **e2e visual smoke:** boot on a temp port/DB with `SHEPHERD_REPO_ROOT=/tmp/...`,
  `herdr agent start <name> --cwd <dir> --no-focus -- bash`, insert a session row
  via `SessionStore`, drive `agent-browser` at 390×844 to verify the terminal
  renders and fits. Teardown after. (Pattern: V2-T9 / V3-T4 / V4-T5.)

## Notes / gotchas (carried from handoff)

- `.svelte` files are NOT in lint-staged globs — run prettier on them before commit.
- `svelte-check` warning `state_referenced_locally` for one-time prop→state seeds:
  silence with `// svelte-ignore state_referenced_locally` (already used in
  `NewTask.svelte`).
- Automated background security review fires on each commit — expect findings;
  address or justify. (No new attack surface expected here — UI-only.)
- Restart the local instance after UI changes: rebuild `ui/` (served statically),
  kill `:7330`, relaunch with `SHEPHERD_ALLOWED_HOSTS` set.
