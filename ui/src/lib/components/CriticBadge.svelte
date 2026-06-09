<script lang="ts">
  import { reviews } from "$lib/reviews.svelte";
  import { criticChip, addressRoundInfo } from "./critic-badge";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const verdict = $derived(reviews.map[sessionId]);
  const chip = $derived(criticChip(verdict, reviewing));
  const round = $derived(addressRoundInfo(verdict, clock.current));
  // latest tool-use of the in-flight critic (its own claude session) — shows what it's
  // doing right now; falls back to the generic line until the first tool-use lands.
  const activity = $derived(reviews.activityFor(sessionId));
</script>

{#snippet addrSuffix(r: NonNullable<typeof round>)}
  <span
    class="addr addr-{r.status}"
    title={r.status === "stalled"
      ? m.criticbadge_stalled_title({ cap: r.cap })
      : r.status === "final"
        ? m.criticbadge_final_title()
        : m.criticbadge_round_title({ round: r.round, cap: r.cap })}
  >
    · {r.status === "stalled"
      ? m.criticbadge_stalled({ round: r.round, cap: r.cap })
      : r.status === "final"
        ? m.criticbadge_final({ round: r.round, cap: r.cap })
        : m.criticbadge_round({ round: r.round, cap: r.cap })}</span
  >
{/snippet}

{#if chip.kind === "reviewing"}
  <span
    class="critic-badge critic-reviewing"
    title={activity
      ? m.criticbadge_reviewing_activity_title({ activity })
      : m.criticbadge_reviewing_title()}
  >
    <span class="rev-dot" aria-hidden="true"
    ></span>{m.criticbadge_reviewing()}{#if round}{@render addrSuffix(round)}{/if}
  </span>
{:else if chip.kind === "verdict"}
  <span
    class="critic-badge critic-{chip.decision}"
    title={verdict!.summary || m.criticbadge_title()}
    >{chip.label}{#if round}{@render addrSuffix(round)}{/if}</span
  >
{/if}

<style>
  .critic-badge {
    font-size: var(--fs-micro);
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
  /* auto-address suffix inside a composite badge */
  .addr-round {
    color: var(--color-blue);
  }
  /* final allowed round in flight: recessive vs. the blue in-progress and orange stalled */
  .addr-final {
    color: var(--color-faint);
  }
  /* auto-address gave up at the cap — needs a human */
  .addr-stalled {
    color: var(--color-amber);
    font-weight: 600;
  }
</style>
