<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { gaugeColor, providerCapacityRows } from "$lib/components/usage-gauges";
  import { formatReset } from "$lib/format";
  import type { GaugeKey } from "$lib/components/usage-gauges";
  import type { AgentProvider } from "$lib/types";
  import type { UsageLimits } from "$lib/types";

  let { limits = null }: { limits?: UsageLimits | null } = $props();

  const rows = $derived(providerCapacityRows(limits));
  const nowMs = $derived(Date.now());

  function providerName(provider: AgentProvider): string {
    return provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex();
  }

  /** Short, visible, localized window chip (e.g. "5h" / "Weekly"). */
  function windowShort(key: GaugeKey): string {
    return key === "5H"
      ? m.newtask_provider_capacity_window_5h()
      : m.newtask_provider_capacity_window_week();
  }

  /** Full window name — used for the chip title + meter accessible text. */
  function windowFull(key: GaugeKey): string {
    return key === "5H" ? m.usage_limits_window_5h() : m.usage_limits_window_week();
  }

  function resetLabel(resetAt: number): string | null {
    return resetAt > nowMs ? formatReset(resetAt, nowMs, { withTime: true }) : null;
  }
</script>

<div class="pcap" aria-label={m.newtask_provider_capacity_aria()}>
  <div class="pcap-head">{m.newtask_provider_capacity_title()}</div>
  <div class="pcap-list">
    {#each rows as row (row.provider)}
      <div class="pcap-provider" class:stale={row.stale}>
        <span class="pcap-provider-label">{providerName(row.provider)}</span>
        {#if row.available}
          <div class="pcap-windows">
            {#each row.windows as win (win.key)}
              {@const reset = resetLabel(win.resetAt)}
              <div class="pcap-window">
                <span class="pcap-win-key" title={windowFull(win.key)}>{windowShort(win.key)}</span>
                <span
                  class="pcap-bar"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={win.remainingPct}
                  aria-valuetext={reset
                    ? m.newtask_provider_capacity_meter_window_aria_until({
                        provider: providerName(row.provider),
                        window: windowFull(win.key),
                        free: win.remainingPct,
                        time: reset,
                      })
                    : m.newtask_provider_capacity_meter_window_aria({
                        provider: providerName(row.provider),
                        window: windowFull(win.key),
                        free: win.remainingPct,
                      })}
                >
                  <span
                    class="pcap-fill"
                    style="width:{win.remainingPct}%;background:{gaugeColor(win.usedPct)}"
                  ></span>
                </span>
                <span class="pcap-value"
                  >{#if reset}{m.newtask_provider_capacity_free_until({
                      pct: win.remainingPct,
                      time: reset,
                    })}{:else}{m.newtask_provider_capacity_free({
                      pct: win.remainingPct,
                    })}{/if}</span
                >
              </div>
            {/each}
          </div>
        {:else}
          <span class="pcap-miss">{m.newtask_provider_capacity_unavailable()}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .pcap {
    container-type: inline-size;
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
    gap: 8px;
  }

  .pcap-provider {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .pcap-provider.stale {
    opacity: 0.55;
  }

  .pcap-provider-label {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    min-width: 0;
  }

  .pcap-windows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pcap-window {
    display: grid;
    grid-template-columns: minmax(3rem, 4rem) minmax(0, 1fr);
    grid-template-areas:
      "key bar"
      ". value";
    column-gap: 8px;
    row-gap: 3px;
    align-items: center;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }

  .pcap-win-key {
    grid-area: key;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    min-width: 0;
    white-space: nowrap;
  }

  .pcap-value,
  .pcap-miss {
    font-size: var(--fs-meta);
    min-width: 0;
  }

  .pcap-value {
    grid-area: value;
    color: var(--color-muted);
    white-space: nowrap;
  }

  .pcap-miss {
    color: var(--color-faint);
    white-space: nowrap;
  }

  .pcap-bar {
    grid-area: bar;
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

  @container (max-width: 16rem) {
    .pcap-window {
      grid-template-areas:
        "key"
        "bar"
        "value";
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
      align-items: start;
    }

    .pcap-value,
    .pcap-miss {
      white-space: normal;
    }
  }
</style>
