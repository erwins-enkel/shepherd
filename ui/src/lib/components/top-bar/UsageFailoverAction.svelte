<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { ProviderFailoverOffer } from "$lib/provider-capacity";
  import type { AgentProvider, ProviderFailoverStatus } from "$lib/types";

  // The capacity-failover control inside the usage hero: switch the default coding CLI to the
  // counterpart that still has weekly headroom, or undo a switch already in effect. Its own
  // component so the popover's template stays inside the complexity budget (same reason as
  // UsageRefreshButton next door).
  //
  // The reason line always names BOTH providers and both percentages on purpose: the hero shows
  // the hottest window across all providers, which can be a 5h window or the non-default CLI,
  // while the trigger is always the default CLI's WEEKLY window. Without the line the button
  // could read as contradicting the number right above it.
  let {
    offer,
    failover,
    busy,
    failed,
    onEngage,
    onRelease,
  }: {
    offer: ProviderFailoverOffer | null;
    failover: ProviderFailoverStatus | null;
    busy: boolean;
    failed: boolean;
    onEngage: () => void;
    onRelease: () => void;
  } = $props();

  const providerName = (provider: AgentProvider) =>
    provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex();
  const active = $derived(failover?.active === true && failover.from !== null);
</script>

{#if active || offer}
  <div class="failover">
    {#if failed}
      <span class="failover-error" role="alert">{m.usage_failover_failed()}</span>
    {/if}
    {#if active && failover?.from}
      <span class="failover-reason"
        >{m.usage_failover_active_reason({
          to: providerName(failover.current),
          from: providerName(failover.from),
        })}</span
      >
      <button type="button" class="failover-btn" disabled={busy} onclick={onRelease}>
        {m.usage_failover_revert({ provider: providerName(failover.from) })}
      </button>
    {:else if offer}
      <span class="failover-reason"
        >{m.usage_failover_offer_reason({
          from: providerName(offer.from),
          fromFreePct: offer.fromFreePct,
          to: providerName(offer.to),
          toFreePct: offer.toFreePct,
        })}</span
      >
      <button type="button" class="failover-btn accent" disabled={busy} onclick={onEngage}>
        {m.usage_failover_engage({ provider: providerName(offer.to) })}
      </button>
    {/if}
  </div>
{/if}

<style>
  .failover {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 11px;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--color-amber) 22%, var(--color-line));
  }
  .failover-reason {
    color: var(--color-ink);
    font-size: var(--fs-micro);
    line-height: 1.35;
    font-variant-numeric: tabular-nums;
  }
  .failover-error {
    color: var(--color-red);
    font-size: var(--fs-micro);
    line-height: 1.35;
  }
  /* Same button chrome as UsageRefreshButton, stretched to the hero's width so it reads as the
     hero's own action rather than a second, unrelated control. */
  .failover-btn {
    display: block;
    width: 100%;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    padding: 5px 10px;
    min-height: 30px;
    cursor: pointer;
  }
  .failover-btn.accent {
    border-color: color-mix(in srgb, var(--color-amber) 55%, var(--color-line-bright));
    color: var(--color-ink-bright);
  }
  .failover-btn:hover:not(:disabled) {
    background: var(--color-inset);
  }
  .failover-btn:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .failover-btn:disabled {
    cursor: default;
    opacity: 0.5;
  }
  @media (pointer: coarse) {
    .failover-btn {
      min-height: 44px;
    }
  }
</style>
