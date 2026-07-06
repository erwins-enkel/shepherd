<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { gaugeColor, providerCapacityRows } from "$lib/components/usage-gauges";
  import type { UsageLimits } from "$lib/types";

  let { limits = null }: { limits?: UsageLimits | null } = $props();

  const rows = $derived(providerCapacityRows(limits));
</script>

<div class="pcap" aria-label={m.newtask_provider_capacity_aria()}>
  <div class="pcap-head micro">{m.newtask_provider_capacity_title()}</div>
  <div class="pcap-list">
    {#each rows as row (row.provider)}
      <div class="pcap-row" class:stale={row.stale}>
        <span class="pcap-label">
          {row.provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex()}
        </span>
        {#if row.available && row.remainingPct != null && row.usedPct != null}
          <span
            class="pcap-bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={row.remainingPct}
            aria-valuetext={m.newtask_provider_capacity_meter_aria({
              provider:
                row.provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex(),
              free: row.remainingPct,
            })}
          >
            <span
              class="pcap-fill"
              style="width:{row.remainingPct}%;background:{gaugeColor(row.usedPct)}"
            ></span>
          </span>
          <span class="pcap-value"
            >{m.newtask_provider_capacity_free({ pct: row.remainingPct })}</span
          >
        {:else}
          <span class="pcap-miss">{m.newtask_provider_capacity_unavailable()}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .pcap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .pcap-head {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .pcap-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .pcap-row {
    display: grid;
    grid-template-columns: minmax(5.5rem, 7rem) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }

  .pcap-row.stale {
    opacity: 0.55;
  }

  .pcap-label,
  .pcap-value,
  .pcap-miss {
    font-size: var(--fs-meta);
    min-width: 0;
  }

  .pcap-label {
    color: var(--color-ink-bright);
  }

  .pcap-value {
    color: var(--color-muted);
    white-space: nowrap;
  }

  .pcap-miss {
    color: var(--color-faint);
    white-space: nowrap;
  }

  .pcap-bar {
    display: block;
    width: 100%;
    height: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }

  .pcap-fill {
    display: block;
    height: 100%;
    transition: width 0.2s ease;
  }
</style>
