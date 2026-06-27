<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  let { type }: { type: string } = $props();
</script>

<div class="pui-unknown">
  <span class="pui-unknown-label">{m.plugin_ui_unknown_node()}</span>
  <code class="pui-unknown-type">{type}</code>
</div>

<style>
  .pui-unknown {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .pui-unknown-label {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pui-unknown-type {
    font-family: monospace;
    color: var(--color-ink);
  }
</style>
