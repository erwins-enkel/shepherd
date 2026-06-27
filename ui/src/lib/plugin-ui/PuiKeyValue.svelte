<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const pairs = $derived(
    Array.isArray(p.pairs)
      ? (p.pairs as unknown[]).map((item) => {
          const entry =
            item != null && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return { key: String(entry.key ?? ""), value: String(entry.value ?? "") };
        })
      : [],
  );
</script>

{#if pairs.length === 0}
  <p class="pui-kv-empty">{m.plugin_ui_kv_empty()}</p>
{:else}
  <dl class="pui-kv">
    {#each pairs as pair, i (i)}
      <dt class="pui-kv-key">{pair.key}</dt>
      <dd class="pui-kv-value">{pair.value}</dd>
    {/each}
  </dl>
{/if}

<style>
  .pui-kv-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .pui-kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 16px;
    row-gap: 4px;
    margin: 0;
    font-size: var(--fs-meta);
  }
  .pui-kv-key {
    font-weight: 600;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
    align-self: baseline;
  }
  .pui-kv-value {
    color: var(--color-ink);
    margin: 0;
    align-self: baseline;
    word-break: break-word;
  }
</style>
