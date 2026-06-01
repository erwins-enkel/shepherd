<script lang="ts">
  import { reviews } from "$lib/reviews.svelte";
  import { criticBadgeLabel } from "./critic-badge";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();
  const verdict = $derived(reviews.map[sessionId]);
  const label = $derived(criticBadgeLabel(verdict));
</script>

{#if label}
  <span
    class="critic-badge critic-{verdict!.decision}"
    title={verdict!.summary || m.criticbadge_title()}>{label}</span
  >
{/if}

<style>
  .critic-badge {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .critic-changes_requested {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .critic-commented {
    color: var(--color-blue, #4a90d9);
  }
  .critic-error {
    color: var(--color-faint);
  }
</style>
