# Ready toggle visible on desktop — design

**Date:** 2026-06-03
**Branch:** `shepherd/ready-toggle-visible-desktop`

## Problem

The per-session **Ready** toggle (mark a session ready-to-merge) is not visible on
desktop, but works on mobile and on unfolded foldables.

### Root cause

PR #188 (`feat(viewport): group desktop git rail behind a PR disclosure`) moved the
full desktop git rail — PR / CI / merge / critic / **ready** / verdict — behind a
"Git actions" disclosure toggle to declutter the header.

The rail (a `<GitRail>`) is mounted by `Viewport.svelte` only when
`{#if compact || gitOpen}` (`Viewport.svelte:1112`), where:

- `compact = mobile || touch` (`Viewport.svelte:142`)
- `gitOpen` is the desktop disclosure state, default `false` (`Viewport.svelte:95`)

Consequences:

- **Mobile / unfolded fold** → `compact = true` → the rail (and its Ready toggle) is
  always mounted and visible. The Ready toggle works.
- **Desktop** → `compact = false`, `gitOpen` defaults `false` → the rail is hidden
  until the operator clicks "Git actions". The Ready toggle is effectively invisible.

This is not clipped CSS or a responsive `hidden` class — it is the disclosure burying
the Ready toggle on desktop while mobile shows the rail unconditionally.

The Ready toggle inside `GitRail.svelte:323` is gated by:

```svelte
{#if (git.state === "open" || ready) && status !== "running" && status !== "blocked"}
```

## Chosen approach — Approach A: graduate the Ready toggle to the desktop primary row

Render the Ready toggle directly in the always-visible desktop primary header row,
beside the "Git actions" disclosure. The heavier git actions (PR create, CI, merge,
critic, verdict) stay behind the disclosure.

This restores mobile parity for the single high-frequency operator control while
preserving #188's declutter intent for the rest of the rail.

Rejected alternatives:

- **B — always show the full rail on desktop:** re-clutters the header; effectively
  reverts #188.
- **C — auto-open the disclosure when ready-relevant:** pops a full extra header row and
  the toggle stays indirect.

## Data flow (already in place)

- `Viewport` receives `git` as a prop, fed from `store.git[selected.id]` in both
  desktop and mobile call sites (`+page.svelte:571,624`). So `git?.state` reliably
  reflects PR state on desktop — the desktop gate can mirror `GitRail`'s gate exactly.
- `session.readyToMerge` is the ready flag; `setReadyToMerge(id, ready)`
  (`api.ts:260`) is the toggle action, already used by `GitRail`.
- The Ready toggle's messages (`gitrail_ready`, `gitrail_ready_aria`,
  `gitrail_ready_on_title`, `gitrail_ready_off_title`) exist in both `en.json` and
  `de.json` and are reused as-is.

## Changes

### 1. `ui/src/lib/components/GitRail.svelte`

- Add a `showReady = true` prop (typed `showReady?: boolean`).
- Extend the Ready `{#if}` (line 323) with `&& showReady`, so a parent can suppress the
  rail's own Ready toggle when it renders the toggle elsewhere.

### 2. `ui/src/lib/components/Viewport.svelte`

- Import `setReadyToMerge` from `$lib/api`.
- Add a derived gate, desktop-only, mirroring `GitRail`'s condition:

  ```ts
  const readyVisible = $derived(
    !compact &&
      (git?.state === "open" || session.readyToMerge) &&
      session.status !== "running" &&
      session.status !== "blocked",
  );
  ```

- Inside the existing `{#if !compact}` block (beside `git-toggle`, ~line 1050), render a
  Ready toggle when `readyVisible`:
  - `aria-pressed={session.readyToMerge}`, `aria-label={m.gitrail_ready_aria()}`,
    `title` switching on `gitrail_ready_on_title` / `gitrail_ready_off_title` — state
    folded into label/title.
  - `onclick={() => setReadyToMerge(session.id, !session.readyToMerge)}`.
  - Label `{session.readyToMerge ? "✓ " : ""}{m.gitrail_ready()}`.
  - Class `.ready-toggle` styled consistently with `.git-toggle`, with a green "on"
    treatment when `session.readyToMerge` (matches `GitRail`'s `.ready-on` semantics:
    marked-ready = done/green).
- Pass `showReady={compact}` to the disclosure `<GitRail>` (line 1114), so the rail
  renders Ready only on compact layouts — never double-rendering on desktop when the
  disclosure is open.

## i18n

No new keys. Reuses existing `gitrail_ready*` keys, present and matched in `en.json`
and `de.json`. Catalog-parity gate (`bun run check:i18n`) unaffected.

## Verification

- `cd ui && bun install` (fresh worktree), then `bun run check`, lint, `bun run
  check:i18n`.
- Visual check in the running app:
  - **Desktop** (non-touch): Ready toggle visible in the primary header row when the
    session has an open PR or is already ready; not shown while running/blocked.
  - **Desktop, disclosure open**: exactly one Ready toggle (in the header row), none
    inside the rail.
  - **Mobile / unfolded**: unchanged — Ready toggle still in the rail, no duplicate in
    the header.
  - Toggling on desktop flips `session.readyToMerge` and updates the on/off styling +
    title, consistent with the mobile rail toggle.

## Out of scope

- Restructuring the disclosure or moving other rail controls.
- Any change to the server-side ready-to-merge semantics.
