<script lang="ts">
  let {
    onnew,
    mode = "focus",
    onmode,
    mobile = false,
    desktopOnly = false,
  }: {
    onnew: () => void;
    mode?: "focus" | "all";
    onmode?: (m: "focus" | "all") => void;
    mobile?: boolean;
    desktopOnly?: boolean;
  } = $props();
</script>

{#if !(desktopOnly && mobile)}
  <div class="actions" class:mobile>
    <button class="btn primary" type="button" onclick={onnew}>+ New Task</button>
    {#if !mobile}
      <button
        class="btn"
        class:active={mode === "all"}
        type="button"
        onclick={() => onmode?.("all")}>All ▦</button
      >
      <button
        class="btn"
        class:active={mode === "focus"}
        type="button"
        onclick={() => onmode?.("focus")}>Focus ⌖</button
      >
      <span class="hint">node-pty ⇄ herdr · sub · skip-permissions</span>
    {/if}
  </div>
{/if}

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
  .btn.active {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: #0c1110;
  }
  .hint {
    margin-left: auto;
    color: var(--color-faint);
    font-size: 11px;
    letter-spacing: 0.1em;
  }
  .actions.mobile {
    padding: 10px;
  }
  .actions.mobile .btn.primary {
    flex: 1;
    text-align: center;
    padding: 12px;
    font-size: 12px;
  }
</style>
