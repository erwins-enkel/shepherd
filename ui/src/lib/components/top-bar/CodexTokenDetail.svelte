<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatTokenLabel } from "$lib/format";
  import type { UsageProviderSnapshot } from "$lib/types";
  import { codexGaugeList, type GaugeKey } from "../usage-gauges";
  import LimitGaugeRow from "./LimitGaugeRow.svelte";

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
  // CLIs read side by side. Empty when Shepherd cannot find a rate-limit event in Codex rollouts.
  const windows = $derived(codexGaugeList(usage));
</script>

<!-- Section heading ("Codex usage") is rendered by the parent popover; this is the body. -->
{#each windows as g (g.label)}
  <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
{/each}
{#if windows.length === 0}
  <div class="limits-unavailable micro">{m.topbar_codex_limits_unavailable()}</div>
{/if}
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
  .limits-unavailable {
    margin: 4px 0 6px;
    padding: 6px 0;
    border-top: 1px solid var(--color-line);
    border-bottom: 1px solid var(--color-line);
    color: var(--color-faint);
    letter-spacing: 0.08em;
    line-height: 1.35;
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
