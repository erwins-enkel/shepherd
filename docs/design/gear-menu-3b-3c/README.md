# Handoff: Gear Menu Redesign (desktop popover + mobile bottom sheet)

## Overview

Redesign of Shepherd's top-right gear (settings) dropdown menu. Replaces the current rounded, emoji-based menu with a system-conformant "telemetry menu": square popover, monochrome instrument glyphs, grouped rows with uppercase labels, live readouts (working count, token-usage gauge), a dedicated **Plugins** group, and a demoted **Support** group. Two surfaces:

- **3b — desktop popover**, anchored under the gear button in the top bar.
- **3c — mobile bottom sheet**, the same menu as a rising sheet with 44px+ touch targets.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**. The task is to recreate these designs in the Shepherd codebase (SvelteKit — `ui/src/lib/components/top-bar/`), using its existing token CSS (`ui/src/app.css`), component patterns, and conventions.

## Fidelity

**High-fidelity.** Colors, typography, spacing, and states are final and use Shepherd's real design tokens. Recreate pixel-perfectly; wherever a value below is given as `var(--x)`, use the token already defined in `app.css` rather than the hex fallback.

## Design Tokens Used (dark theme)

- Surfaces: `--bg #0a0d0c`, `--inset #070a09`, `--head #0a0f0d`, `--panel #0f1413`, `--sel #18211e`, `--hover` (tonal hover lift)
- Hairlines: `--line #1b2422`, `--line-bright #2c3835`
- Ink: `--faint #4a5752`, `--muted #7c8c86`, `--ink #c4d0cb`, `--ink-bright #eef4f0`
- Status: `--amber #e8a13a` (action/working), `--green #5ad19a` (healthy/live)
- Shadows (earned, invocation-only): `--shadow-popover: 0 6px 24px rgba(0,0,0,0.45)`, `--shadow-sheet: 0 -8px 40px rgba(0,0,0,0.5)`
- Font: Berkeley Mono, fallback JetBrains Mono / ui-monospace. All updating numerals use `font-variant-numeric: tabular-nums`.

## 3b — Desktop popover

**Container:** width 300px; `border: 1px solid var(--line-bright)`; background `var(--panel)`; `box-shadow: var(--shadow-popover)`; **border-radius 0** (square — popovers earn a shadow, never a radius). Anchored below the gear button, right-aligned, 6px gap.

**Structure, top to bottom:**

1. **Identity header** — background `var(--head)`, `border-bottom: 1px solid var(--line)`, padding 8px 12px. Left: `SHEPHERD` 10px uppercase, letter-spacing 0.2em, `--muted`. Right: `v0.9.4 · ● live` 10px, version `--muted`, `● live` in `--green`. (Wire version + connection state to real values.)
2. **Halt herd** (hero action row) — padding 9px 12px, 13px, `--ink-bright`, border-bottom hairline. Left glyph `■` in `--amber` (16px-wide centered column). Right: chip `1 WORKING` — 9px uppercase, letter-spacing 0.1em, `--amber` text, `border: 1px solid color-mix(in srgb, var(--amber) 62%, var(--line))`, padding 1px 6px, radius 2px. Count = live number of WORKING units; hide the chip at 0.
3. **Token usage** (live gauge block) — padding 9px 12px, border-bottom hairline, whole block clickable → usage view. Label row: `TOKEN USAGE` 10px uppercase 0.18em `--faint`; right `all ▾` 10px `--faint`. Gauge row: `CX·WK` 10px `--muted` + 4px-tall bar (`--inset` bg, `--line-bright` border, fill `--green` at % free) + `91% free` tabular.
4. **Workspace rows** (unlabeled group, 4px vertical padding) — rows: `✦ Learnings` (right: count `71`, 10px `--muted` tabular), `⚙ Settings` (right: `⌘,` 10px `--faint`), `↗ Documentation`. Row spec: flex, gap 10px, padding 7px 12px, 13px `--ink`; glyph in a 16px centered column, `--muted`.
5. **Plugins group** — top hairline, 4px padding. Group label row: `PLUGINS · 1` 10px uppercase 0.2em `--faint`; right `manage ▾` 10px `--faint` (opens plugin management). One row per installed plugin: `⌁ Voice input`, right hint `Whisper` 10px `--faint`. This group is dynamic — it lists installed plugins; label count updates.
6. **Support group** (demoted) — top hairline, background `var(--head)`, padding 4px 0 6px. Label `SUPPORT` 10px uppercase `--faint`, then rows (padding 6px 12px): `⚠ Report a bug`, `✧ Request a feature`, `↵ Send feedback`.

**States:** row hover = background `var(--hover)` only (flat tonal lift, no motion, no rounded highlight). No focus glow rings; keyboard focus brightens the hairline / uses the same tonal lift.

## 3c — Mobile bottom sheet

Same content and order as 3b, as a rising sheet:

- **Sheet:** full-width, `border-top: 1px solid var(--line-bright)`, background `var(--panel)`, `border-radius: 12px 12px 0 0` (12px is reserved for rising sheets), `box-shadow: var(--shadow-sheet)`. Rise animation ~0.18s, easing `cubic-bezier(0.2, 0.8, 0.3, 1)`. Grab handle: 36×4px, radius 2px, `--line-bright`, centered.
- **Identity header:** 11px sizes, padding 6px 20px 10px, hairline below.
- **Halt herd:** min-height 52px, 16px text, amber `■` glyph + `1 WORKING` chip (11px).
- **Token usage:** padding 12px 20px, 11px labels, 5px-tall gauge.
- **Workspace / Plugins rows:** min-height 48px, 16px text, 20px glyph column, horizontal padding 20px.
- **Support rows:** min-height 44px, 15px text, on `var(--head)` ground.
- All touch targets ≥ 44px. Dismiss: swipe down / tap scrim.

## Interactions & Behavior

- Gear button toggles the popover (desktop) / sheet (mobile). Active gear button: background `var(--sel)`, border `var(--line-bright)`.
- Dismiss on outside click / Esc (desktop); scrim tap or swipe-down (mobile).
- Halt herd should confirm before stopping working units (count in chip tells the operator what's at stake).
- Token-usage gauge mirrors the top-bar gauge (`CX·WK` = Codex weekly window); `all ▾` expands per-window breakdown (e.g. "Claude Code 5h 84% · weekly 69%").
- Keyboard: arrow-key row navigation; `⌘,` opens Settings globally.

## State Management

- `workingCount` (live) → Halt-herd chip text + visibility.
- `usage` (per window: label, % free) → gauge fill + text.
- `learningsCount` → Learnings row readout.
- `plugins[]` (installed plugins: name, glyph, hint, action) → Plugins group rows + `· n` count.
- `connected` + `version` → header readout (`● live` green when socket up; consider `--red` + "offline" when down).
- `menuOpen` boolean; mobile vs desktop surface chosen by viewport.

## Glyph legend (monochrome text glyphs — no icon library, no emoji)

`■` halt · `⚙` settings · `✦` learnings · `↗` external link · `⌁` voice/steer · `⚠` bug · `✧` feature · `↵` send/feedback · `●` status dot

## Assets

None. All marks are unicode glyphs inheriting ink colors.

## Files

- `reference.html` — self-contained, opens in any browser; left: 3b desktop popover, right: 3c mobile sheet in a 390px frame. Tokens are inlined at the top so it renders standalone; in the codebase use the existing `app.css` tokens instead.
