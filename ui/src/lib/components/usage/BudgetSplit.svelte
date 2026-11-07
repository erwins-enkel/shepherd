<script lang="ts">
  import type { GraphqlSpendSplit } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import SplitBar from "./SplitBar.svelte";

  // One GitHub counter's window split into the Shepherd server's own spend and everything
  // else on the account: the GraphQL budget (#2840) or the REST write counter (#2943).
  const {
    split,
    measuring,
    label,
  }: {
    split: GraphqlSpendSplit;
    /** Shown until the window's readings span long enough for per-hour rates. */
    measuring: string;
    /** Names the counter when it isn't the row's own (the REST row's write counter). */
    label?: string;
  } = $props();
</script>

<div class="split-block">
  {#if label}
    <span class="split-label">{label}</span>
  {/if}
  {#if split.ownPerHour !== null && split.otherPerHour !== null}
    <SplitBar a={split.ownPerHour} b={split.otherPerHour} />
    <div class="split-legend">
      <span class="split-own"
        >{m.github_lens_split_own({ rate: split.ownPerHour.toLocaleString() })}</span
      >
      <span class="split-sep" aria-hidden="true">·</span>
      <span class="split-other"
        >{m.github_lens_split_other({ rate: split.otherPerHour.toLocaleString() })}</span
      >
    </div>
  {:else}
    <span class="desc">{measuring}</span>
  {/if}
</div>

<style>
  .split-block {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }

  .split-label,
  .desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .split-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }

  /* Swatches match SplitBar's default tones: blue = Shepherd server, amber = everything else. */
  .split-own::before,
  .split-other::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 0.375rem;
  }

  .split-own::before {
    background: var(--color-blue);
  }

  .split-other::before {
    background: var(--color-amber);
  }

  .split-sep {
    color: var(--color-faint);
  }
</style>
