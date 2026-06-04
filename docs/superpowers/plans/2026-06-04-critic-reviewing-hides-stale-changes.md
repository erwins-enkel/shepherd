# Critic Re-Review Suppresses Stale CHANGES Prominence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the critic is re-reviewing a PR (after the agent addressed findings and CI went green), stop the UI from showing a prominent amber "CHANGES" signal — show a `REVIEWING…` state instead, with prior findings still reachable.

**Architecture:** Centralize the "reviewing wins over verdict" precedence into one pure helper (`criticChip`) in `critic-badge.ts`, unit-tested. `CriticBadge` and `GitRail` both consume it so they can't drift. Gate `Viewport`'s `prAttention` hue on the same `reviews.isReviewing()` signal. No server/data-model/i18n changes — the `session:reviewing` signal, the `reviews` store, and the `criticbadge_reviewing*` keys already exist.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Vitest, Paraglide JS i18n.

---

## File Structure

- `ui/src/lib/components/critic-badge.ts` — **modify**: add `CriticChip` type + `criticChip()` helper (pure precedence logic).
- `ui/src/lib/components/critic-badge.test.ts` — **modify**: add `criticChip` unit tests.
- `ui/src/lib/components/CriticBadge.svelte` — **modify**: consume `criticChip` for the reviewing-vs-verdict precedence (behavior-preserving).
- `ui/src/lib/components/GitRail.svelte` — **modify**: drive the verdict-chip off `criticChip`; render a clickable `REVIEWING…` chip during re-review; add `.critic-reviewing` chip styling.
- `ui/src/lib/components/Viewport.svelte` — **modify**: import `reviews`, gate `prAttention` on `!reviews.isReviewing(session.id)`.

All work is in the `ui/` package. Install deps first: `cd ui && bun install`.

---

## Task 1: `criticChip` precedence helper (pure, TDD)

**Files:**
- Modify: `ui/src/lib/components/critic-badge.ts`
- Test: `ui/src/lib/components/critic-badge.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/lib/components/critic-badge.test.ts` (the file already defines `v(...)` factory and imports). Add `criticChip` to the import on line 2:

```ts
import { criticBadgeLabel, addressRoundInfo, criticChip } from "./critic-badge";
```

Then append this describe block at the end of the file:

```ts
describe("criticChip", () => {
  it("reviewing wins over a verdict; body present → findings readable", () => {
    expect(criticChip(v({ decision: "changes_requested", body: "## findings" }), true)).toEqual({
      kind: "reviewing",
      hasFindings: true,
    });
  });
  it("reviewing with a verdict but no body → no findings to read", () => {
    expect(criticChip(v({ decision: "changes_requested", body: "" }), true)).toEqual({
      kind: "reviewing",
      hasFindings: false,
    });
  });
  it("reviewing with no verdict at all → reviewing, no findings", () => {
    expect(criticChip(undefined, true)).toEqual({ kind: "reviewing", hasFindings: false });
  });
  it("not reviewing with a verdict → the verdict chip", () => {
    expect(criticChip(v({ decision: "changes_requested", body: "x" }), false)).toEqual({
      kind: "verdict",
      decision: "changes_requested",
      label: criticBadgeLabel(v({ decision: "changes_requested" })),
    });
  });
  it("not reviewing with no verdict → none", () => {
    expect(criticChip(undefined, false)).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test -- critic-badge`
Expected: FAIL — `criticChip is not a function` (or import error).

- [ ] **Step 3: Implement the helper**

Append to `ui/src/lib/components/critic-badge.ts` (after `criticBadgeLabel`, before or after `addressRoundInfo` — order doesn't matter). Note `ReviewDecision` must be imported; widen the existing type import on line 1:

```ts
import type { ReviewVerdict, ReviewDecision } from "../types";
```

Then add:

```ts
/**
 * What the single critic chip should show, given the verdict and whether the critic is
 * re-reviewing right now. `reviewing` always wins over a stale verdict so the UI stops
 * screaming "CHANGES" while the fix is being re-validated.
 *  - "reviewing": critic running now. `hasFindings` = a prior verdict body is still readable,
 *                 so a consumer can keep the findings popover reachable during re-review.
 *  - "verdict":   not reviewing; show the verdict badge/label.
 *  - "none":      nothing to show.
 * The auto-address streak badges (addressRoundInfo) are independent and render alongside.
 */
export type CriticChip =
  | { kind: "reviewing"; hasFindings: boolean }
  | { kind: "verdict"; decision: ReviewDecision; label: string }
  | { kind: "none" };

export function criticChip(v: ReviewVerdict | undefined, reviewing: boolean): CriticChip {
  if (reviewing) return { kind: "reviewing", hasFindings: Boolean(v?.body) };
  const label = criticBadgeLabel(v);
  return label ? { kind: "verdict", decision: v!.decision, label } : { kind: "none" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test -- critic-badge`
Expected: PASS (all existing + 5 new `criticChip` cases).

- [ ] **Step 5: Typecheck**

Run: `cd ui && bun run check`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/critic-badge.ts ui/src/lib/components/critic-badge.test.ts
git commit -m "feat(ui): criticChip helper centralizing reviewing-over-verdict precedence"
```

---

## Task 2: `CriticBadge.svelte` consumes `criticChip` (behavior-preserving)

**Files:**
- Modify: `ui/src/lib/components/CriticBadge.svelte`

- [ ] **Step 1: Update the import**

Change line 3 to also import `criticChip`:

```ts
import { criticChip, addressRoundInfo } from "./critic-badge";
```

(`criticBadgeLabel` is no longer used directly here — drop it from the import.)

- [ ] **Step 2: Replace the derived `label` with a derived chip**

Replace line 10 (`const label = $derived(criticBadgeLabel(verdict));`) with:

```ts
const chip = $derived(criticChip(verdict, reviewing));
```

- [ ] **Step 3: Rewrite the chip markup block**

Replace the markup block currently on lines 14–23:

```svelte
{#if reviewing}
  <span class="critic-badge critic-reviewing" title={m.criticbadge_reviewing_title()}>
    <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
  </span>
{:else if label}
  <span
    class="critic-badge critic-{verdict!.decision}"
    title={verdict!.summary || m.criticbadge_title()}>{label}</span
  >
{/if}
```

with:

```svelte
{#if chip.kind === "reviewing"}
  <span class="critic-badge critic-reviewing" title={m.criticbadge_reviewing_title()}>
    <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
  </span>
{:else if chip.kind === "verdict"}
  <span
    class="critic-badge critic-{chip.decision}"
    title={verdict!.summary || m.criticbadge_title()}>{chip.label}</span
  >
{/if}
```

The trailing `{#if round}` block (lines 24–42) and all `<style>` are unchanged.

- [ ] **Step 4: Typecheck + tests**

Run: `cd ui && bun run check && bun run test -- critic`
Expected: no new type errors; tests pass. (`verdict!` is safe in the `verdict` branch because `chip.kind === "verdict"` only arises when `criticBadgeLabel(verdict)` returned non-null, i.e. verdict is defined — the `!` mirrors the prior code.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/CriticBadge.svelte
git commit -m "refactor(ui): CriticBadge uses shared criticChip precedence"
```

---

## Task 3: `GitRail.svelte` shows REVIEWING (findings still reachable)

**Files:**
- Modify: `ui/src/lib/components/GitRail.svelte`

- [ ] **Step 1: Update imports + derived state**

Change line 7 to import `criticChip` instead of `criticBadgeLabel`:

```ts
import { criticChip } from "./critic-badge";
```

Replace line 205 (`const verdictLabel = $derived(criticBadgeLabel(verdict));`) with a chip derivation. `reviewing` is already derived at line 232 — but `$derived` reads are order-independent in Svelte 5 runes, so referencing it here is fine:

```ts
const chip = $derived(criticChip(verdict, reviewing));
```

Note: line 436 (inside the findings popover) currently uses `verdictLabel` and `critic-{verdict.decision}`. Replace those two usages with direct calls so the popover header still renders the verdict label regardless of reviewing state:

- On line 436, change `<span class="rv-label critic-{verdict.decision}">{verdictLabel}</span>` to:

```svelte
<span class="rv-label critic-{verdict.decision}">{criticBadgeLabel(verdict)}</span>
```

and re-add `criticBadgeLabel` to the import on line 7:

```ts
import { criticChip, criticBadgeLabel } from "./critic-badge";
```

(The popover only renders under `{#if showReview && verdict}` at line 433, so `verdict` is defined there.)

- [ ] **Step 2: Rewrite the chip markup block (lines 361–371)**

Replace:

```svelte
{#if verdict}
  <button
    class={["verdict-chip", `critic-${verdict.decision}`, { armed: showReview }]}
    type="button"
    aria-expanded={showReview}
    title={m.gitrail_review_title()}
    onclick={toggleReview}
  >
    {verdictLabel}
  </button>
{/if}
```

with:

```svelte
{#if chip.kind === "reviewing"}
  {#if chip.hasFindings}
    <button
      class={["verdict-chip", "critic-reviewing", { armed: showReview }]}
      type="button"
      aria-expanded={showReview}
      title={m.criticbadge_reviewing_title()}
      onclick={toggleReview}
    >
      <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
    </button>
  {:else}
    <span class="verdict-chip critic-reviewing" title={m.criticbadge_reviewing_title()}>
      <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
    </span>
  {/if}
{:else if chip.kind === "verdict"}
  <button
    class={["verdict-chip", `critic-${chip.decision}`, { armed: showReview }]}
    type="button"
    aria-expanded={showReview}
    title={m.gitrail_review_title()}
    onclick={toggleReview}
  >
    {chip.label}
  </button>
{/if}
```

- [ ] **Step 2b: Verify the message keys exist**

Run: `grep -n "criticbadge_reviewing" ui/messages/en.json ui/messages/de.json`
Expected: both `criticbadge_reviewing` and `criticbadge_reviewing_title` present in **both** files. (They already exist — CriticBadge uses them. No new keys.)

- [ ] **Step 3: Add the `.critic-reviewing` chip styling**

In the `<style>` block, locate the existing verdict-chip color rules (`.verdict-chip.critic-changes_requested`, `.rv-label.critic-changes_requested` around lines 761–764). Add a sibling rule plus the pulsing dot, mirroring CriticBadge's reviewing treatment:

```css
.verdict-chip.critic-reviewing {
  border-color: var(--color-amber);
  color: var(--color-amber);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.verdict-chip.critic-reviewing .rev-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-amber);
  /* functional status motion — exempt from the reduced-motion blanket (app.css) */
  animation: rev-pulse 1.1s ease-in-out infinite !important;
}
@keyframes rev-pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}
```

If a `@keyframes rev-pulse` already exists in this file, do NOT duplicate it — keep only one. (At time of writing GitRail has no `rev-pulse`; verify with `grep -n "rev-pulse" ui/src/lib/components/GitRail.svelte` before adding, and omit the `@keyframes` block if the grep finds one.)

- [ ] **Step 4: Typecheck**

Run: `cd ui && bun run check`
Expected: no new errors. (`verdictLabel` no longer referenced anywhere — confirm with `grep -n "verdictLabel" ui/src/lib/components/GitRail.svelte` returning nothing.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/GitRail.svelte
git commit -m "feat(ui): GitRail shows REVIEWING during critic re-review, keeps findings reachable"
```

---

## Task 4: `Viewport.svelte` git-toggle attention drops during re-review

**Files:**
- Modify: `ui/src/lib/components/Viewport.svelte`

- [ ] **Step 1: Import `reviews`**

Line 36 currently imports only `repoConfig`:

```ts
import { repoConfig } from "$lib/reviews.svelte";
```

Change it to also import `reviews`:

```ts
import { reviews, repoConfig } from "$lib/reviews.svelte";
```

- [ ] **Step 2: Gate `prAttention` on the reviewing signal**

Replace the `prAttention` derivation (lines 255–258):

```ts
const prAttention = $derived(
  git?.state === "open" &&
    (git.checks === "failure" || git.latestReview?.state === "changes_requested"),
);
```

with:

```ts
const prAttention = $derived(
  git?.state === "open" &&
    (git.checks === "failure" || git.latestReview?.state === "changes_requested") &&
    !reviews.isReviewing(session.id),
);
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run check`
Expected: no new errors. (`reviews.isReviewing(id: string): boolean` already exists in `reviews.svelte.ts`; `session.id` is used elsewhere in this component, e.g. lines 1149/1222.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/Viewport.svelte
git commit -m "fix(ui): suppress git-toggle attention hue while critic is re-reviewing"
```

---

## Task 5: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Install + run the full UI gate**

Run:

```bash
cd ui && bun install && bun run check && bun run test && bun run check:i18n
```

Expected: check passes (no type/svelte errors), all tests pass, i18n catalog parity passes (no new keys were added, so parity is unaffected).

- [ ] **Step 2: Lint**

Run: `cd ui && bun run lint` (if defined) — fix any reported issues. If no `lint` script exists in `ui/package.json`, skip.

- [ ] **Step 3: Confirm no stray references**

Run:

```bash
grep -rn "verdictLabel" ui/src/lib/components/GitRail.svelte; \
grep -rn "criticBadgeLabel" ui/src/lib/components/CriticBadge.svelte
```

Expected: both return nothing (those direct usages were replaced by the shared helper / chip).

---

## Self-Review Notes

- **Spec coverage:** Task 1 = helper (§Design 1) + tests (§5); Task 2 = CriticBadge (§2); Task 3 = GitRail REVIEWING + findings + styling (§3); Task 4 = Viewport prAttention (§4). All spec sections mapped.
- **Type consistency:** `criticChip(verdict, reviewing)` signature and `CriticChip` variants (`reviewing`/`verdict`/`none`, fields `hasFindings`/`decision`/`label`) are used identically across Tasks 1–3. `ReviewDecision` imported in Task 1.
- **No new i18n keys:** reuses `criticbadge_reviewing` / `criticbadge_reviewing_title` (verified in Task 3 Step 2b) — no `en.json`/`de.json` edits, so the parity gate is untouched.
- **Out of scope:** `PrRow`/`PrBadge` GitHub-state dots, and any server change, are intentionally not touched.
