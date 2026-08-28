<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { prMergeAvailable } from "$lib/components/pr-badge";
  import { m } from "$lib/paraglide/messages";
  import type { GitState } from "$lib/types";

  let {
    name,
    git,
    onselect,
    onclose,
  }: {
    name: string;
    git: GitState;
    onselect: (choice: "keep" | "close" | "merge") => void;
    onclose: () => void;
  } = $props();

  const title = $derived(m.decommission_pr_title({ number: git.number ?? "?" }));
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div class="card" role="dialog" aria-modal="true" aria-label={title} use:dialog={{ onclose }}>
    <div class="header">
      <span class="eyebrow">{title}</span>
    </div>

    <p>{m.decommission_pr_desc({ name })}</p>

    <div class="actions">
      <button type="button" class="action primary" onclick={() => onselect("keep")}>
        {m.decommission_pr_keep()}
      </button>
      {#if prMergeAvailable(git)}
        <button type="button" class="action" onclick={() => onselect("merge")}>
          {m.decommission_pr_merge()}
        </button>
      {/if}
      <button type="button" class="action danger" onclick={() => onselect("close")}>
        {m.decommission_pr_close()}
      </button>
      <button type="button" class="action cancel" onclick={onclose}>{m.common_cancel()}</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-scrim);
  }
  .card {
    width: min(480px, 92vw);
    padding: 18px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
  }
  .header {
    display: flex;
    align-items: center;
  }
  .eyebrow {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  p {
    margin: 12px 0 16px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .action {
    min-height: 42px;
    padding: 8px 12px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-align: left;
    text-transform: uppercase;
    cursor: pointer;
  }
  .action:hover,
  .action:focus-visible,
  .action.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .action:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .action.danger {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .action.cancel {
    border-color: transparent;
    color: var(--color-muted);
    text-align: center;
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      min-height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
    .action {
      min-height: 44px;
    }
  }
</style>
