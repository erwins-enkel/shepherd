<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { upNext } from "#lib/up-next.svelte.js";
  import { readyPrCount } from "#lib/components/up-next-prs.js";

  // Up Next's count of PRs that can merge right now (server-classified), in green because it is
  // actionable. Overlaid on the top-right corner of the lens tab or phone segment it sits in —
  // the parent is the positioning anchor — so it costs the fixed lens grid no width. Hidden at 0.
  const count = $derived(readyPrCount(upNext.snapshot?.pullRequests));
</script>

{#if count > 0}
  <span class="ready-badge" aria-label={m.upnext_pr_ready_badge({ count })}
    >{count > 99 ? "99+" : count}</span
  >
{/if}

<style>
  /* --fs-micro: a count overlay, not body text (the owed badge's precedent). */
  .ready-badge {
    position: absolute;
    inset-block-start: 3px;
    inset-inline-end: 3px;
    min-inline-size: 14px;
    padding-inline: 3px;
    box-sizing: border-box;
    border: 1px solid currentColor;
    border-radius: 999px;
    color: var(--color-green);
    background: color-mix(in oklab, currentColor 14%, var(--color-panel));
    font-size: var(--fs-micro);
    line-height: 1.2;
    letter-spacing: 0;
    text-align: center;
  }
</style>
