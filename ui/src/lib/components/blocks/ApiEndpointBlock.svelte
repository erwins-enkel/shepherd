<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InferredBadge from "./InferredBadge.svelte";
  import ApiParamRow from "./ApiParamRow.svelte";
  import ApiResponseRow from "./ApiResponseRow.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "api-endpoint" }> } = $props();

  const METHOD_COLOR: Record<string, string> = {
    GET: "var(--color-green)",
    POST: "var(--color-blue)",
    PUT: "var(--color-amber)",
    PATCH: "var(--color-amber)",
    DELETE: "var(--color-red)",
    HEAD: "var(--color-muted)",
    OPTIONS: "var(--color-muted)",
  };

  const methodColor = $derived(METHOD_COLOR[block.method.toUpperCase()] ?? "var(--color-muted)");
</script>

<div class="ae-block">
  <div class="ae-header">
    <div class="ae-route">
      <span class="ae-method" style:color={methodColor}>{block.method.toUpperCase()}</span>
      <code class="ae-path" class:ae-deprecated={block.deprecated}>{block.path}</code>
      {#if block.deprecated}
        <span class="ae-dep-label">{m.vblock_apiendpoint_deprecated()}</span>
      {/if}
    </div>
    {#if block.inferred}
      <InferredBadge />
    {/if}
  </div>

  {#if block.summary}
    <p class="ae-summary">{block.summary}</p>
  {/if}

  {#if block.params && block.params.length > 0}
    <div class="ae-section">
      <div class="ae-section-label">{m.vblock_apiendpoint_params()}</div>
      <table class="ae-table">
        <tbody>
          {#each block.params as param, i (i)}
            <ApiParamRow {param} />
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if block.responses && block.responses.length > 0}
    <div class="ae-section">
      <div class="ae-section-label">{m.vblock_apiendpoint_responses()}</div>
      <table class="ae-table">
        <tbody>
          {#each block.responses as resp, i (i)}
            <ApiResponseRow {resp} />
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .ae-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    padding: 8px 10px;
  }
  .ae-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ae-route {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ae-method {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-weight: 700;
    flex-shrink: 0;
  }
  .ae-path {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .ae-deprecated {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .ae-dep-label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .ae-summary {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .ae-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ae-section-label {
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }
  .ae-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  /* Row styles target child component markup via :global() */
  :global(.ae-row td) {
    padding: 2px 6px;
    vertical-align: top;
  }
  :global(.ae-row td:first-child) {
    padding-left: 0;
  }
  :global(.ae-row:not(:last-child) td) {
    border-bottom: 1px solid var(--color-line);
  }
  :global(.ae-param-name) {
    color: var(--color-ink);
    white-space: nowrap;
  }
  :global(.ae-param-in) {
    color: var(--color-muted);
    white-space: nowrap;
  }
  :global(.ae-param-type) {
    color: var(--color-muted);
    white-space: nowrap;
  }
  :global(.ae-param-note) {
    color: var(--color-muted);
    font-family: inherit;
  }
  :global(.ae-required) {
    display: inline-block;
    margin-left: 4px;
    font-size: var(--fs-micro);
    color: var(--color-red);
    font-family: inherit;
  }
  :global(.ae-resp-status) {
    color: var(--color-ink);
    white-space: nowrap;
  }
  :global(.ae-resp-desc) {
    color: var(--color-muted);
  }
  :global(.ae-resp-example) {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
</style>
