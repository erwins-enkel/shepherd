# Mobile control-key bar — design

**Date:** 2026-05-30
**Status:** approved, pre-implementation

## Problem

Mobile soft keyboards can't send control characters — arrow keys, `Ctrl+C`, line
nav — so steering a live `claude` pane from a phone is crippled. Termux solves
this with an "extra keys" row above the keyboard. Shepherd needs the same.

## Constraint fit (ToS)

No new capability: terminal input already flows to the PTY as raw bytes via
`term.onData((d) => conn.send(d))` (`ui/src/lib/components/Viewport.svelte`).
This feature only adds buttons that call the same `conn.send()` with fixed
escape sequences. Still pure observe-and-steer keystroke injection. No backend
change.

## Approach (decided)

Pure fixed-button palette — every button sends one hardcoded byte sequence. No
modifier state machine, no armed/sticky CTRL, no xterm keyboard hooks. Mobile
only.

Rejected during brainstorming:
- Sticky/Termux modifier that intercepts physical-keyboard keystrokes — too
  complex (requires hooking xterm keydown).
- Armed CTRL + a–z letter strip for arbitrary `Ctrl+<letter>` — unneeded
  surface; the curated combos cover real usage.
- Desktop visibility — desktop has a real keyboard.

## Components

New: `ui/src/lib/components/ControlBar.svelte`
- Props: `onkey: (seq: string) => void`.
- Owns only the key table + layout. No knowledge of the WebSocket/PTY.
- Renders a single horizontal, horizontally-scrollable row of buttons.

Changed: `ui/src/lib/components/Viewport.svelte`
- Lift the `conn` reference from inside the terminal `$effect` to component
  scope: `let conn = $state<PtyConn | undefined>()` (assigned where
  `connectPty(...)` is currently called; cleared in the effect teardown).
- Render `<ControlBar onkey={(seq) => conn?.send(seq)} />` only when
  `mobile === true` and `tab === "term"`, positioned between `.vp-body` and
  `.vp-foot`.

## Key set + sequences

| Button | Sends        | Use                |
| ------ | ------------ | ------------------ |
| `←`    | `\x1b[D`     | cursor left        |
| `→`    | `\x1b[C`     | cursor right       |
| `↑`    | `\x1b[A`     | history / menu up  |
| `↓`    | `\x1b[B`     | history / menu dn  |
| `^A`   | `\x01`       | start of line      |
| `^E`   | `\x05`       | end of line        |
| `^C`   | `\x03`       | interrupt          |
| `^D`   | `\x04`       | EOF                |

Defined as a single ordered `const KEYS: { label: string; seq: string }[]` so
the table is the one source of truth and is unit-testable. More keys
(`Esc`, `Tab`, `⇧Tab`, `^R`, `^L`) can be appended later without structural
change.

### Arrow-key form note

Arrows use CSI form (`\x1b[A` …). If Claude Code's Ink TUI is running in
application-cursor-key mode (DECCKM) it would expect SS3 form (`\x1bOA` …).
CSI is the conventional, safe default for Ink-based apps. Verify against a live
session during implementation; switch to SS3 only if arrows misbehave.

## Interaction / styling

- Buttons match the existing `.tab-btn` visual language; reuse tokens
  (`--color-line`, `--color-ink`, `--color-inset`, `--font-mono`).
- Touch target ≥ 36px tall.
- Row uses `overflow-x: auto; white-space: nowrap` (no wrap) so it occupies a
  single fixed-height row and never steals vertical space as keys are added.
- Buttons fire on `onpointerdown` with `event.preventDefault()` so a tap never
  blurs the terminal or dismisses the soft keyboard, and input feels instant.
- `:active` flash for tap feedback.
- Bar is `aria-label`'d; each button has an accessible label
  (e.g. "Ctrl C", "Arrow up").

## Testing

- Unit test (`ControlBar` key table): assert every entry's `seq` equals its
  expected byte string — guards against silent drift. Pure data; no DOM needed.
- Layout/touch behavior is visual-only, verified manually on a phone.

## Out of scope (later)

- Additional keys (`Esc`, `Tab`, `⇧Tab`, `^R`, `^L`, `^Z`).
- Sticky modifiers / arbitrary `Ctrl+<letter>`.
- User-configurable / reorderable key sets.
- Desktop placement.
