<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  let {
    repairing,
    onrepair,
  }: {
    repairing: boolean;
    onrepair: () => void;
  } = $props();
</script>

<div class="nt-base-repair" role="alert">
  <span>{m.newtask_base_missing()}</span>
  <button type="button" disabled={repairing} onclick={onrepair}>
    {repairing ? m.newtask_init_commit_running() : m.newtask_init_commit()}
  </button>
</div>

<style>
  .nt-base-repair {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    color: var(--color-red);
    font-size: var(--fs-meta);
  }

  button {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: var(--color-amber);
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
