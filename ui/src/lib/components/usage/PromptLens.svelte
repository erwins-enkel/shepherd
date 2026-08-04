<script lang="ts">
  // Spawn-prompt budget (issue #1999) — the INPUT-side counterpart to the Spend/Overhead lenses.
  // Those attribute what a session cost after the fact and cannot say which part of the assembled
  // prompt bought it; this shows the payload itself, block by block, as it was measured at spawn.
  import type { PromptBudgetRecord } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InfoTip from "$lib/components/InfoTip.svelte";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import UsageBar from "./UsageBar.svelte";
  import { formatPct } from "./format";

  const { records }: { records: PromptBudgetRecord[] } = $props();

  // Selected spawn, by session id. Null → the newest record (the list arrives newest-first), so the
  // lens shows something useful before any interaction. Keyed by id rather than index so a refresh
  // that prepends a new spawn doesn't silently move the selection to a different session.
  let selectedId = $state<string | null>(null);
  const selected = $derived(records.find((r) => r.sessionId === selectedId) ?? records[0] ?? null);

  /** Blocks largest-first — the ordering the epic's deletion slices actually shop from. */
  const blocks = $derived([...(selected?.blocks ?? [])].sort((a, b) => b.chars - a.chars));
  const maxChars = $derived(blocks.length > 0 ? blocks[0].chars : 1);

  /** Denominator for a block's share. The per-block chars, NOT `totalChars` — the total also counts
   *  the separators between blocks, so shares computed against it would never reach 100%. */
  const blockChars = $derived(blocks.reduce((s, b) => s + b.chars, 0));

  /** Locale-aware thousands separators; these numbers are read comparatively. */
  function formatCount(n: number): string {
    return n.toLocaleString();
  }

  function spawnKind(r: PromptBudgetRecord): string {
    return r.auto ? m.usage_prompt_kind_drain() : m.usage_prompt_kind_attended();
  }

  function deliveryLabel(r: PromptBudgetRecord): string {
    return r.delivery === "inline-prompt"
      ? m.usage_prompt_delivery_inline()
      : m.usage_prompt_delivery_append();
  }
</script>

<div class="prompt-lens">
  {#if records.length === 0}
    <p class="muted">{m.usage_prompt_empty()}</p>
  {:else if selected}
    <section class="panel prompt-section">
      <h2 class="section-heading">{m.usage_prompt_heading()}</h2>
      <p class="caption">
        <GlossaryText text={m.usage_prompt_caption()} />
      </p>

      <label class="picker">
        <span class="picker-label">{m.usage_prompt_picker_label()}</span>
        <!-- Value is DERIVED, not bound: `selectedId` starts null (meaning "the newest"), and a
             two-way bind would render that as a blank option instead of the record actually shown. -->
        <select value={selected.sessionId} onchange={(e) => (selectedId = e.currentTarget.value)}>
          {#each records as r (r.sessionId)}
            <option value={r.sessionId}>
              {r.desig} · {spawnKind(r)} · {r.agentProvider} · {formatCount(r.totalChars)}
              {m.usage_prompt_chars_unit()}
            </option>
          {/each}
        </select>
      </label>

      <div class="totals">
        <span class="total">
          <span class="total-value">{formatCount(selected.totalChars)}</span>
          <span class="total-unit">{m.usage_prompt_chars_unit()}</span>
        </span>
        <span class="total">
          <span class="total-value">{formatCount(selected.totalBytes)}</span>
          <span class="total-unit">{m.usage_prompt_bytes_unit()}</span>
        </span>
        <span class="total">
          <span class="total-value">≈{formatCount(selected.totalTokens)}</span>
          <span class="total-unit">{m.usage_prompt_tokens_unit()}</span>
          <InfoTip
            text={m.usage_prompt_tokens_estimate_tip()}
            label={m.newtask_info_aria({ topic: m.usage_prompt_tokens_unit() })}
          />
        </span>
        <span class="delivery">{deliveryLabel(selected)}</span>
      </div>
    </section>

    <section class="panel prompt-section">
      <h2 class="section-heading">
        {m.usage_prompt_blocks_heading({ count: blocks.length })}
      </h2>
      <div class="block-list">
        {#each blocks as b (b.name)}
          <div class="block-row">
            <span class="block-name" title={b.name}>{b.name}</span>
            <span class="block-bar">
              <UsageBar value={b.chars} max={maxChars} tone="var(--color-amber)" />
            </span>
            <span class="block-chars">{formatCount(b.chars)}</span>
            <span class="block-tokens">≈{formatCount(b.tokens)}</span>
            <span class="block-pct">{formatPct(blockChars > 0 ? b.chars / blockChars : 0)}</span>
          </div>
        {/each}
      </div>
      <p class="caption">{m.usage_prompt_blocks_caption()}</p>
    </section>
  {/if}
</div>

<style>
  .prompt-lens {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .prompt-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-heading {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color-ink-bright);
    margin: 0;
  }

  .caption {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    margin: 0;
  }

  .picker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .picker-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .picker select {
    flex: 1;
    min-width: 12rem;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 0.35rem 0.5rem;
    border-radius: 2px;
    /* a11y: 44px tap target on touch, per the design-system sizing floor. */
    min-height: 44px;
  }

  .picker select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .totals {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .total {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
  }

  .total-value {
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    font-variant-numeric: tabular-nums;
  }

  .total-unit {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .delivery {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 0.3rem;
  }

  .block-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .block-row {
    display: grid;
    grid-template-columns: minmax(8rem, 14rem) 1fr auto auto 2.5rem;
    align-items: center;
    gap: 0.5rem;
  }

  .block-name {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .block-chars,
  .block-tokens,
  .block-pct {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .block-chars {
    color: var(--color-ink-bright);
  }

  .block-tokens,
  .block-pct {
    color: var(--color-muted);
  }

  /* Narrow viewports: the bar is the first thing worth dropping — the numbers carry the meaning. */
  @media (max-width: 40rem) {
    .block-row {
      grid-template-columns: 1fr auto auto;
    }

    .block-bar {
      display: none;
    }
  }
</style>
