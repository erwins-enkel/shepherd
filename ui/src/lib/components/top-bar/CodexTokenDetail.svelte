<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatTokenLabel } from "$lib/format";
  import type { UsageProviderSnapshot } from "$lib/types";

  let {
    usage,
  }: {
    usage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }>;
  } = $props();
</script>

<div class="gp-head">
  <span class="gp-period">{m.agent_provider_codex()}</span>
</div>
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
</style>
