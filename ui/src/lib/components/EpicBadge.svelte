<script lang="ts">
  import type { Epic, EpicSummary } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    summary,
    live = undefined,
    repoPath,
    issueNumber,
    onepic,
  }: {
    summary?: EpicSummary;
    live?: Epic;
    repoPath: string;
    issueNumber: number;
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

  // Progress meter width — derived from merged/total, never hardcoded. Guard divide-by-zero.
  const pct = $derived(counts.total > 0 ? (counts.merged / counts.total) * 100 : 0);

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    onepic?.(repoPath, issueNumber);
  }
</script>

<button
  type="button"
  class="epic-badge"
  style="--epic-pct: {pct}%"
  title={m.epic_badge_open_title({
    number: issueNumber,
    merged: counts.merged,
    total: counts.total,
  })}
  aria-label={m.epic_badge_open_aria({
    number: issueNumber,
    merged: counts.merged,
    total: counts.total,
  })}
  onclick={handleClick}
>
  <span class="epic-label">{m.epic_badge({ merged: counts.merged, total: counts.total })}</span>
  <span class="epic-meter" aria-hidden="true"><span class="epic-fill"></span></span>
</button>

<style>
  .epic-badge {
    display: inline-flex;
    flex-direction: column;
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
  .epic-meter {
    display: block;
    height: 2px;
    width: 100%;
    background: var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }
  .epic-fill {
    display: block;
    height: 100%;
    width: var(--epic-pct);
    background: var(--color-blue);
  }
</style>
