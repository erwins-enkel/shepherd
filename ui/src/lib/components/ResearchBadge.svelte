<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { session }: { session: Session } = $props();
</script>

{#if session.research}
  <span
    class="research-badge"
    role="img"
    aria-label={m.research_badge_label()}
    title={m.research_badge_title()}
  >
    {m.research_badge_label()}
  </span>
{/if}

<style>
  /* Quiet informational kind-marker — slate mirrors the confined-sandbox badge
     color so both read as the same "noted info" tier, never green (reserved for READY). */
  .research-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-slate);
    border-radius: 2px;
    color: var(--color-slate);
    white-space: nowrap;
    font-weight: 600;
  }
</style>
