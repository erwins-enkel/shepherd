# Handoff: New Task Modal — Option 2a "Calm Form"

## Overview
Redesign of Shepherd's **New Task** modal. Goals: kill the ~2.6-screen scroll of the current modal, make the prompt the single visual hero, and reorganize run settings so defaults are confirmable at a glance. Everything fits one view; the CTA is always visible.

## About the Design Files
`reference-2a.html` is a **design reference created in HTML** — a static prototype showing intended look and behavior, not production code to copy directly. The task is to **recreate this design in the Shepherd codebase** (SvelteKit, `ui/src/`) using its existing components (`ui/src/lib/components/`), tokens (`ui/src/app.css`), and patterns. Do not ship the reference HTML.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and copy are final and use Shepherd's existing token names (`--panel`, `--inset`, `--line`, `--amber`, …) verbatim. Recreate pixel-perfectly; wire real state/data where the mock shows placeholders.

## Screens / Views

### Desktop modal (880px)
Square-cornered panel (`--panel`, 1px `--line-bright` border, 10px corner registration brackets via ::before/::after, no drop shadow). Three vertical zones:

1. **Header** — `12px 16px 10px` padding, bottom hairline. "NEW TASK" label (11px, uppercase, +0.18em, `--muted`), close ✕ right-aligned.
2. **Body** — CSS grid `1fr 300px`, columns separated by a 1px `--line` hairline.
3. **Footer** — `12px 16px`, top hairline, `--head` background. Left: readiness line. Right: primary CTA.

#### Left column — "describe the work" (`14px 16px` padding, 12px column gap)
- **Context chips row** (NOT labeled form fields — this is the key demotion vs the current modal): repo chip `🐑 shepherd ▾` (12px, `--ink-bright`, 600 weight name, `--panel-2` bg, 1px `--line` border, 2px radius, `4px 10px` padding), the word "from" (11px `--faint`), branch chip `main ▾` (same chip style, `--ink`). Right-aligned keyboard hint "⌥[ ⌥] switch repo" (10px `--faint`). Clicking either chip opens the existing repo/branch pickers.
- **Prompt hero**: label row — "PROMPT" (11px uppercase +0.18em `--muted`) with right-aligned syntax hint "# issue · / command · ⌘V image" (10px `--faint`). The field itself is one bordered object: **1px `--line-bright` border** (brighter than every other field — this is the hero), `--inset` background, 2px radius. Inside: textarea area (min-height 132px, 13px text, placeholder `--faint`, line-height 1.5) and an **in-field toolbar** below a `--line` hairline (`6px 8px` padding, 8px gap): attach button `↥` and dictate button `🎙` (28×28px, 1px `--line` border, 2px radius, `--muted`), attachment chips (11px, `--panel-2` bg, `--line` border, `3px 8px`, removable ✕), right-aligned char counter (10px `--faint`, tabular). Drag-drop and ⌘V land files as chips here.
- **Start from an issue** panel (`--inset` bg, `--line` border, 2px radius): header row (`5px 8px 4px`, bottom hairline) with "START FROM AN ISSUE" (10px uppercase +0.18em `--faint`), open-count "12 open" (10px `--faint`, tabular), "Filters 2 ▾" chip (6px radius — chip radius), and right-aligned Issues/Commands toggle (active: 1px `--amber` border + `--amber` text; inactive: `--muted`, no border). Body: 3 issue rows (12px; number `--faint` tabular, title `--ink` single-line ellipsis, type badge 9px bordered `--red`/teal), hover = `--hover` background. Final row: "↓ 9 more — type # in the prompt to search" (10px `--faint`). Clicking a row seeds the prompt.

#### Right rail — run configuration (300px, `--panel-2` bg, `14px 16px` padding)
Grouped **by decision frequency**, separated by 1px `--line` hairlines with `14px 0 12px` margins. Group labels: 10px, uppercase, +0.2em, `--faint`.

- **MODE** — segmented control (1px `--line` border, 2px radius): Code / Research / Epic. Active segment: `--sel` bg + `--amber` text; inactive: `--muted`. Replaces the current mutually-exclusive "Research task" / "Create EPIC from research" checkboxes.
- **ENGINE** (8px gap):
  - CLI select (13px, `--inset` bg, `--line` border, `8px 10px`): "Codex" + ALPHA badge (10px, `--amber` text, border `color-mix(in srgb, var(--amber) 62%, var(--line))`, `0 4px`, 2px radius).
  - **Capacity line** (only the selected engine): `CX·WK  [gauge]  92% free  all ▾` — 10px `--muted` tabular; gauge is a flexed 4px-high bar (`--inset` bg, `--line-bright` border, `--green` fill at the free %). "all ▾" (10px `--faint`) opens a popover with all engines' gauges (CC·5H 84%, CC·WK 69%, CX·WK 92% + reset times).
  - Model select: "gpt-5.6-terra ▾", with one meta line below (10px `--muted`): "BALANCED (in `--amber`) · $$$ · everyday agentic coding".
  - Effort + Sandbox side-by-side (flex, 8px gap): 10px +0.14em uppercase labels; "Effort" gets a dotted-underline hover definition (title tooltip: "Higher spends more tokens for deeper reasoning; lower is faster and cheaper.") — **no ⓘ icons anywhere**. Selects: 12px, `6px 8px` padding.
  - Alpha caution, one line (10px `--muted`): "⚠ (amber) Alpha: runs unattended, sandbox forced to trusted. details (link, `--blue`)". Replaces the current large amber banner.
- **GUARDS** (10px gap):
  - **Instrument toggles** (not checkboxes, not pills): track 26×14px, 2px radius, `--inset` bg, 1px padding; knob 10×10px, 1px radius. ON: knob `--amber` right-aligned, track border amber-mixed; label suffix "ON" (10px `--amber`, right-aligned). OFF: knob `--slate` left-aligned, `--line-bright` track border; suffix "OFF" (10px `--faint`, tooltip "Repo default: off").
  - Rows: "Plan gate" (ON) and "Autopilot to PR" (OFF) — 12px `--ink-bright` labels with dotted-underline title-tooltip definitions, `white-space: nowrap` on label and status so rows never wrap.

#### Footer
- Left readiness line (11px `--muted`): `✓ (--green) ready · branches shepherd/task-… (--ink, tabular) from main`. Shows validation state — swap ✓/copy when the prompt is empty or repo unresolved.
- Right CTA: "CREATE & RUN" — 1px `--amber` border, `--amber` text, 11px uppercase +0.12em, `9px 18px`, **inset glow** `box-shadow: inset 0 0 18px -10px var(--amber)` (never a solid amber fill or outer shadow), with ⌘↵ kbd chip (10px, `--line-bright` border).

### Mobile sheet (390px, full-height)
- Header (min-height 44px, bottom hairline): combined repo chip "🐑 shepherd · main ▾" (13px) left; 44×44px ✕ right.
- Prompt hero fills remaining height (16px text — prevents iOS zoom), same in-field toolbar with **44×44px** attach/mic buttons and syntax hint.
- Mode segmented control (44px tall segments).
- Engine summary row (single 44px row, `--panel-2`): "ENGINE  Codex · gpt-5.6-terra · gate on (amber) ▾" — opens a bottom sheet (12px radius, `--shadow-sheet`) with the full Engine + Guards groups from desktop.
- Fixed footer (`--head`, top hairline, bottom safe-area padding): readiness line + full-width 44px "CREATE & RUN" CTA.

## Interactions & Behavior
- **Create & Run** enabled when prompt is non-empty OR an issue is seeded; ⌘↵ submits from anywhere in the modal.
- Repo chip: click opens picker; ⌥[ / ⌥] cycle repos, ⌥1–3 recent, ⌥R filter (existing shortcuts, now surfaced as the hint on the context row).
- Issue row click seeds the prompt with the issue reference + title; typing `#` in the prompt opens inline issue search; `/` opens commands.
- Toggles flip on click on the whole row (label + track are one hit target).
- Hover: controls lift to `--hover`, hairlines brighten to `--line-bright`; **no motion**. Focus: field border brightens to `--line-bright`, no outer glow ring. Resting chips never lift.
- Reduced motion: no decorative animation exists in this design; nothing to disable.

## State Management
- `repo`, `baseBranch`, `prompt`, `attachments[]`, `seededIssue?`
- `mode: "code" | "research" | "epic"` (replaces two booleans)
- `cli`, `model`, `effort`, `sandbox`, `planGate: boolean`, `autopilot: boolean` (defaults from repo config; footer echoes repo default in the OFF tooltip)
- `capacity` per engine: `{ freePct, resetsAt }` — poll/subscribe as the current modal does
- Derived: `readiness` (footer line), `branchName` preview (`shepherd/task-…`)

## Design Tokens
All from `ui/src/app.css` (dark shown; light theme exists under `[data-theme="light"]`):
- Surfaces: `--bg #0a0d0c`, `--inset #070a09`, `--panel-2 #0c100f`, `--head #0a0f0d`, `--panel #0f1413`, `--hover #0c1110`, `--sel #18211e`
- Hairlines: `--line #1b2422`, `--line-bright #2c3835`
- Ink: `--ink-bright #eef4f0`, `--ink #c4d0cb`, `--muted #7c8c86`, `--faint #4a5752`
- Status: `--amber #e8a13a`, `--green #5ad19a`, `--red #e5484d`, `--blue #4a90d9` (links/info only), `--slate #566460`
- Type: Berkeley Mono (JetBrains Mono fallback), one family. Sizes used: 9 / 10 / 11 / 12 / 13 / 16(mobile)px. Labels: 500, uppercase, +0.12–0.2em. All updating numerals: `font-variant-numeric: tabular-nums`.
- Spacing: 4px rhythm — gaps 4/6/8/10/12, panel inset `10px 14px`-class paddings as specified above.
- Radii: 0 (panel), 1px (toggle knob), 2px (controls/toggle track), 6px (chips only), 12px (mobile bottom sheet). **Never 999px pills.**
- Shadows: none at rest; CTA inset glow `inset 0 0 18px -10px var(--amber)`; mobile bottom sheet uses the existing `--shadow-sheet`.

## Assets
- 🐑 repo icon is the existing per-repo emoji mark; ↥ 🎙 ✕ ▾ ✓ ⚠ ▦ are unicode glyphs (no icon library).
- No new images or icons introduced.

## Files
- `reference-2a.html` — self-contained reference (desktop 880px modal + 390px mobile sheet), tokens inlined, opens in any browser.
