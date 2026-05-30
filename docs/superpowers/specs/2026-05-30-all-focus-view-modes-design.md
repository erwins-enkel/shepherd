# All / Focus view modes

## Problem

The `All ▦` and `Focus ⌖` buttons in `ActionBar.svelte` are decorative — no
behavior. Wire them to real view modes for the desktop layout, per PRD F4
("All view = grid of all concurrent sessions").

## Behavior

Two desktop view modes (default `focus`):

- **Focus** — current layout: Herd list (left) + single selected `Viewport`
  (right). Unchanged.
- **All** — full-width responsive grid of every session's _live, read-only_
  terminal. Herd list + single Viewport hidden.

Buttons act as a toggle; the active mode's button is highlighted.

Tiles are **read-only live monitors**: stream PTY output, take no keyboard
input. Clicking a tile selects that unit **and switches to Focus** (grid =
overview, click = drill in).

Mobile/touch-mobile: unaffected. Buttons stay desktop-only (`!mobile`); mode is
effectively always Focus.

## Architecture

State lives in `+page.svelte`:

```ts
let viewMode = $state<"focus" | "all">("focus");
```

Desktop branch (`.grid`):

- `viewMode === "focus"` → existing `Herd` + `Viewport` grid (no change).
- `viewMode === "all"` → new `HerdGrid` full-width.

`selectUnit` already exists; tile click = `selectUnit(id)` + `viewMode = "focus"`.

### Components

**`ActionBar.svelte`** (edit) — add props `mode: "focus" | "all"` and
`onmode: (m) => void`. The two buttons set mode and get `.active` styling when
current. `+ New Task` unchanged.

**`HerdGrid.svelte`** (new) — full-width CSS grid
(`repeat(auto-fit, minmax(280px, 1fr))`), one `UnitTile` per session. Empty →
`NO UNITS — + New Task`. Props: `sessions`, `selectedId`, `nowMs`, `onselect`.

**`UnitTile.svelte`** (new) — lightweight read-only terminal. Mirrors the
`Viewport` xterm setup but stripped:

- xterm with `disableStdin: true`; `connectPty` for output only — **do not**
  wire `term.onData → send`.
- `FitAddon` + `ResizeObserver` (same as Viewport).
- Small header: `desig` · `name`, status badge colored via `STATUS_COLOR`.
- Status-colored border; `.selected` highlight; `onclick → onselect(id)`.
- Full teardown in effect cleanup (`ro.disconnect()`, `conn.close()`,
  `term.dispose()`) — same discipline as Viewport.

## Key constraint: one attach per session

`pty-attach.mjs` runs `herdr agent attach <id> --takeover` — newest client wins.
Safe here because the two views are **mutually exclusive**: a session is live in
at most one place. All mode attaches every session once (read-only); clicking a
tile unmounts the grid (closing those attaches) and Focus re-attaches the one
selected with takeover. Switching back re-attaches the grid.

## Edge cases

- Empty herd in All mode → centered `NO UNITS` message.
- Selected unit disappears: existing `selected` derivation already yields the
  empty state in Focus; grid simply drops the tile.
- Many sessions → many xterm instances + node subprocesses. Acceptable for a
  single-operator mission-control tool; note as a known limit, no pooling now.

## Testing

Repo convention: UI tests are pure-logic only (`ui/test/{api,format,store}`) —
no Svelte component/DOM tests exist. View-mode state is trivial; the grid is
inherently visual. Verify by:

- `cd ui && bun run check` (svelte-check passes, no type errors).
- `bun run dev` + manual: toggle All/Focus, confirm grid renders live output,
  tile click drills into Focus, empty state shows.

No new pure helpers expected, so no new unit test file.

## Out of scope

- Interactive/typeable tiles (tmux-style steering).
- Mobile grid view.
- Herd-list filtering.
- Persisting view-mode across reloads.
