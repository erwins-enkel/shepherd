<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { ActionsAccountBilling } from "#lib/types.js";
  import { TONE_COLOR, actionsBar, usd, type ActionsTone } from "./github-actions";

  // One account's bar up to its stop — spend inside the included amount, spend past it in the
  // tone's color, the forecast to month end, the stopping budget hatched — and the line under it
  // that says the same in dollars.
  let { account: a, tone }: { account: ActionsAccountBilling; tone: ActionsTone } = $props();

  const bar = $derived(actionsBar(a));
  const spentTo = $derived(bar.over?.to ?? bar.usedPct);
  const hot = $derived(tone === "warn" || tone === "stopped");

  const left = $derived.by(() => {
    const inc = a.includedUsd;
    if (inc === null) return m.topbar_gha_used_no_plan({ used: usd(a.usedUsd) });
    return a.usedUsd < inc
      ? m.topbar_gha_used_of_included({ used: usd(a.usedUsd), included: usd(inc) })
      : m.topbar_gha_included_spent({ included: usd(inc) });
  });

  const right = $derived.by(() => {
    const inc = a.includedUsd;
    const budget = a.budget?.amountUsd ?? 0;
    if (a.stopAtUsd === null || inc === null) {
      return a.paidUsd > 0 ? m.topbar_gha_paid_no_stop({ paid: usd(a.paidUsd) }) : "";
    }
    if (a.usedUsd < inc) {
      return budget > 0
        ? m.topbar_gha_then_budget_stop({ budget: usd(budget) })
        : m.topbar_gha_then_stop();
    }
    return budget > 0
      ? m.topbar_gha_budget_of({ spent: usd(a.usedUsd - inc), budget: usd(budget) })
      : "";
  });
</script>

<div class="meter">
  <span class="track" aria-hidden="true">
    <span class="bar">
      {#if bar.budgetFromPct !== null}
        <span class="zone-budget" style="left:{bar.budgetFromPct}%"></span>
      {/if}
      {#if bar.forecastToPct > spentTo}
        <span
          class="forecast"
          class:hot={tone === "warn"}
          style="left:{spentTo}%;width:{bar.forecastToPct - spentTo}%"
        ></span>
      {/if}
      <span class="fill" style="width:{bar.usedPct}%"></span>
      {#if bar.over}
        <span
          class="fill"
          style="left:{bar.over.from}%;width:{bar.over.to - bar.over.from}%;background:{TONE_COLOR[
            tone
          ]}"
        ></span>
      {/if}
    </span>
    {#if bar.includedTickPct !== null}
      <span class="tick" style="left:{bar.includedTickPct}%"></span>
    {/if}
    {#if bar.stop}
      <span class="stopcap" style="background:{hot ? TONE_COLOR[tone] : 'var(--color-ink-bright)'}"
      ></span>
    {/if}
  </span>
  <div class="sub"><span>{left}</span><span>{right}</span></div>
</div>

<style>
  .meter {
    min-width: 0;
    padding-top: 2px;
  }
  .track {
    position: relative;
    display: block;
  }
  .bar {
    position: relative;
    display: block;
    height: 9px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .bar > span {
    position: absolute;
    top: 0;
    bottom: 0;
  }
  .fill {
    left: 0;
    background: var(--color-ink);
  }
  .zone-budget {
    right: 0;
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-muted) 45%, transparent) 0 1px,
      transparent 1px 4px
    );
  }
  .forecast {
    background: repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-ink) 50%, transparent) 0 2px,
      transparent 2px 4px
    );
  }
  .forecast.hot {
    background: repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-warn) 75%, transparent) 0 2px,
      transparent 2px 4px
    );
  }
  .tick,
  .stopcap {
    position: absolute;
    top: -4px;
    bottom: -4px;
  }
  .tick {
    width: 1px;
    margin-left: -0.5px;
    background: var(--color-muted);
  }
  .stopcap {
    right: -1px;
    width: 2px;
  }
  .sub {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
</style>
