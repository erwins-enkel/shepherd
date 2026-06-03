# Detail-panel automation pill + grouped repo panel

**Date:** 2026-06-03
**Status:** Approved (design)
**Area:** `ui/src/lib/components/GitRail.svelte` (detail-panel action rail)

## Problem

The detail-panel action rail (`GitRail.svelte`) crams five repo-level automation
toggles plus a conditional config gear in among the per-session PR-flow controls.
Today's controls (lines 334–414):

| Icon | Control | Scope | Action |
| ---- | ------- | ----- | ------ |
| 🔍 | Critic | repo | `repoConfig.toggle` — auto code-review on CI-green |
| 🤖 | Auto-Address | repo | `repoConfig.toggleAutoAddress` — feed findings back (needs Critic) |
| 🎓 | Learnings | repo | `repoConfig.toggleLearnings` — inject house-rule guidelines |
| 🛫 | Autopilot | repo | `repoConfig.toggleAutopilot` — auto-proceed through stops → PR |
| 🚰 | Auto-Drain | repo | `repoConfig.toggleAutoDrain` — auto-spawn agents for labeled issues |
| ⚙ | Drain config | repo | `toggleDrain` popover (cap/label/ceiling), only while Auto-Drain on |

Three problems:

1. **Cryptic** — icon-only, no labels; a green dot is the only state cue.
2. **Mis-scoped** — all five are *repo-level* settings rendered in a *per-session*
   rail, identical for every session of the same repo.
3. **Crowded** — repo config blurs together with genuinely per-session actions
   (Open PR / Merge / CI dot / Ready / verdict chip).

## Solution

Hybrid: a single worded **AUTOMATION pill** in the rail summarizes state and opens
a **grouped repo-automation panel** where the toggling actually happens.

### Rail summary control — `AutomationPill`

- Renders `⚙ AUTOMATION n/5` where `n` = count of enabled automations.
- `n = [criticOn, autoAddressOn && criticOn, learningsOn, autopilotOn, autoDrainOn].filter(Boolean).length`;
  denominator is a fixed `5`.
- Amber styling + pulse while the Critic is `reviewing` (replaces the per-button
  reviewing state at lines 336/350/595–598).
- `aria-expanded` reflects panel open state; `aria-label` worded.
- Replaces the five `.crit-toggle` buttons and the conditional `⚙` gear in the
  rail markup (lines 334–414).

### Automation panel — `AutomationPanel.svelte` (new component)

A popover anchored to the pill, same chrome as the existing `.pr-pop` / `.drain-pop`
/ `.review-pop` (absolute, `top:100%`, right-aligned, inset background, 1px line,
drop shadow). Extracted into its own file so `GitRail.svelte` (already large) does
not grow further.

Grouped sections, each row = emoji + name + one-line description + a switch
(`role="switch"`, `aria-checked`):

- **Code review** — Critic, Auto-Address
- **Agent behavior** — Learnings, Autopilot
- **Work queue** — Auto-Drain, then cap / label / usage-ceiling fields expanded
  **inline** when Auto-Drain is on (absorbs the standalone drain popover).

Descriptions are kept inside the grouped layout — they are the core fix for the
"cryptic" problem.

### Behavior

- **Auto-Address** row is `disabled`/dimmed when Critic is off (preserves the
  current dependency at lines 354–368).
- **Reviewing** (amber pulse) shows on the Critic row's switch and on the pill.
- **Mobile**: the pill behaves as any `.gbtn` in the wrapping `.rail.mobile`; the
  panel stays an anchored popover.
- Per-session controls (Open PR / Merge / CI dot / Ready toggle / verdict chip)
  are untouched.

## Data flow

No backend change. The panel reads the same `repoConfig` derivations
(`criticOn`, `autoAddressOn`, `learningsOn`, `autopilotOn`, `autoDrainOn`,
`reviewing`) and calls the same actions (`repoConfig.toggle`, `toggleAutoAddress`,
`toggleLearnings`, `toggleAutopilot`, `toggleAutoDrain`, `setMaxAuto`,
`setAutoLabel`, `setUsageCeiling`). Drain field clamping reuses
`clampCap` / `clampCeiling` / `sanitizeLabel` from `git-rail-drain`.

A new `showAutomation` boolean joins the existing one-popover-at-a-time mutual
exclusion. `showDrain` and its `toggleDrain`/`drain-pop` markup (lines 47–50,
112–145, 471–509, 771–795) are removed — folded into the panel. The Escape /
click-outside handlers (lines 148–159) gain `showAutomation`.

## i18n (REQUIRED — parity gate)

New keys in **both** `ui/messages/en.json` and `de.json`:

- `automation_pill` (label), `automation_pill_aria`, `automation_pill_reviewing_aria`
- `automation_panel_title`
- group headers: `automation_group_review`, `automation_group_behavior`,
  `automation_group_queue`
- per automation: a `*_name` + `*_desc` pair (critic, autoaddress, learnings,
  autopilot, autodrain). Reuse existing `gitrail_*` / `drain_*` message bodies as
  descriptions where they already fit.

Drain field labels (`drain_cap_label`, `drain_label_label`, `drain_ceiling_label`,
`drain_panel_title`) are reused. `cd ui && bun run check:i18n` must pass.

## Testing (Vitest — `cd ui && bun run test`)

- Pill renders the correct enabled count.
- Clicking the pill opens the panel; `aria-expanded` flips.
- Toggling each switch calls the matching `repoConfig` action.
- Auto-Address switch is disabled when Critic is off.
- Drain cap/label/ceiling fields render only when Auto-Drain is on, and commit via
  the existing clamps.
- One-popover-at-a-time: opening the panel closes PR/review popovers and vice versa.

## Decisions

- Keep one-line descriptions inside the grouped layout.
- Panel is a popover, not a side sheet (consistent with existing popovers).
- Pill count denominator fixed at 5.

## Out of scope

- No change to backend `repoConfig` semantics or persistence.
- No change to per-session PR-flow controls.
- No new repo-settings route/page — the panel is the repo-config surface.
