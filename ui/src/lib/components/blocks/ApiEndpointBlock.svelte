<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InferredBadge from "./InferredBadge.svelte";

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
            <tr class="ae-row">
              <td class="ae-param-name">
                {param.name}
                {#if param.required}<span class="ae-required"
                    >{m.vblock_apiendpoint_required()}</span
                  >{/if}
              </td>
              <td class="ae-param-in">{param.in}</td>
              <td class="ae-param-type">{param.type}</td>
              {#if param.note}
                <td class="ae-param-note">{param.note}</td>
              {:else}
                <td></td>
              {/if}
            </tr>
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
            <tr class="ae-row">
              <td class="ae-resp-status">{resp.status}</td>
              {#if resp.description}
                <td class="ae-resp-desc">{resp.description}</td>
              {:else}
                <td></td>
              {/if}
              {#if resp.example}
                <td class="ae-resp-example"><code>{resp.example}</code></td>
              {:else}
                <td></td>
              {/if}
            </tr>
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
  .ae-row td {
    padding: 2px 6px;
    vertical-align: top;
  }
  .ae-row td:first-child {
    padding-left: 0;
  }
  .ae-row:not(:last-child) td {
    border-bottom: 1px solid var(--color-line);
  }
  .ae-param-name {
    color: var(--color-ink);
    white-space: nowrap;
  }
  .ae-param-in {
    color: var(--color-muted);
    white-space: nowrap;
  }
  .ae-param-type {
    color: var(--color-muted);
    white-space: nowrap;
  }
  .ae-param-note {
    color: var(--color-muted);
    font-family: inherit;
  }
  .ae-required {
    display: inline-block;
    margin-left: 4px;
    font-size: var(--fs-micro);
    color: var(--color-red);
    font-family: var(--font-sans, inherit);
  }
  .ae-resp-status {
    color: var(--color-ink);
    white-space: nowrap;
  }
  .ae-resp-desc {
    color: var(--color-muted);
  }
  .ae-resp-example {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
</style>
