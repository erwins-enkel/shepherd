<script lang="ts">
  let { onnew }: { onnew: () => void } = $props();
</script>

<div class="actions">
  <button class="btn primary" type="button" onclick={onnew}>+ New Task</button>
  <button class="btn" type="button">All ▦</button>
  <button class="btn" type="button">Focus ⌖</button>
  <span class="hint">node-pty ⇄ herdr · sub · skip-permissions</span>
</div>

<style>
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    padding: 10px 14px;
  }
  .btn {
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    padding: 7px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    background: transparent;
  }
  .btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .btn:hover {
    background: #0c1110;
  }
  .hint {
    margin-left: auto;
    color: var(--color-faint);
    font-size: 11px;
    letter-spacing: 0.1em;
  }
</style>
