<script lang="ts">
  import { dialog } from "#lib/a11yDialog.js";
  import type { DependabotCommand } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { dependabotConfirmBody, dependabotConfirmTitle } from "./up-next-pr-copy";

  // Recreate overwrites a PR's edits; an ignore closes the PR and stops future updates. Each states
  // that here before its comment goes out.
  let {
    number,
    command,
    dependency,
    onconfirm,
    onclose,
  }: {
    number: number;
    command: DependabotCommand;
    dependency?: string;
    onconfirm: () => void;
    onclose: () => void;
  } = $props();

  const title = $derived(dependabotConfirmTitle(number, command, dependency));
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div class="card" role="dialog" aria-modal="true" aria-label={title} use:dialog={{ onclose }}>
    <h2>{title}</h2>
    <p>{dependabotConfirmBody(number, command, dependency)}</p>
    <div class="actions">
      <button type="button" class="ghost" onclick={onclose}>{m.common_cancel()}</button>
      <button type="button" class="run" onclick={onconfirm}>
        {command === "recreate" ? m.depcmd_confirm_recreate() : m.depcmd_confirm_ignore()}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-scrim);
  }
  .card {
    width: min(460px, 92vw);
    padding: 18px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
  }
  h2 {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 700;
  }
  p {
    margin: 10px 0 16px;
    overflow-wrap: anywhere;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ghost,
  .run {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  /* Amber, like the merge confirmation: consequential, not destructive. */
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  @media (max-width: 768px), (pointer: coarse) {
    .ghost,
    .run {
      min-height: 44px;
    }
  }
</style>
