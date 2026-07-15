<script lang="ts">
  import type { EpicDraftChild } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    child,
    index,
    materializedNumber,
    blockedLabel,
  }: {
    child: EpicDraftChild;
    index: number;
    /** The real issue number once materialized, else null (still a draft key). */
    materializedNumber: number | null;
    /** Pre-resolved "blocked by …" label (sibling titles), or "" when no edges. */
    blockedLabel: string;
  } = $props();
</script>

<li class="edp-row">
  <span class="edp-num" aria-hidden="true">{index + 1}</span>
  <div class="edp-fields">
    <span class="edp-child-title">
      {#if materializedNumber != null}
        <span class="edp-child-num">#{materializedNumber}</span>
      {/if}
      {child.title}
    </span>
    {#if child.body}<span class="edp-child-body">{child.body}</span>{/if}
    {#if blockedLabel}
      <span class="edp-blocked">{m.epicdraft_blocked_by({ deps: blockedLabel })}</span>
    {/if}
  </div>
</li>

<style>
  .edp-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .edp-num {
    flex: none;
    min-width: 1.4em;
    text-align: right;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1.5;
  }
  .edp-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .edp-child-title {
    color: var(--color-ink);
    font-size: var(--fs-base);
  }
  .edp-child-num {
    color: var(--color-accent);
    margin-right: 3px;
  }
  .edp-child-body {
    max-width: 74ch;
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.45;
  }
  .edp-blocked {
    color: var(--color-amber);
    font-size: var(--fs-micro);
  }
</style>
