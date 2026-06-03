# Detail-panel Automation Pill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five cryptic repo-automation icon toggles in the detail-panel rail (`GitRail.svelte`) with one worded `AUTOMATION n/5` pill that opens a grouped, labeled repo-automation panel.

**Architecture:** Extract a pure, unit-testable module (`git-rail-automation.ts`) for the pill count + group structure. Build the panel as its own component (`AutomationPanel.svelte`) that owns the toggles and the absorbed drain-config fields. In `GitRail.svelte`, replace the five `.crit-toggle` buttons + conditional gear + drain popover with the pill + panel, wired into the existing one-popover-at-a-time + Escape/click-outside machinery. No backend change — same `repoConfig` actions.

**Tech Stack:** Svelte 5 (runes), SvelteKit, Paraglide JS (EN+DE), Vitest, TypeScript.

**Reference spec:** `docs/superpowers/specs/2026-06-03-detail-panel-automation-pill-design.md`

**Codebase conventions (read before starting):**
- This UI suite has **no `@testing-library/svelte`**. The pattern (see `src/lib/components/issues-panel.test.ts`, `pr-badge.test.ts`, `git-rail-drain.test.ts`) is: extract pure logic into a `.ts` companion and unit-test that. Components themselves are verified by `bun run check` (svelte-check) + lint + a manual run — NOT by render tests. Do not add a new test framework.
- Every user-facing string MUST route through `m.*` with a key in **both** `ui/messages/en.json` and `ui/messages/de.json` (snake_case, component-prefixed). `cd ui && bun run check:i18n` enforces catalog parity.
- All UI commands run from the `ui/` package. Fresh worktree: run `cd ui && bun install` once before anything.

**`repoConfig` store API (`src/lib/reviews.svelte.ts`), used unchanged:**
- Reads: `isEnabled`, `isAutoAddressEnabled`, `learningsOn`, `isAutopilotEnabled`, `isAutoDrainEnabled`, `maxAutoFor`, `autoLabelFor`, `usageCeilingFor`, `ensure(repoPath)`
- Writes: `toggle`, `toggleAutoAddress`, `toggleLearnings`, `toggleAutopilot`, `toggleAutoDrain`, `setMaxAuto`, `setAutoLabel`, `setUsageCeiling`
- `reviews.isReviewing(sessionId)` → critic-reviewing state (per session)
- Drain clamps in `src/lib/components/git-rail-drain.ts`: `clampCap`, `clampCeiling`, `sanitizeLabel`

---

## File Structure

- **Create** `ui/src/lib/components/git-rail-automation.ts` — pure helpers: the `AutomationFlags` type, `automationCount(flags)`, and the `AUTOMATION_GROUPS` structural descriptor. No Svelte, no `m.*`, no `repoConfig` import — pure data + math so it's unit-testable.
- **Create** `ui/src/lib/components/git-rail-automation.test.ts` — Vitest unit tests for the above.
- **Create** `ui/src/lib/components/AutomationPanel.svelte` — the popover: grouped labeled switches + inline drain-config fields. Owns the drain commit handlers (moved out of `GitRail.svelte`).
- **Modify** `ui/messages/en.json` and `ui/messages/de.json` — new `automation_*` keys.
- **Modify** `ui/src/lib/components/GitRail.svelte` — remove the five `.crit-toggle` buttons + conditional gear (lines 334–414) and the entire drain popover machinery; add the `AUTOMATION` pill + `<AutomationPanel>` + `showAutomation` wiring.

---

## Task 1: Pure automation module (count + group structure)

**Files:**
- Create: `ui/src/lib/components/git-rail-automation.ts`
- Test: `ui/src/lib/components/git-rail-automation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/components/git-rail-automation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  automationCount,
  AUTOMATION_GROUPS,
  type AutomationFlags,
} from "./git-rail-automation";

const flags = (over: Partial<AutomationFlags> = {}): AutomationFlags => ({
  critic: false,
  autoAddress: false,
  learnings: false,
  autopilot: false,
  autoDrain: false,
  ...over,
});

describe("automationCount", () => {
  it("is 0 when everything is off", () => {
    expect(automationCount(flags())).toBe(0);
  });

  it("counts each independent automation", () => {
    expect(automationCount(flags({ critic: true }))).toBe(1);
    expect(automationCount(flags({ learnings: true, autopilot: true }))).toBe(2);
    expect(
      automationCount(flags({ critic: true, learnings: true, autopilot: true, autoDrain: true })),
    ).toBe(4);
  });

  it("does NOT count auto-address unless the critic is on (dependency)", () => {
    expect(automationCount(flags({ autoAddress: true }))).toBe(0);
    expect(automationCount(flags({ critic: true, autoAddress: true }))).toBe(2);
  });

  it("never exceeds 5", () => {
    expect(
      automationCount(
        flags({ critic: true, autoAddress: true, learnings: true, autopilot: true, autoDrain: true }),
      ),
    ).toBe(5);
  });
});

describe("AUTOMATION_GROUPS", () => {
  it("lists all five automation keys exactly once", () => {
    const keys = AUTOMATION_GROUPS.flatMap((g) => g.items);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    expect(keys.sort()).toEqual(
      ["autoAddress", "autoDrain", "autopilot", "critic", "learnings"].sort(),
    );
  });

  it("groups review / behavior / queue in order", () => {
    expect(AUTOMATION_GROUPS.map((g) => g.id)).toEqual(["review", "behavior", "queue"]);
    expect(AUTOMATION_GROUPS[0].items).toEqual(["critic", "autoAddress"]);
    expect(AUTOMATION_GROUPS[1].items).toEqual(["learnings", "autopilot"]);
    expect(AUTOMATION_GROUPS[2].items).toEqual(["autoDrain"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- git-rail-automation`
Expected: FAIL — `Cannot find module './git-rail-automation'`.

- [ ] **Step 3: Write the module**

Create `ui/src/lib/components/git-rail-automation.ts`:

```ts
/** Pure helpers for the detail-panel automation pill + panel.
 *  No Svelte / no i18n / no store imports so they unit-test in isolation
 *  (mirrors git-rail-drain.ts and pr-badge.ts). */

/** Every automation key. `autoAddress` depends on `critic`. */
export type AutomationKey = "critic" | "autoAddress" | "learnings" | "autopilot" | "autoDrain";

/** On/off state for each automation, as read from repoConfig in the component. */
export interface AutomationFlags {
  critic: boolean;
  autoAddress: boolean;
  learnings: boolean;
  autopilot: boolean;
  autoDrain: boolean;
}

/** A themed group of automation rows shown in the panel. */
export interface AutomationGroup {
  id: "review" | "behavior" | "queue";
  items: AutomationKey[];
}

/** Panel layout: theme groups in display order. The pill denominator (5) is the
 *  total item count across all groups. */
export const AUTOMATION_GROUPS: readonly AutomationGroup[] = [
  { id: "review", items: ["critic", "autoAddress"] },
  { id: "behavior", items: ["learnings", "autopilot"] },
  { id: "queue", items: ["autoDrain"] },
];

/** Number of automations currently ON. Auto-address only counts while the critic
 *  is on (it's a no-op otherwise), matching the panel's disabled-row behavior. */
export function automationCount(flags: AutomationFlags): number {
  return [
    flags.critic,
    flags.autoAddress && flags.critic,
    flags.learnings,
    flags.autopilot,
    flags.autoDrain,
  ].filter(Boolean).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- git-rail-automation`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/git-rail-automation.ts ui/src/lib/components/git-rail-automation.test.ts
git commit -m "feat(ui): pure automation count + group module for detail-panel pill"
```

---

## Task 2: i18n keys (EN + DE)

**Files:**
- Modify: `ui/messages/en.json`
- Modify: `ui/messages/de.json`

- [ ] **Step 1: Add the EN keys**

In `ui/messages/en.json`, after the existing `"drain_ceiling_label"` line (line 111), add:

```json
  "automation_pill_label": "automation",
  "automation_pill_aria": "Repo automation: {count} of 5 on. Open settings.",
  "automation_pill_reviewing_aria": "Critic is reviewing. Open repo automation settings.",
  "automation_panel_title": "Repo automation",
  "automation_group_review": "Code review",
  "automation_group_behavior": "Agent behavior",
  "automation_group_queue": "Work queue",
  "automation_critic_name": "Critic",
  "automation_critic_desc": "Auto code-review when CI goes green",
  "automation_autoaddress_name": "Auto-Address",
  "automation_autoaddress_desc": "Feed findings back to the agent automatically",
  "automation_autoaddress_needs_critic": "Needs the Critic on",
  "automation_learnings_name": "Learnings",
  "automation_learnings_desc": "Inject house-rule guidelines into new agents",
  "automation_autopilot_name": "Autopilot",
  "automation_autopilot_desc": "Auto-proceed through stops toward a PR",
  "automation_autodrain_name": "Auto-Drain",
  "automation_autodrain_desc": "Auto-spawn agents for labeled issues",
```

> Note: JSON requires a comma after the prior `"drain_ceiling_label": "Ceiling %"` line and no trailing comma if these become the last keys in the object. They are NOT last (more keys follow line 112+), so each line keeps its trailing comma as shown.

- [ ] **Step 2: Add the DE keys**

In `ui/messages/de.json`, at the matching location (immediately after the `"drain_ceiling_label"` entry), add the identical keys with German values:

```json
  "automation_pill_label": "Automatisierung",
  "automation_pill_aria": "Repo-Automatisierung: {count} von 5 aktiv. Einstellungen öffnen.",
  "automation_pill_reviewing_aria": "Critic prüft gerade. Repo-Automatisierungseinstellungen öffnen.",
  "automation_panel_title": "Repo-Automatisierung",
  "automation_group_review": "Code-Review",
  "automation_group_behavior": "Agent-Verhalten",
  "automation_group_queue": "Arbeitswarteschlange",
  "automation_critic_name": "Critic",
  "automation_critic_desc": "Automatisches Code-Review, sobald die CI grün ist",
  "automation_autoaddress_name": "Auto-Address",
  "automation_autoaddress_desc": "Befunde automatisch an den Agenten zurückgeben",
  "automation_autoaddress_needs_critic": "Erfordert aktiven Critic",
  "automation_learnings_name": "Learnings",
  "automation_learnings_desc": "Hausregeln in neue Agenten einspeisen",
  "automation_autopilot_name": "Autopilot",
  "automation_autopilot_desc": "Automatisch durch Stopps Richtung PR fortfahren",
  "automation_autodrain_name": "Auto-Drain",
  "automation_autodrain_desc": "Agenten für gelabelte Issues automatisch starten",
```

- [ ] **Step 3: Verify catalog parity + generated types**

Run: `cd ui && bun run check:i18n`
Expected: PASS (identical, non-empty key sets across en/de).

If `check:i18n` also regenerates Paraglide output, no manual step is needed; the `m.automation_*` accessors are now available. If the command reports a Paraglide build is required, run `cd ui && bun run check` once to regenerate `$lib/paraglide/messages` before the next task.

- [ ] **Step 4: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json
git commit -m "i18n(ui): add automation pill + panel keys (en+de)"
```

---

## Task 3: AutomationPanel component

**Files:**
- Create: `ui/src/lib/components/AutomationPanel.svelte`

This component renders the grouped switches and the inline drain-config fields. It reads `repoConfig`/`reviews` and calls the same actions the old buttons called. It does NOT manage its own open/close or click-outside — the parent (`GitRail.svelte`) owns that and only mounts this when open.

- [ ] **Step 1: Write the component**

Create `ui/src/lib/components/AutomationPanel.svelte`:

```svelte
<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig } from "$lib/reviews.svelte";
  import { clampCap, clampCeiling, sanitizeLabel } from "./git-rail-drain";

  let { repoPath, sessionId }: { repoPath: string; sessionId: string } = $props();

  const criticOn = $derived(repoConfig.isEnabled(repoPath));
  const autoAddressOn = $derived(repoConfig.isAutoAddressEnabled(repoPath));
  const learningsOn = $derived(repoConfig.learningsOn(repoPath));
  const autopilotOn = $derived(repoConfig.isAutopilotEnabled(repoPath));
  const autoDrainOn = $derived(repoConfig.isAutoDrainEnabled(repoPath));
  const reviewing = $derived(reviews.isReviewing(sessionId));

  // Drain config fields, seeded from stored config and re-seeded whenever the
  // section becomes visible (drain turned on) or the repo changes.
  let drainCap = $state(repoConfig.maxAutoFor(repoPath));
  let drainLabel = $state(repoConfig.autoLabelFor(repoPath));
  let drainCeiling = $state(repoConfig.usageCeilingFor(repoPath));
  $effect(() => {
    if (autoDrainOn) {
      drainCap = repoConfig.maxAutoFor(repoPath);
      drainLabel = repoConfig.autoLabelFor(repoPath);
      drainCeiling = repoConfig.usageCeilingFor(repoPath);
    }
  });

  async function commitDrainCap() {
    const n = clampCap(drainCap);
    drainCap = n;
    await repoConfig.setMaxAuto(repoPath, n);
    drainCap = repoConfig.maxAutoFor(repoPath);
  }
  async function commitDrainLabel() {
    const t = sanitizeLabel(drainLabel);
    if (t === null) {
      drainLabel = repoConfig.autoLabelFor(repoPath);
      return;
    }
    drainLabel = t;
    await repoConfig.setAutoLabel(repoPath, t);
    drainLabel = repoConfig.autoLabelFor(repoPath);
  }
  async function commitDrainCeiling() {
    const n = clampCeiling(drainCeiling);
    drainCeiling = n;
    await repoConfig.setUsageCeiling(repoPath, n);
    drainCeiling = repoConfig.usageCeilingFor(repoPath);
  }
</script>

<div class="auto-pop" role="dialog" aria-label={m.automation_panel_title()}>
  <div class="auto-head">{m.automation_panel_title()}</div>

  <!-- Code review -->
  <div class="auto-group">{m.automation_group_review()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🔍 {m.automation_critic_name()}</div>
      <div class="auto-desc">{m.automation_critic_desc()}</div>
    </div>
    <button
      class={["sw", { on: criticOn, reviewing }]}
      type="button"
      role="switch"
      aria-checked={criticOn}
      aria-busy={reviewing}
      aria-label={m.automation_critic_name()}
      onclick={() => repoConfig.toggle(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class={["auto-row", { disabled: !criticOn }]}>
    <div class="auto-meta">
      <div class="auto-name">🤖 {m.automation_autoaddress_name()}</div>
      <div class="auto-desc">
        {criticOn ? m.automation_autoaddress_desc() : m.automation_autoaddress_needs_critic()}
      </div>
    </div>
    <button
      class={["sw", { on: autoAddressOn && criticOn }]}
      type="button"
      role="switch"
      aria-checked={autoAddressOn && criticOn}
      disabled={!criticOn}
      aria-label={m.automation_autoaddress_name()}
      onclick={() => repoConfig.toggleAutoAddress(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>

  <!-- Agent behavior -->
  <div class="auto-group">{m.automation_group_behavior()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🎓 {m.automation_learnings_name()}</div>
      <div class="auto-desc">{m.automation_learnings_desc()}</div>
    </div>
    <button
      class={["sw", { on: learningsOn }]}
      type="button"
      role="switch"
      aria-checked={learningsOn}
      aria-label={m.automation_learnings_name()}
      onclick={() => repoConfig.toggleLearnings(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🛫 {m.automation_autopilot_name()}</div>
      <div class="auto-desc">{m.automation_autopilot_desc()}</div>
    </div>
    <button
      class={["sw", { on: autopilotOn }]}
      type="button"
      role="switch"
      aria-checked={autopilotOn}
      aria-label={m.automation_autopilot_name()}
      onclick={() => repoConfig.toggleAutopilot(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>

  <!-- Work queue -->
  <div class="auto-group">{m.automation_group_queue()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🚰 {m.automation_autodrain_name()}</div>
      <div class="auto-desc">{m.automation_autodrain_desc()}</div>
    </div>
    <button
      class={["sw", { on: autoDrainOn }]}
      type="button"
      role="switch"
      aria-checked={autoDrainOn}
      aria-label={m.automation_autodrain_name()}
      onclick={() => repoConfig.toggleAutoDrain(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  {#if autoDrainOn}
    <div class="drain-fields">
      <label class="drain-field">
        <span class="drain-label">{m.drain_cap_label()}</span>
        <input
          class="num"
          type="number"
          min="1"
          max="20"
          bind:value={drainCap}
          aria-label={m.drain_cap_label()}
          onchange={commitDrainCap}
        />
      </label>
      <label class="drain-field">
        <span class="drain-label">{m.drain_label_label()}</span>
        <input
          class="num"
          type="text"
          bind:value={drainLabel}
          aria-label={m.drain_label_label()}
          onchange={commitDrainLabel}
          onblur={commitDrainLabel}
        />
      </label>
      <label class="drain-field">
        <span class="drain-label">{m.drain_ceiling_label()}</span>
        <input
          class="num"
          type="number"
          min="0"
          max="100"
          bind:value={drainCeiling}
          aria-label={m.drain_ceiling_label()}
          onchange={commitDrainCeiling}
        />
      </label>
    </div>
  {/if}
</div>

<style>
  .auto-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    width: 320px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    overflow: hidden;
  }
  .auto-head {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding: 10px 12px 4px;
  }
  .auto-group {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 8px 12px 4px;
  }
  .auto-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .auto-row.disabled {
    opacity: 0.45;
  }
  .auto-meta {
    min-width: 0;
  }
  .auto-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--color-ink-bright);
  }
  .auto-desc {
    font-size: 11px;
    color: var(--color-muted);
    margin-top: 2px;
  }
  /* switch: track + knob, green when on, amber pulse while reviewing */
  .sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    border-radius: 9px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .sw:disabled {
    cursor: not-allowed;
  }
  .sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .sw.on {
    background: var(--color-green);
  }
  .sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
  .sw.reviewing {
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: sw-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes sw-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
  .drain-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 12px 22px;
    border-top: 1px solid var(--color-line);
    background: var(--color-panel);
  }
  .drain-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .drain-label {
    font-size: 11px;
    color: var(--color-ink);
    white-space: nowrap;
  }
  .num {
    flex: 0 0 auto;
    width: 90px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 3px 6px;
    text-align: right;
  }
</style>
```

- [ ] **Step 2: Type/lint-check the component**

Run: `cd ui && bun run check`
Expected: PASS — no svelte-check errors. (If it flags missing `m.automation_*`, Task 2 Step 3's Paraglide regen did not run — run `bun run check` again after confirming the keys exist in both catalogs.)

Run: `cd ui && bun run lint`
Expected: PASS (or only auto-fixable formatting — re-run after `bun run lint` applies fixes, or `bunx prettier --write src/lib/components/AutomationPanel.svelte`).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/AutomationPanel.svelte
git commit -m "feat(ui): AutomationPanel — grouped repo-automation switches + inline drain config"
```

---

## Task 4: Wire pill + panel into GitRail; remove old toggles + drain popover

**Files:**
- Modify: `ui/src/lib/components/GitRail.svelte`

All line numbers below refer to the file as it stands at the start of this plan.

- [ ] **Step 1: Import the panel + count helper**

In the `<script>` block, after the existing import of `ReadyToggle` (line 9), add:

```ts
  import AutomationPanel from "./AutomationPanel.svelte";
  import { automationCount } from "./git-rail-automation";
```

- [ ] **Step 2: Remove drain-popover state, add panel state**

Delete the drain-config popover state block (lines 46–50):

```ts
  // Auto-drain config popover (per-repo cap / label / usage ceiling)
  let showDrain = $state(false);
  let drainCap = $state(1);
  let drainLabel = $state("");
  let drainCeiling = $state(80);
```

Replace it with the panel-open flag:

```ts
  // Repo-automation panel (pill-anchored popover; replaces the icon-toggle horde)
  let showAutomation = $state(false);
```

- [ ] **Step 3: Drop showDrain from the effect reset**

In the `$effect` that resets popovers on session change (lines 76–91), replace the line `showDrain = false;` (line 84) with:

```ts
    showAutomation = false;
```

- [ ] **Step 4: Update the PR + review popover openers to close the panel**

In `startPr()` (lines 93–101), replace `showDrain = false;` (line 98) with:

```ts
    showAutomation = false; // one popover at a time
```

In `toggleReview()` (lines 103–109), replace `showDrain = false;` (line 107) with:

```ts
      showAutomation = false;
```

- [ ] **Step 5: Remove the drain open/commit handlers**

Delete `toggleDrain()` (lines 111–121) and the three drain commit functions `commitDrainCap` / `commitDrainLabel` / `commitDrainCeiling` (lines 123–145). They now live in `AutomationPanel.svelte`.

Add a panel toggle that joins the one-popover-at-a-time rule. Place it where `toggleDrain` was:

```ts
  function toggleAutomation() {
    showAutomation = !showAutomation;
    if (showAutomation) {
      showPr = false;
      showReview = false; // one popover at a time
    }
  }
```

- [ ] **Step 6: Swap showDrain for showAutomation in the window dismiss handlers**

In `onWindowKeydown` (lines 148–153), replace `if (showDrain) showDrain = false;` (line 151) with:

```ts
      if (showAutomation) showAutomation = false;
```

In `onWindowPointerdown` (lines 154–159), replace `if (showDrain) showDrain = false;` (line 157) with:

```ts
      if (showAutomation) showAutomation = false;
```

- [ ] **Step 7: Remove unused drain-clamp imports**

The clamp helpers moved to the panel. Delete the import on line 8:

```ts
  import { clampCap, clampCeiling, sanitizeLabel } from "./git-rail-drain";
```

(Confirm no other reference remains: `grep -n "clampCap\|clampCeiling\|sanitizeLabel" ui/src/lib/components/GitRail.svelte` should return nothing after this step.)

- [ ] **Step 8: Add a derived pill count**

After the `reviewing` derived (line 260), add:

```ts
  const autoCount = $derived(
    automationCount({
      critic: criticOn,
      autoAddress: autoAddressOn,
      learnings: learningsOn,
      autopilot: autopilotOn,
      autoDrain: autoDrainOn,
    }),
  );
```

> The `criticOn` / `autoAddressOn` / `learningsOn` / `autopilotOn` / `autoDrainOn` deriveds already exist at lines 255–259 and stay — they now feed the count and the panel only.

- [ ] **Step 9: Replace the icon-toggle horde with the pill**

Replace the entire block from line 334 (`{#if repoPath}`) through line 414 (the `{/if}` that closes the second `repoPath` block, immediately before the `{#if showReady ...}` at line 415) with a single pill button:

```svelte
      {#if repoPath}
        <button
          class={["gbtn", "auto-pill", { reviewing, armed: showAutomation }]}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={showAutomation}
          aria-busy={reviewing}
          aria-label={reviewing
            ? m.automation_pill_reviewing_aria()
            : m.automation_pill_aria({ count: autoCount })}
          onclick={toggleAutomation}
        >
          ⚙ {m.automation_pill_label()}
          <span class="auto-count" class:on={autoCount > 0}>{autoCount}/5</span>
        </button>
      {/if}
```

- [ ] **Step 10: Mount the panel and remove the drain popover markup**

Delete the entire drain popover block (lines 471–510), i.e. the `{#if showDrain} … {/if}` `drain-pop` dialog.

In its place (a sibling of the `{#if showPr}` and `{#if showReview}` blocks, inside `.git-rail-wrap`), add:

```svelte
    {#if showAutomation}
      <AutomationPanel {repoPath} {sessionId} />
    {/if}
```

- [ ] **Step 11: Remove now-dead CSS**

Delete the `.crit-toggle`, `.crit-dot`, `.crit-dot.on`, `.crit-dot.reviewing`, and `rev-pulse` keyframe rules (lines 599–628) — the icon toggles that used them are gone. Also delete the drain-popover CSS `.drain-pop` / `.drain-head` / `.drain-field` / `.drain-label` / `.drain-field .pr-title` (lines 771–795) — that markup moved to `AutomationPanel.svelte`.

Keep `.gbtn.reviewing` (lines 594–598) — the pill reuses it. Add pill-specific CSS near the other `.gbtn` rules:

```css
  /* automation summary pill: worded label + active-count, replaces the toggle horde */
  .auto-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .auto-count {
    color: var(--color-faint);
  }
  .auto-count.on {
    color: var(--color-green);
  }
```

- [ ] **Step 12: Type-check, lint, and confirm no dead references**

Run: `cd ui && bun run check`
Expected: PASS — no svelte-check errors, no "unused" / "is declared but never used" for `showDrain`, `clampCap`, etc.

Run: `grep -nE "showDrain|toggleDrain|drain-pop|crit-toggle|crit-dot" ui/src/lib/components/GitRail.svelte`
Expected: no matches.

Run: `cd ui && bun run lint`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add ui/src/lib/components/GitRail.svelte
git commit -m "feat(ui): replace detail-panel toggle horde with AUTOMATION pill + panel"
```

---

## Task 5: Full verification + manual confirmation

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test + check + build**

Run: `cd ui && bun run test`
Expected: PASS (includes the new `git-rail-automation.test.ts`).

Run: `cd ui && bun run check && bun run check:i18n && bun run lint`
Expected: all PASS.

Run: `cd ui && bun run build`
Expected: SvelteKit build succeeds (catches SSR-only breakage the dev checks miss).

- [ ] **Step 2: Root package unaffected — sanity check**

Run: `cd /home/patrick/Work/.shepherd-worktrees/shepherd-find-ux-horde-icon && bun install && bunx tsc --noEmit && bun test ./test`
Expected: PASS — this change is UI-only; the root build/test must stay green.

- [ ] **Step 3: Manual confirmation in the running app**

Use the `run` skill (or `cd ui && bun run dev`) to open the app, select a session with a repo, and verify:
- The rail shows `⚙ automation n/5` instead of the five icons; `n` matches the enabled automations.
- Clicking the pill opens the grouped panel (Code review / Agent behavior / Work queue) with labeled rows + switches + descriptions.
- Toggling each switch flips state and the pill count updates; Auto-Address is dimmed/disabled while Critic is off, with the "Needs the Critic on" description.
- Turning Auto-Drain on reveals the cap / label / ceiling fields inline; editing them persists (reopen the panel to confirm).
- Opening the PR or review popover closes the panel (and vice versa); Escape and click-outside close the panel.
- Capture a screenshot for the PR.

- [ ] **Step 4: Final commit (only if Step 3 surfaced fixes)**

If manual testing required adjustments, commit them:

```bash
git add -A
git commit -m "fix(ui): polish automation pill/panel after manual verification"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** pill (`AutomationPill` → inline pill in Task 4 Step 9) ✓; grouped panel (Task 3) ✓; descriptions kept (Task 3 markup) ✓; auto-address disabled-when-critic-off (Task 3 + count in Task 1) ✓; reviewing pulse on critic row + pill (Task 3 `.sw.reviewing` + Task 4 `.gbtn.reviewing`) ✓; drain config absorbed inline (Task 3 + removal in Task 4 Steps 5/10/11) ✓; count denominator fixed at 5 (Task 1) ✓; popover one-at-a-time + Escape/click-outside (Task 4 Steps 4/5/6) ✓; i18n EN+DE parity (Task 2) ✓; per-session controls untouched (Task 4 replaces only lines 334–414, leaving PR/merge/CI/Ready/verdict) ✓; tests (Task 1 + Task 5) ✓.
- **Decomposition note:** `AutomationPill` from the spec is implemented as inline pill markup in `GitRail.svelte` (≈10 lines) rather than a separate file — it needs the parent's popover state and is too small to warrant its own component. The panel (the large part) is extracted. This is a deliberate, stated deviation, not a gap.
- **Type consistency:** `automationCount` / `AutomationFlags` / `AUTOMATION_GROUPS` names match between Task 1 module, its test, and the Task 4 call site. Drain handler names (`commitDrainCap/Label/Ceiling`) and clamp helpers (`clampCap/clampCeiling/sanitizeLabel`) match `git-rail-drain.ts`. `repoConfig` method names verified against `reviews.svelte.ts`.
- **Placeholder scan:** none — every code/step is concrete.
