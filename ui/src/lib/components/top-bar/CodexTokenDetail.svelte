<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatTokenLabel, relativeAge } from "$lib/format";
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
  const tokenAge = $derived(usage.updatedAt === null ? null : relativeAge(usage.updatedAt, nowMs));
  const limitAge = $derived(
    windows.length > 0 &&
      usage.rateLimitLatestEventAt != null &&
      usage.rateLimitLatestEventAt !== usage.updatedAt
      ? relativeAge(usage.rateLimitLatestEventAt, nowMs)
      : null,
  );
</script>

<!-- Section heading ("Codex usage") is rendered by the parent popover; this is the body. -->
{#if tokenAge !== null}
  <div class="snapshot-age">
    {tokenAge === "now"
      ? m.topbar_codex_tokens_checked_now()
      : m.topbar_codex_tokens_checked_age({ age: tokenAge })}
  </div>
{/if}
{#if limitAge !== null}
  <div class="snapshot-age limits-age">
    {limitAge === "now"
      ? m.topbar_codex_limits_checked_now()
      : m.topbar_codex_limits_checked_age({ age: limitAge })}
  </div>
{/if}
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
  .snapshot-age {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    margin-bottom: 6px;
  }
  .limits-age {
    color: var(--color-faint);
  }
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
