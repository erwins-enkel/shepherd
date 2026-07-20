<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import {
    gaugeColor,
    providerCapacityRows,
    selectedProviderCapacity,
  } from "$lib/components/usage-gauges";
  import { formatReset } from "$lib/format";
  import type { AgentProvider, UsageLimits } from "$lib/types";

  // Compact capacity line for the selected engine: `CX·WK [gauge] 92% free  all ▾`.
  // Window selection (hottest = lowest remaining) and the stale flag come from
  // selectedProviderCapacity; this component only renders. The "all ▾" popover lists
  // every provider window straight from providerCapacityRows — an anchored,
  // non-blocking popover (no scrim; outside-click/Esc dismiss), per the design system.
  let {
    limits = null,
    provider,
  }: {
    limits?: UsageLimits | null;
    provider: AgentProvider;
  } = $props();

  const cap = $derived(selectedProviderCapacity(limits, provider));
  const rows = $derived(providerCapacityRows(limits));
  let allOpen = $state(false);
  let root = $state<HTMLElement | null>(null);
  const nowMs = $derived(Date.now());

  function providerName(p: AgentProvider): string {
    return p === "claude" ? m.agent_provider_claude() : m.agent_provider_codex();
  }

  function code(p: AgentProvider, key: string): string {
    return `${p === "claude" ? "CC" : "CX"}·${key}`;
  }

  function resetLabel(resetAt: number): string | null {
    return resetAt > nowMs ? formatReset(resetAt, nowMs, { withTime: true }) : null;
  }

  // Outside-click + Escape dismiss for the popover (anchored non-blocking).
  $effect(() => {
    if (!allOpen) return;
    const n = root;
    if (!n) return;
    function onPointerDown(e: PointerEvent) {
      if (!n!.contains(e.target as Node)) allOpen = false;
    }
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        allOpen = false;
      }
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeydown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeydown, true);
    };
  });
</script>

{#if cap}
  <div class="capline-wrap" bind:this={root}>
    <div class="capline" class:stale={cap.stale}>
      <span class="cap-code">{cap.code}</span>
      <span
        class="cap-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={cap.freePct}
        aria-valuetext={m.newtask_capacity_meter_aria({
          provider: providerName(provider),
          free: cap.freePct,
        })}
      >
        <span class="cap-fill" style="width:{cap.freePct}%;background:{gaugeColor(cap.usedPct)}"
        ></span>
      </span>
      <span class="cap-free">{m.newtask_provider_capacity_free({ pct: cap.freePct })}</span>
      <button
        type="button"
        class="cap-all"
        aria-expanded={allOpen}
        onclick={() => (allOpen = !allOpen)}
      >
        {m.newtask_capacity_all()}
        <span aria-hidden="true">▾</span>
      </button>
    </div>
    {#if allOpen}
      <div class="cap-pop" role="dialog" aria-label={m.newtask_capacity_all_aria()}>
        {#each rows as row (row.provider)}
          <div class="cap-pop-provider" class:stale={row.stale}>
            {#if row.available}
              {#each row.windows as win (win.key)}
                {@const reset = resetLabel(win.resetAt)}
                <div class="cap-pop-row">
                  <span class="cap-code">{code(row.provider, win.key)}</span>
                  <span class="cap-bar">
                    <span
                      class="cap-fill"
                      style="width:{win.remainingPct}%;background:{gaugeColor(win.usedPct)}"
                    ></span>
                  </span>
                  <span class="cap-free">
                    {#if reset}{m.newtask_provider_capacity_free_until({
                        pct: win.remainingPct,
                        time: reset,
                      })}{:else}{m.newtask_provider_capacity_free({ pct: win.remainingPct })}{/if}
                  </span>
                </div>
              {/each}
            {:else}
              <div class="cap-pop-row">
                <span class="cap-code">{code(row.provider, "—")}</span>
                <span class="cap-miss">{m.newtask_provider_capacity_unavailable()}</span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .capline-wrap {
    position: relative;
    min-width: 0;
  }
  .capline {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .capline.stale {
    opacity: 0.55;
  }
  .cap-code {
    flex-shrink: 0;
    letter-spacing: 0.08em;
  }
  .cap-bar {
    flex: 1;
    min-width: 0;
    height: 4px;
    box-sizing: border-box;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .cap-fill {
    display: block;
    height: 100%;
  }
  .cap-free {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .cap-all {
    flex-shrink: 0;
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--color-faint);
    cursor: pointer;
  }
  .cap-all:hover {
    color: var(--color-ink);
  }
  .cap-all:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .cap-pop {
    position: absolute;
    z-index: 40;
    top: calc(100% + 4px);
    right: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
  }
  .cap-pop-provider {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cap-pop-provider.stale {
    opacity: 0.55;
  }
  .cap-pop-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .cap-pop-row .cap-code {
    min-width: 5ch;
  }
  .cap-miss {
    color: var(--color-faint);
  }
</style>
