<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const columns = $derived(Array.isArray(p.columns) ? (p.columns as unknown[]).map(String) : []);
  const rows = $derived(
    Array.isArray(p.rows)
      ? (p.rows as unknown[]).map((r) => (Array.isArray(r) ? (r as unknown[]).map(String) : []))
      : [],
  );
</script>

{#if columns.length === 0 && rows.length === 0}
  <p class="pui-table-empty">{m.plugin_ui_table_empty()}</p>
{:else}
  <div class="pui-table-wrapper">
    <table class="pui-table">
      {#if columns.length > 0}
        <thead>
          <tr>
            {#each columns as col, i (i)}
              <th class="pui-th">{col}</th>
            {/each}
          </tr>
        </thead>
      {/if}
      <tbody>
        {#each rows as row, ri (ri)}
          <tr>
            {#each row as cell, ci (ci)}
              <td class="pui-td">{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .pui-table-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .pui-table-wrapper {
    overflow-x: auto;
  }
  .pui-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .pui-th {
    padding: 4px 10px;
    text-align: left;
    font-weight: 600;
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
    border-bottom: 2px solid var(--color-line);
    white-space: nowrap;
  }
  .pui-td {
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-line);
    vertical-align: top;
  }
  tbody tr:last-child .pui-td {
    border-bottom: none;
  }
</style>
