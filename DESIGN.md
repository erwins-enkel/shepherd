---
name: Shepherd
description: Self-hosted mission control for interactive Claude Code, a terminal-native green-phosphor HUD.
colors:
  bg: "#0a0d0c"
  glow: "#0d1211"
  panel: "#0f1413"
  panel-2: "#0c100f"
  head: "#0a0f0d"
  inset: "#070a09"
  hover: "#0c1110"
  sel: "#18211e"
  line: "#1b2422"
  line-bright: "#2c3835"
  ink: "#c4d0cb"
  ink-bright: "#eef4f0"
  muted: "#7c8c86"
  faint: "#4a5752"
  amber: "#e8a13a"
  green: "#5ad19a"
  red: "#e5484d"
  blue: "#4a90d9"
  slate: "#566460"
typography:
  title:
    fontFamily: "Berkeley Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.02em"
  body:
    fontFamily: "Berkeley Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0.02em"
  label:
    fontFamily: "Berkeley Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.12em"
  numeric:
    fontFamily: "Berkeley Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.06em"
    fontFeature: "tnum"
rounded:
  sm: "2px"
  md: "3px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "10px 14px"
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  button-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.amber}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  input:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  pip:
    backgroundColor: "{colors.amber}"
    size: "9px"
    rounded: "50%"
  compose-sheet:
    backgroundColor: "{colors.head}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
---

# Design System: Shepherd

## 1. Overview

**Creative North Star: "The Phosphor Watchfloor"**

Shepherd is the dim room where one operator watches a herd of live agents at 2am. The interface is an instrument panel, not a dashboard: a near-black, green-tinted ground with text glowing like phosphor on a CRT, status lights that mean something, and gauges that read at a glance. Everything is monospace because everything here is, literally, a terminal. The aesthetic is earned, not styled: it reads like mission telemetry or an aircraft glass cockpit, where every mark on screen is a measurement and decoration is a liability.

The system is dense and quiet. Surfaces are flat and square, separated by hairline strokes and shifts in tonal value rather than shadows or cards. Color is rationed: the ground and chrome are desaturated greens and grays, and saturation is spent almost entirely on the four status lights and the single amber action. When nothing needs the operator, the screen is calm to the point of being recessive. When an agent is blocked, the red pip is unmistakable. That contrast between calm and alarm is the whole design.

This system explicitly rejects four families. It is not a **generic SaaS dashboard** (no rounded-card grids, pastel gradients, hero-metric tiles, or Inter-on-white). It is not a **consumer chat app** (no bubbly, emoji-forward, soft coziness). It is not an **enterprise admin panel** (no heavy gray chrome or density-without-elegance). It is not **crypto or gamer neon** (no glow-on-black spectacle, RGB, or glassmorphism for its own sake). If a mark on screen is not telemetry, it does not belong.

**Key Characteristics:**

- Monospace everywhere (Berkeley Mono); hierarchy from weight, case, and color, never a second typeface.
- Near-black green-phosphor ground; chroma reserved for four status lights plus one amber action.
- Flat, square panels separated by tonal layering and 1px hairlines; no shadows at rest.
- Dense, telemetry-first layout that reads at a glance and survives on a phone in one hand.
- Calm by default, alarm when earned: the blocked state is the loudest thing on screen.

## 2. Colors

A desaturated, green-tinted monochrome ground with four reserved status accents. Dark is the default theme; a luminance-inverted light theme shares the same green-tinted family for daytime use.

### Primary

- **Signal Amber** (#e8a13a): The single action accent and the "working" status light. Carries the primary button (as an outline + inset glow, never a fill), active toolbar states, and the slow scanline wash over the live terminal. Its scarcity is what makes it read as "act here."

### Secondary

- **Phosphor Green** (#5ad19a): The "ready" light and the ready check glyph. Reserved for actionable-complete (a session ready to merge). Means go / ship. It does not paint a merely finished turn — a parked WAITING agent is not "done, ignore me."
- **Alert Red** (#e5484d): The "blocked, needs you" light. The loudest color in the system; it appears only when an agent is waiting on the operator.
- **Cold Blue** (#4a90d9): Informational accent and links. Never a status light; keeps "info" distinct from "state."
- **Idle Slate** (#566460): The "idle / parked" light. A near-neutral so a quiet agent recedes rather than nags. Carries both a dormant agent and a WAITING one (finished its turn, parked for the operator's next steer); a hollow ring vs a solid dot separates parked from idle.

### Neutral

- **Deep Pine Black** (#0a0d0c): The app ground, lifted by a faint radial glow (#0d1211) at the top.
- **Console Panel** (#0f1413) / **panel-2** (#0c100f) / **head** (#0a0f0d) / **inset** (#070a09): The tonal layering vocabulary. Depth is built by stepping these values, not by stacking shadows.
- **Phosphor Ink** (#c4d0cb): Body text, ~12:1 on the ground.
- **Bright Phosphor** (#eef4f0): Emphasis text, titles, the value the eye should land on.
- **Muted Sage** (#7c8c86): Secondary text and metadata, ~5.5:1 (AA).
- **Faint Moss** (#4a5752): De-emphasized labels, disabled glyphs, the quietest legible step.
- **Hairline** (#1b2422) / **Bright Hairline** (#2c3835): The 1px strokes that separate every flat panel.

### Named Rules

**The Four-Light Rule.** Status speaks in exactly four colors: amber (working), green (ready / actionable-complete), red (blocked), slate (idle / parked, including a WAITING agent awaiting its next steer). These hues are reserved for state. No decorative element may borrow a status color, or it dilutes the only signal that must never be missed. Green is spent only on a ready-to-ship session, never on a merely finished turn — so a parked agent reads quiet, not "done, ignore me."

**The Quiet Ground Rule.** The surface is desaturated green-black; visible chroma stays at or below ~10% of any screen, spent on status lights and the one amber action. If the screen looks colorful at rest, color has leaked out of its lane.

## 3. Typography

**Display / Body / Label Font:** Berkeley Mono (with JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace).

**Character:** One monospaced typeface carries the entire system. The grid of a fixed-width face is the point: it makes the UI read as a terminal and keeps columns, gauges, and code aligned. Personality comes from weight, case, letter-spacing, and ink brightness, not from contrast between families. Base size is a deliberate 13px, tight and instrument-like.

### Hierarchy

- **Title** (600, 13px, 1.35, +0.02em): Panel and section headers, the agent designation, the value the operator scans for. Brighter ink (Bright Phosphor) does as much work as the weight.
- **Body** (400, 13px, 1.45, +0.02em): Default running text and terminal output. The global base; +0.02em tracking opens the mono just enough to breathe.
- **Label** (500, 11px, uppercase, +0.12em): Buttons, tab and status labels, toolbar chrome. The wide tracking and small caps read as machine labeling, not prose.
- **Numeric** (400, 11px, +0.06em, tabular): Token counts, usage percentages, gauge readouts, SHAs. Tabular figures so digits never reflow as values tick.

### Named Rules

**The One Typeface Rule.** Everything is Berkeley Mono. A second family is forbidden; hierarchy is built from size, weight, case, and color only. The monospace grid is non-negotiable, it is what makes this an instrument.

**The Tabular Rule.** Every numeral that updates in place (tokens, gauges, counts, percentages) uses tabular figures. Digits must hold their column so a ticking value reads as motion, not jitter.

## 4. Elevation

This system is flat by doctrine. Depth is built from tonal layering, not shadow: the four ground values (inset #070a09 < panel-2 #0c100f < panel #0f1413 < head #0a0f0d) step against each other, and 1px hairlines (#1b2422, brightening to #2c3835 on focus or hover) draw every boundary. At rest there are no drop shadows and no glassmorphism. The only ambient light in the system is the faint radial glow at the top of the page and the inset amber glow on a primary button.

Shadows are permitted in exactly one situation: a summoned overlay. Bottom sheets and modals that rise over the live terminal carry a single soft shadow to lift them off the busy backdrop, paired with a subtle backdrop blur. That shadow is a response to state (the sheet was invoked), never a resting decoration.

### Shadow Vocabulary

- **Sheet lift** (`box-shadow: 0 -8px 40px rgba(0,0,0,0.5)`): The rising compose / bottom-sheet overlay, anchored to the bottom edge.
- **Action inset glow** (`box-shadow: inset 0 0 18px -10px var(--color-amber)`): The amber primary/active button. An internal glow, not an outer drop.

### Named Rules

**The Flat Panel Rule.** Surfaces are flat and square at rest. Depth comes from tonal value and hairlines. A drop shadow on a resting panel is prohibited; if you reach for one, you are missing a tonal step.

**The Earned Shadow Rule.** Shadows appear only as a response to invocation (a sheet or modal rising over the terminal). No shadow exists to make a static element look "lifted."

## 5. Components

### Buttons

- **Shape:** Gently squared (2px radius). Square enough to read as instrument hardware, never pill-shaped.
- **Default:** Outline ghost. Transparent fill, 1px Bright Hairline border, Phosphor Ink text, uppercase 11px label at +0.12em, padding 7px 14px.
- **Primary / Active:** Same ghost geometry, but border and text switch to Signal Amber with an inset amber glow (`inset 0 0 18px -10px`). The amber primary is never a solid amber fill; the glow does the emphasis.
- **Hover:** Background lifts to `hover` (#0c1110); border brightens. No motion beyond the tonal shift.

### Inputs / Fields

- **Style:** Recessed. `inset` (#070a09) background, 1px Hairline border, 2px radius, padding ~10px 12px, Body type.
- **Focus:** Border brightens to Bright Hairline. No outer glow ring; the system stays flat.
- **Compose sheet:** On mobile, text entry is a bottom sheet on `head` at 94% opacity, 12px top radius, rising with a 0.18s ease-out and a 3px backdrop blur over the dimmed terminal.

### Panels / Containers

- **Corner Style:** Square (0 radius). Structural surfaces do not round.
- **Background:** `panel` / `head` over the `bg` ground; nested regions step down to `panel-2` / `inset`.
- **Border:** 1px Hairline on all sides. Never a single colored side-stripe.
- **Shadow Strategy:** None at rest (see Elevation).
- **Internal Padding:** 10px 14px is the standard toolbar/panel inset; gaps of 8 to 10px between controls.

### Status Pip (signature)

- A 9px circle filled with the status color (amber / red / slate). The "working" pip pulses via an expanding box-shadow halo (`pip-pulse`, 1.5s ease-out). A ready-to-ship agent shows a bare green check glyph instead of a filled dot — green is reserved for that actionable-complete state. A WAITING (`done`) agent is parked, not complete, so it shares the idle slate hue but takes a hollow ring instead of idle's solid dot. Status never relies on hue alone: position, the pulse, the check glyph, the hollow-vs-solid ring, and the WORKING / WAITING / IDLE / BLOCKED label all carry meaning.

### Live Terminal (signature)

- A full xterm.js pane on the `bg` ground, fed real PTY bytes. A single amber scanline (a 4%-opacity amber band) sweeps top to bottom over 8s (`scan`), the one piece of ambient motion in the system. It is texture, not noise: low enough opacity to never compete with the terminal text.

### Navigation / Tabs

- Uppercase 11px labels at +0.12em, Muted Sage at rest, brightening to Phosphor Ink or Signal Amber when active. The active tab is marked by amber text plus border, not by a filled tab background.

## 6. Do's and Don'ts

### Do:

- **Do** keep everything in Berkeley Mono. Build hierarchy from size, weight, case, and ink brightness (Faint Moss -> Muted Sage -> Phosphor Ink -> Bright Phosphor).
- **Do** reserve the four status colors (amber / green / red / slate) strictly for agent state. The Four-Light Rule is the most important rule in the system.
- **Do** build depth with tonal layering and 1px hairlines (inset < panel-2 < panel < head). If a panel needs separation, step the value or brighten the hairline.
- **Do** keep structural panels square (0 radius) and reserve the 2px radius for buttons and chips; 12px is only for rising bottom sheets.
- **Do** use tabular figures for any number that updates in place.
- **Do** keep the screen calm at rest and make the blocked (red) state the loudest thing on it. Spend attention only on what is actionable.
- **Do** pair every status color with a non-color cue (position, pulse, check glyph, or label), and keep touch targets thumb-reachable; phone steering is first-class.

### Don't:

- **Don't** make it a **generic SaaS dashboard**: no rounded-card grids, pastel gradients, hero-metric tiles, or Inter-on-white.
- **Don't** make it a **consumer chat app**: no bubbly, emoji-forward, soft-and-friendly Slack/Discord coziness.
- **Don't** make it an **enterprise admin panel**: no heavy gray chrome, Bootstrap-era toolbars, or density-without-elegance.
- **Don't** make it **crypto/gamer neon**: no glow-on-black spectacle, RGB accents, or glassmorphism. Style must never outrun signal.
- **Don't** put a drop shadow on a resting surface, or round a structural panel. Flat and square is the doctrine.
- **Don't** use a colored side-stripe (`border-left`/`border-right` > 1px) as an accent. Use a full hairline, a tonal tint, or a leading pip instead.
- **Don't** spend a status hue on decoration, or let visible chroma climb above ~10% of a screen at rest.
- **Don't** fill the primary button solid amber. It is an outline ghost with an inset glow.
