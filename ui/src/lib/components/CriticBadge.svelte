<script lang="ts">
  import { reviews } from "$lib/reviews.svelte";
  import { criticBadgeLabel } from "./critic-badge";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const verdict = $derived(reviews.map[sessionId]);
  const label = $derived(criticBadgeLabel(verdict));
</script>

{#if reviewing}
  <span class="critic-badge critic-reviewing" title={m.criticbadge_reviewing_title()}>
    <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
  </span>
{:else if label}
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
    color: var(--color-blue);
  }
  .critic-error {
    color: var(--color-faint);
  }
  /* critic actively reviewing: amber outline + pulsing dot (mirrors GitRail) */
  .critic-reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: rev-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes rev-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
</style>
