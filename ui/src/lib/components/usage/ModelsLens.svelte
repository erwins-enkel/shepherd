<script lang="ts">
  import type { UsageBreakdown, UsageModelBreakdown } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatTokenLabel } from "$lib/format";
  import { modelDisplayName } from "$lib/components/usage-gauges";

  let { models }: { models: UsageBreakdown["models"] } = $props();

  const TONES = [
    "var(--color-data-1)",
    "var(--color-data-2)",
    "var(--color-data-3)",
    "var(--color-data-4)",
    "var(--color-data-5)",
    "var(--color-data-6)",
    "var(--color-data-7)",
  ] as const;

  interface ModelRow {
    id: string;
    label: string;
    tokens: number;
    exactPct: number;
    displayPct: number;
    tone: string;
  }

  function rowsFor(data: UsageModelBreakdown): ModelRow[] {
    const sorted = Object.entries(data.byModel)
      .filter(([, tokens]) => tokens > 0)
      .sort(
        ([aModel, aTokens], [bModel, bTokens]) =>
          bTokens - aTokens || (aModel < bModel ? -1 : aModel > bModel ? 1 : 0),
      );
    const visible = sorted.slice(0, 6).map(([id, tokens]) => ({ id, tokens }));
    if (sorted.length > 6) {
      visible.push({
        id: "__other__",
        tokens: sorted.slice(6).reduce((sum, [, tokens]) => sum + tokens, 0),
      });
    }
    const total = visible.reduce((sum, row) => sum + row.tokens, 0);
    if (total === 0) return [];

    const quotas = visible.map((row) => (row.tokens / total) * 1000);
    const tenths = quotas.map(Math.floor);
    let remainder = 1000 - tenths.reduce((sum, value) => sum + value, 0);
    const remainderOrder = quotas
      .map((quota, index) => ({ index, fraction: quota - Math.floor(quota) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let i = 0; i < remainder; i++) tenths[remainderOrder[i]!.index] += 1;

    return visible.map((row, index) => ({
      ...row,
      label: row.id === "__other__" ? m.usage_models_other() : modelDisplayName(row.id),
      exactPct: (row.tokens / total) * 100,
      displayPct: tenths[index]! / 10,
      tone: TONES[index]!,
    }));
  }

  const providers = $derived([
    { id: "claude", label: m.agent_provider_claude(), data: models.claude },
    { id: "codex", label: m.agent_provider_codex(), data: models.codex },
  ] as const);
</script>

<div class="models-lens">
  {#each providers as provider (provider.id)}
    {@const rows = rowsFor(provider.data)}
    <section class="provider-block" data-provider={provider.id}>
      <header class="provider-head">
        <h2>{provider.label}</h2>
        <span>{m.usage_models_total({ tokens: formatTokenLabel(provider.data.totalTokens) })}</span>
      </header>

      {#if rows.length > 0}
        <div
          class="stacked-bar"
          role="img"
          aria-label={m.usage_models_bar_aria({
            provider: provider.label,
            tokens: formatTokenLabel(provider.data.totalTokens),
          })}
        >
          {#each rows as row (row.id)}
            <span
              aria-hidden="true"
              style:width={`${row.exactPct}%`}
              style:background={row.tone}
            ></span>
          {/each}
        </div>

        <ul class="model-list">
          {#each rows as row (row.id)}
            <li>
              <span class="swatch" aria-hidden="true" style:background={row.tone}></span>
              <span class="model-name">{row.label}</span>
              <span class="model-pct">{row.displayPct.toFixed(1)}%</span>
              <span class="model-tokens">{formatTokenLabel(row.tokens)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">{m.usage_models_empty()}</p>
      {/if}
    </section>
  {/each}
</div>

<style>
  .models-lens {
    display: flex;
    flex-direction: column;
  }

  .provider-block {
    padding-block: 18px;
  }

  .provider-block + .provider-block {
    border-top: 1px solid var(--color-line);
  }

  .provider-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .provider-head h2 {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .provider-head span {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }

  .stacked-bar {
    display: flex;
    width: 100%;
    height: 12px;
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
  }

  .stacked-bar > span {
    min-width: 1px;
    height: 100%;
    border-right: 1px solid var(--color-panel);
  }

  .stacked-bar > span:last-child {
    border-right: 0;
  }

  .model-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
    margin: 10px 0 0;
    list-style: none;
  }

  .model-list li {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) 4.5rem 7rem;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    color: var(--color-ink);
    font-size: var(--fs-base);
  }

  .swatch {
    width: 8px;
    height: 8px;
  }

  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-pct,
  .model-tokens {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .model-pct {
    color: var(--color-ink-bright);
  }

  .model-tokens {
    color: var(--color-muted);
  }

  .empty {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }

  @media (max-width: 520px) {
    .model-list li {
      grid-template-columns: 10px minmax(0, 1fr) 3.75rem 5.75rem;
      gap: 6px;
    }
  }
</style>
