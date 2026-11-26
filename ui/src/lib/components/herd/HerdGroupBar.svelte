<script lang="ts">
  import type { HerdStatus } from "#lib/components/herd-status.js";
  import type { HerdLayout } from "#lib/herd-layout.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";

  // The slim row under the lens strip (#4228): the active global status chip — or, without
  // one, a faint "N sessions · M repos" — on the left, and the Group: Stage | Repo switch on
  // the right. The switch shows only on the session-list lenses (All / Ready); with neither a
  // status filter nor the switch, the row is not rendered.
  let {
    statusFilter,
    statusLabel,
    onstatusfilter,
    layout,
    onlayout,
    showSwitch,
    sessionCount,
    repoCount,
    touch = false,
  }: {
    statusFilter: HerdStatus | null;
    statusLabel: string;
    onstatusfilter?: (status: HerdStatus | null) => void;
    layout: HerdLayout;
    onlayout: (layout: HerdLayout) => void;
    showSwitch: boolean;
    sessionCount: number;
    repoCount: number;
    /** Phone or coarse pointer: 44px targets. */
    touch?: boolean;
  } = $props();
</script>

{#if statusFilter != null || showSwitch}
  <div class="group-bar" class:touch-target={touch}>
    {#if statusFilter != null}
      <!-- aria-label carries status + clear action; the visible "✕" glyph alone would be read
         aloud without conveying what the chip does -->
      <button
        type="button"
        class="statchip"
        title={m.topbar_tally_clear_title()}
        aria-label={m.herd_status_chip_aria({ status: statusLabel })}
        aria-pressed="true"
        onclick={() => onstatusfilter?.(null)}
      >
        {statusLabel} ✕
      </button>
    {:else if showSwitch}
      <span class="summary">
        {m.herd_group_summary({ sessions: sessionCount, repos: repoCount })}
      </span>
    {/if}
    {#if showSwitch}
      <div
        class="switch"
        role="group"
        aria-label={m.herd_group_aria()}
        use:coachTarget={"herd-repo-layout"}
      >
        <span class="label" aria-hidden="true">{m.herd_group_label()}</span>
        <button
          type="button"
          class="seg"
          class:on={layout === "stage"}
          aria-pressed={layout === "stage"}
          onclick={() => onlayout("stage")}
        >
          {m.herd_group_stage()}
        </button>
        <button
          type="button"
          class="seg"
          class:on={layout === "repo"}
          aria-pressed={layout === "repo"}
          onclick={() => onlayout("repo")}
        >
          {m.herd_group_repo()}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .group-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 0 10px;
    border-bottom: 1px solid var(--color-line);
  }
  .group-bar.touch-target {
    min-height: 44px;
  }
  .statchip {
    min-width: 0;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-amber);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .touch-target .statchip {
    align-self: stretch;
  }
  .statchip:focus-visible,
  .seg:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .summary {
    min-width: 0;
    font-size: var(--fs-meta);
    color: var(--color-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The segmented-control recipe (/design-system), scaled to a slim row: amber text on the
     inset wash with a 2px amber underline when active, muted when not. */
  .switch {
    display: flex;
    align-items: center;
    flex: none;
    margin-left: auto;
    align-self: stretch;
  }
  .label {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-right: 6px;
  }
  .seg {
    align-self: stretch;
    border: 0;
    border-left: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    padding: 0 10px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .touch-target .seg {
    min-width: 44px;
  }
  .seg:hover {
    color: var(--color-ink);
  }
  .seg.on {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
</style>
