<script lang="ts">
  import type { TaskAmendment } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // The AMENDMENTS row of the Viewport's task tooltip (#2225). Its own component rather than three
  // more branches inline: the Viewport template is already at its complexity ceiling, and a list
  // that renders nothing when there is nothing to render is exactly the shape a component wants.
  // Retracted amendments stay listed, struck through — they are part of the operator's record even
  // though they reach no prompt.
  let { rows }: { rows: TaskAmendment[] } = $props();
</script>

{#if rows.length > 0}
  <span class="dp-row">
    <span class="dp-k">{m.tasktip_amendments()}</span>
    <span class="dp-v">
      {#each rows as a (a.id)}
        <span class="dp-amend" class:retracted={a.retractedAt != null}>
          {#if a.retractedAt != null}<s>{a.text}</s>{:else}{a.text}{/if}
        </span>
      {/each}
    </span>
  </span>
{/if}

<style>
  /* Mirrors the tooltip's own row/key/value grid (Svelte styles are component-scoped, so the
     parent's cannot reach in here). Keep in step with Viewport's .dp-row/.dp-k/.dp-v. */
  .dp-row {
    display: grid;
    grid-template-columns: minmax(128px, 0.42fr) minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    font-size: var(--fs-meta);
  }
  .dp-k {
    color: var(--color-muted);
  }
  .dp-v {
    min-width: 0;
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
  .dp-amend {
    display: block;
  }
  .dp-amend.retracted {
    color: var(--color-faint);
  }
</style>
