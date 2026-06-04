# Critic re-review must suppress the stale "CHANGES" prominence

**Date:** 2026-06-04
**Status:** Approved

## Problem

When the critic requests changes, the agent addresses them, CI goes green, and the
critic re-runs to verify the fix. During that re-review window the UI still shows a
prominent amber "changes" signal — making it look like there's outstanding work when
the solution is actually already being validated.

`CriticBadge.svelte` already handles this correctly: while `reviews.isReviewing(id)` is
true it shows a `REVIEWING…` chip and suppresses the verdict label. But the
"reviewing hides the verdict" precedence rule lives **inline in that one component**, so
two other surfaces that independently re-derive verdict prominence never learned it and
keep screaming amber during re-review:

- **`GitRail.svelte:361`** — the amber `⚠ CHANGES` verdict-chip renders whenever a verdict
  exists. `reviewing` is derived at line 232 but unused for the chip.
- **`Viewport.svelte:255`** — `prAttention` turns the git-toggle amber from GitHub's posted
  `changes_requested` review, which GitHub does **not** auto-dismiss when the agent pushes
  the fix, so it stays amber through the entire re-review.

Root cause: the precedence rule is duplicated/missing across surfaces — classic drift.

## Approach

Centralize the precedence decision in one pure, unit-tested helper and have every critic
surface consume it, so they can't drift again. Gate the Viewport attention hue on the same
reviewing signal.

No server, data-model, or i18n changes: the `session:reviewing` event, the
`reviews.isReviewing()` store, and the `criticbadge_reviewing*` message keys already exist
and are wired.

## Design

### 1. `ui/src/lib/components/critic-badge.ts` — new pure helper

```ts
export type CriticChip =
  | { kind: "reviewing"; hasFindings: boolean }   // critic running now; hasFindings = prior verdict body is readable
  | { kind: "verdict"; decision: ReviewDecision; label: string }
  | { kind: "none" };

export function criticChip(v: ReviewVerdict | undefined, reviewing: boolean): CriticChip {
  if (reviewing) return { kind: "reviewing", hasFindings: Boolean(v?.body) };
  const label = criticBadgeLabel(v);
  return label ? { kind: "verdict", decision: v!.decision, label } : { kind: "none" };
}
```

`reviewing` wins over any verdict. `hasFindings` tells a consumer whether the prior verdict
body is still readable (so the GitRail chip can stay clickable during re-review).

The auto-address streak badges (`addressRoundInfo` → round / final / stalled) are unchanged
and remain independent of this helper — they render alongside the chip exactly as today.

### 2. `CriticBadge.svelte`

Replace the inline `{#if reviewing}…{:else if label}` with `criticChip(verdict, reviewing)`:

- `kind === "reviewing"` → existing `critic-reviewing` chip (amber outline + pulsing dot).
- `kind === "verdict"` → existing verdict span.
- `kind === "none"` → nothing.

Behavior is identical to today; this just moves the precedence into the shared helper.

### 3. `GitRail.svelte` (verdict-chip, ~line 361)

Drive the chip off `criticChip(verdict, reviewing)`:

- `kind === "reviewing"`:
  - render a `verdict-chip critic-reviewing` element with a pulsing dot + `m.criticbadge_reviewing()`,
    mirroring CriticBadge's reviewing treatment.
  - **clickable** (a `<button>` that opens the existing findings popover via `toggleReview`)
    when `hasFindings`; a non-interactive `<span>` status chip otherwise.
  - `title` = `m.criticbadge_reviewing_title()`.
- `kind === "verdict"` → existing amber/blue verdict `<button>` (unchanged).
- `kind === "none"` → nothing.

Add `.verdict-chip.critic-reviewing` styling + `.rev-dot` keyframes mirroring CriticBadge
(small, component-scoped; the codebase already keeps badge classes per-component). Reuses
existing message keys — **no new i18n keys**.

### 4. `Viewport.svelte` (~line 255)

Import `reviews` from `$lib/reviews.svelte` (only `repoConfig` is imported today) and gate
the attention hue on the reviewing signal:

```ts
const prAttention = $derived(
  git?.state === "open" &&
    (git.checks === "failure" || git.latestReview?.state === "changes_requested") &&
    !reviews.isReviewing(session.id),
);
```

Suppressing the whole hue during re-review is safe: the critic only runs on green CI, so
`reviewing && checks === "failure"` is contradictory/transient and self-corrects when the
review finishes. `prClear` is left as-is.

### 5. Tests — extend `critic-badge.test.ts`

`criticChip` cases:
- reviewing + verdict with body → `{ kind: "reviewing", hasFindings: true }`
- reviewing + verdict without body → `{ kind: "reviewing", hasFindings: false }`
- reviewing + no verdict → `{ kind: "reviewing", hasFindings: false }`
- not reviewing + changes_requested verdict → `{ kind: "verdict", decision: "changes_requested", label }`
- not reviewing + no verdict → `{ kind: "none" }`

## Out of scope

- `PrRow.svelte` / `PrBadge.svelte` review dots reflect the raw GitHub review state and are a
  separate concern from the critic-verdict prominence; not touched.
- No new "critic is re-reviewing" data field — the existing in-flight `reviewing` signal is
  sufficient.

## Verification

- `cd ui && bun install && bun run check && bun run test && bun run check:i18n`
- Manual: a session whose critic posted `changes_requested`, agent pushes a fix, CI green,
  critic re-runs → GitRail chip shows `REVIEWING…` (clickable to prior findings), git-toggle
  no longer amber; once the re-review posts, the new verdict prominence returns.
