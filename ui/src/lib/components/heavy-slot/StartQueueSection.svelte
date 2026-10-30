<script lang="ts">
  import type { HeavySlotStartWaiter } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "#lib/basename.js";

  // The host popover's "Waiting starts": new sessions the pressure brake holds, in start order.
  // Renders nothing while none wait.
  let { starts = [] }: { starts?: HeavySlotStartWaiter[] } = $props();
</script>

{#if starts.length > 0}
  <section>
    <h3 class="sq-head">{m.heavyslot_starts()}</h3>
    <ol class="sq">
      {#each starts as s (s.position)}
        <li class="sq-row">
          <span class="sq-name"
            >{s.position}. <span class="sq-mono">{basename(s.repoPath)}</span></span
          >
          {#if s.issueNumber != null}<span class="sq-dim sq-mono">#{s.issueNumber}</span>{/if}
          {#if s.label}<span class="sq-dim sq-label">{s.label}</span>{/if}
          <span class="sq-dim sq-kind"
            >{s.kind === "drain"
              ? m.heavyslot_start_kind_drain()
              : m.heavyslot_start_kind_task()}</span
          >
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  /* The popover's section heading (HostPopover `h3`). */
  .sq-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    font-weight: 400;
    margin: 10px 0 4px;
  }
  .sq {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .sq-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 3px 0;
  }
  .sq-name {
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .sq-dim {
    color: var(--color-muted);
  }
  .sq-mono {
    font-family: var(--font-mono);
  }
  .sq-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .sq-kind {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
