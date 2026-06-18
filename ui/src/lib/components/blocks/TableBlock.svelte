<script lang="ts">
  import type { VisualBlock } from "$lib/types";

  let { block }: { block: Extract<VisualBlock, { type: "table" }> } = $props();
</script>

<div class="tb-wrapper">
  <table class="tb-table">
    <thead>
      <tr>
        {#each block.columns as col, i (i)}
          <th class="tb-th">{col}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each block.rows as row, ri (ri)}
        <tr>
          {#each row as cell, ci (ci)}
            <td class="tb-td">{cell}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .tb-wrapper {
    overflow-x: auto;
  }
  .tb-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .tb-th {
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
  .tb-td {
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-line);
    vertical-align: top;
  }
  tbody tr:last-child .tb-td {
    border-bottom: none;
  }
</style>
