<script lang="ts">
  import type { Epic, EpicSummary } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import {
    epicMeter,
    epicPlainExplanation,
    epicTimingExplanation,
    type EpicMeterTone,
  } from "#lib/epic-timing-text.js";

  let {
    summary,
    live = undefined,
    repoPath,
    issueNumber,
    nowMs,
    slots = null,
    coachId = "",
    onepic,
  }: {
    summary?: EpicSummary;
    live?: Epic;
    repoPath: string;
    issueNumber: number;
    /** The Herd's tick — the hover panel's epic clock runs on it. */
    nowMs: number;
    /** The repo's agent slots, for the forecast's basis line; null when unknown. */
    slots?: number | null;
    /** Coachmark anchor id ("" = none; only ONE badge may claim an id). */
    coachId?: string;
    onepic?: (repoPath: string, issueNumber: number) => void;
  } = $props();

  // Prefer the WS-live Epic over the cached summary, mirroring IssuesPanel.epicFor().
  // The header reuses this badge with `live` only (no summary); fall back to zero
  // counts when neither is present (not expected in practice, kept safe).
  const counts = $derived(
    live
      ? {
          total: live.children.length,
          merged: live.children.filter((c) => c.state === "merged").length,
        }
      : summary
        ? { total: summary.total, merged: summary.merged }
        : { total: 0, merged: 0 },
  );

  // One meter segment per child, in epic order; the summary only knows the counts.
  const segments = $derived<EpicMeterTone[]>(
    live
      ? epicMeter(live.children)
      : Array.from({ length: counts.total }, (_, i) => (i < counts.merged ? "merged" : "rest")),
  );

  const explanation = $derived(
    live
      ? epicTimingExplanation({ epic: live, nowMs, slots })
      : epicPlainExplanation({ number: issueNumber, ...counts }),
  );

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    onepic?.(repoPath, issueNumber);
  }
</script>

<button
  type="button"
  class="epic-badge"
  aria-label={m.epic_badge_open_aria({
    number: issueNumber,
    merged: counts.merged,
    total: counts.total,
  })}
  use:statusTip={{ text: explanation, panel: true, navigates: true }}
  use:coachTarget={coachId}
  onclick={handleClick}
>
  <span class="epic-label">{m.epic_badge({ merged: counts.merged, total: counts.total })}</span>
  <span class="epic-meter" aria-hidden="true">
    {#each segments as tone, i (i)}<span class="epic-seg seg-{tone}"></span>{/each}
  </span>
</button>

<style>
  .epic-badge {
    display: inline-flex;
    flex-direction: column;
    flex: none;
    gap: 2px;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 600;
    padding: 1px 6px;
    border: 1px solid var(--color-blue);
    border-radius: 2px;
    color: var(--color-blue);
    background: transparent;
    white-space: nowrap;
    cursor: pointer;
  }
  .epic-badge:hover,
  .epic-badge:focus-visible {
    background: color-mix(in srgb, var(--color-blue) 12%, transparent);
  }
  /* One segment per child, as wide as the label: blue merged, amber in flight, line the rest. */
  .epic-meter {
    display: flex;
    gap: 1px;
    height: 2px;
    width: 100%;
  }
  .epic-seg {
    flex: 1 1 0;
    min-width: 0;
    border-radius: 1px;
    background: var(--color-line-bright);
  }
  .seg-merged {
    background: var(--color-blue);
  }
  .seg-running {
    background: var(--color-amber);
  }
</style>
