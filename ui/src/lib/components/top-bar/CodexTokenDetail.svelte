<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatTokenLabel, formatResetIn, formatReset } from "$lib/format";
  import type { UsageProviderSnapshot } from "$lib/types";
  import { gaugeColor, codexGaugeList, type GaugeKey } from "../usage-gauges";

  let {
    usage,
    nowMs,
    periodLabel,
  }: {
    usage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }>;
    nowMs: number;
    periodLabel: (k: GaugeKey) => string;
  } = $props();

  // The 5h/weekly rate-limit windows Codex reports — rendered as Claude-style gauges so the two
  // CLIs read side by side. Empty when Codex hasn't logged a rate-limit event yet (then we show
  // only the raw token counts below).
  const windows = $derived(codexGaugeList(usage));
</script>

<div class="gp-head">
  <span class="gp-period">{m.agent_provider_codex()}</span>
</div>
{#each windows as g (g.label)}
  <div class="codex-gauge">
    <div class="codex-gauge-head">
      <span class="gp-period">{periodLabel(g.label)}</span>
      <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
    </div>
    <span class="g-bar"
      ><span
        class="g-fill"
        style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) / 100});background:{gaugeColor(
          g.w.pct,
        )}"
      ></span></span
    >
    <div class="micro">
      {m.topbar_gauge_reset_rel({
        rel: formatResetIn(g.w.resetAt, nowMs),
        abs: formatReset(g.w.resetAt, nowMs),
      })}
    </div>
  </div>
{/each}
<div class="token-row">
  <span>{m.topbar_tokens_window({ period: "5H" })}</span>
  <span>{formatTokenLabel(usage.session5hTokens)}</span>
</div>
<div class="token-row">
  <span>{m.topbar_tokens_window({ period: "WK" })}</span>
  <span>{formatTokenLabel(usage.weekTokens)}</span>
</div>
<div class="token-row">
  <span>{m.topbar_tokens_total()}</span>
  <span>{formatTokenLabel(usage.totalTokens)}</span>
</div>

<style>
  .gp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .gp-period {
    color: var(--color-text);
    font-size: var(--fs-meta);
    text-transform: capitalize;
  }
  .codex-gauge {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 0 6px;
  }
  .codex-gauge-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .g-bar {
    width: 100%;
    height: 6px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .g-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
    transition: transform 0.6s ease;
  }
  .g-pct {
    font-size: var(--fs-meta);
    min-width: 30px;
    text-align: right;
  }
  .token-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  .token-row span:first-child {
    color: var(--color-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
